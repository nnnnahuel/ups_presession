import express from "express";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getRecentLogs, initPlaylistTables } from "./playlist/state.mjs";
import { runPlaylistRotation } from "./playlist/rotate.mjs";
import { SpotifyClient } from "./playlist/spotify.mjs";
import cron from "node-cron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const screenDir = path.join(__dirname, "public", "screen");
const port = Number(process.env.PORT || 3000);
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "9oPKasc15pfAbMr7N6Gs";
const ELEVEN_STABILITY = Number(process.env.ELEVEN_STABILITY ?? 0.45);
const ELEVEN_SIMILARITY = Number(process.env.ELEVEN_SIMILARITY ?? 0.9);
const ELEVEN_STYLE = Number(process.env.ELEVEN_STYLE ?? 0.3);
const ELEVEN_SPEAKER_BOOST =
  String(process.env.ELEVEN_SPEAKER_BOOST ?? "false").toLowerCase() !== "false";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const PLAYLIST_API_TOKEN = process.env.PLAYLIST_API_TOKEN || "";
const LEGACY_DEVICE_ID = process.env.LEGACY_DEVICE_ID || "legacy-screen-worker";
const LEGACY_LOCATION_ID = process.env.LEGACY_LOCATION_ID || "legacy";
const COMMAND_BATCH_LIMIT = 50;
const WORKER_OFFLINE_INTERVAL_MS = 10000;
const WORKER_OFFLINE_SECONDS = 15;

const hasDatabase = Boolean(process.env.DATABASE_URL);
const hasSpotify = Boolean(
  process.env.SPOTIFY_CLIENT_ID &&
  process.env.SPOTIFY_CLIENT_SECRET &&
  process.env.SPOTIFY_REFRESH_TOKEN
);

let _spotifyClient = null;
let _gymSpotifyClient = null;

const hasGymSpotify = Boolean(
  process.env.SPOTIFY_CLIENT_ID &&
  process.env.SPOTIFY_CLIENT_SECRET &&
  process.env.SPOTIFY_GYM_REFRESH_TOKEN
);

const checkinClients = new Set();
const ttsCache = new Map();
const startState = { value: "", consumedAt: null };
const TZ = "America/Argentina/Buenos_Aires";

const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? {
              rejectUnauthorized: false,
            }
          : false,
    })
  : null;

function broadcastCheckin(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of checkinClients) {
    try {
      res.write(payload);
    } catch (_) {}
  }
}

async function withSpotify(fn) {
  if (!hasSpotify) throw new Error("spotify_not_configured");
  if (!_spotifyClient) {
    _spotifyClient = new SpotifyClient({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    });
  }
  if (!_spotifyClient.accessToken) {
    await _spotifyClient.authenticate();
  }
  try {
    return await fn(_spotifyClient);
  } catch (err) {
    if (String(err.message).includes("401")) {
      _spotifyClient.accessToken = null;
      await _spotifyClient.authenticate();
      return fn(_spotifyClient);
    }
    throw err;
  }
}

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      device_id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'online'
        CHECK (status IN ('online', 'offline')),
      last_known_volume INTEGER NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS commands (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT 'null'::jsonb,
      target_device_id TEXT NULL,
      target_location_id TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      executed_at TIMESTAMPTZ NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'ack', 'error'))
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS command_deliveries (
      id SERIAL PRIMARY KEY,
      command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES workers(device_id) ON DELETE CASCADE,
      delivered_at TIMESTAMPTZ NULL,
      acked_at TIMESTAMPTZ NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'ack', 'error')),
      UNIQUE (command_id, device_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_command_deliveries_device_id
      ON command_deliveries (device_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_commands_created_at
      ON commands (created_at)
  `);

  await initPlaylistTables(pool);
}

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.text());

function requireWorkerAuth(req, res, next) {
  if (!WORKER_TOKEN) {
    next();
    return;
  }

  const authorization = req.headers.authorization;
  const bearer =
    typeof authorization === "string"
      ? authorization.replace(/^Bearer\s+/i, "").trim()
      : "";
  const headerToken = req.headers["x-worker-token"];
  const token = bearer || headerToken;

  if (token !== WORKER_TOKEN) {
    res.status(401).json({ error: "unauthorized_worker" });
    return;
  }

  next();
}

function requirePlaylistAuth(req, res, next) {
  if (!PLAYLIST_API_TOKEN) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "playlist_token_not_configured" });
      return;
    }

    next();
    return;
  }

  const authorization = req.headers.authorization;
  const bearer =
    typeof authorization === "string"
      ? authorization.replace(/^Bearer\s+/i, "").trim()
      : "";
  const headerToken = req.headers["x-playlist-token"];
  const token = bearer || headerToken;

  if (token !== PLAYLIST_API_TOKEN) {
    res.status(401).json({ error: "unauthorized_playlist" });
    return;
  }

  next();
}

function requireDatabase(res) {
  if (pool) {
    return true;
  }

  res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
  return false;
}

function clampPct(value, fallback = 50) {
  const pct = Number.parseInt(value, 10);
  if (Number.isNaN(pct)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, pct));
}

function normalizeNullablePct(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampPct(parsed, 0) : null;
}

function parseOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return false;
}

function parseAckStatus(value) {
  return String(value || "").toLowerCase() === "error" ? "error" : "ack";
}

function toJsonPayload(value) {
  return JSON.stringify(value ?? null);
}

function resolveCommandTarget(req) {
  const device_id = parseOptionalString(req.params.device_id ?? req.query.device_id ?? req.body?.device_id);
  const location_id = parseOptionalString(
    req.params.location_id ?? req.query.location_id ?? req.body?.location_id
  );

  return {
    device_id,
    location_id,
    all: parseBoolean(req.query.all ?? req.body?.all) || (!device_id && !location_id),
  };
}

function resolveWorkerIdentity(req, { allowLegacyDefaults = false } = {}) {
  const device_id = parseOptionalString(req.body?.device_id ?? req.query.device_id);
  const location_id = parseOptionalString(req.body?.location_id ?? req.query.location_id);

  return {
    device_id: device_id || (allowLegacyDefaults ? LEGACY_DEVICE_ID : null),
    location_id: location_id || (allowLegacyDefaults ? LEGACY_LOCATION_ID : null),
  };
}

function mapWorkerRow(row) {
  return {
    device_id: row.device_id,
    location_id: row.location_id,
    last_seen_at: row.lastSeenAt,
    status: row.status,
    last_known_volume: row.lastKnownVolume,
  };
}

function mapCommandRow(row) {
  return {
    id: row.id,
    type: row.type,
    value: row.payload,
    createdAt: row.createdAt,
  };
}

function mapLegacyCommandRow(row) {
  switch (row.type) {
    case "volume":
      return {
        id: row.id,
        type: "setVolume",
        payload: {
          pct: clampPct(row.payload, 50),
        },
      };
    case "volume_ramp": {
      if (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)) {
        const targetPct = clampPct(row.payload.targetPct ?? row.payload.pct ?? row.payload.value, 50);
        const duration = Math.max(100, Number(row.payload.duration) || 1200);
        const fromValue = Number(row.payload.from);

        return {
          id: row.id,
          type: "rampVolume",
          payload: {
            targetPct,
            duration,
            from: Number.isFinite(fromValue) ? clampPct(fromValue, targetPct) : null,
          },
        };
      }

      return {
        id: row.id,
        type: "rampVolume",
        payload: {
          targetPct: clampPct(row.payload, 50),
          duration: 1200,
          from: null,
        },
      };
    }
    case "mute":
    case "unmute":
      return {
        id: row.id,
        type: row.type,
        payload: {},
      };
    default:
      return {
        id: row.id,
        type: row.type,
        payload: row.payload ?? {},
      };
  }
}

function runDetached(label, promise) {
  promise.catch((error) => {
    console.error(`${label} failed:`, error);
  });
}

async function listWorkers(clientOrPool = pool) {
  const result = await clientOrPool.query(`
    SELECT
      device_id,
      location_id,
      last_seen_at AS "lastSeenAt",
      status,
      last_known_volume AS "lastKnownVolume"
    FROM workers
    ORDER BY device_id ASC
  `);

  return result.rows.map(mapWorkerRow);
}

async function getVolumeSystemSnapshot(clientOrPool = pool) {
  const workers = await listWorkers(clientOrPool);
  const ackResult = await clientOrPool.query(`
    SELECT COALESCE(MAX(command_id), 0) AS "lastAckedCommandId"
    FROM command_deliveries
    WHERE status = 'ack'
  `);
  const lastCommandResult = await clientOrPool.query(`
    SELECT COALESCE(MAX(id), 0) AS "lastCommandId"
    FROM commands
  `);

  const activeWorkers = workers.filter((worker) => worker.status === "online");
  const lastWorkerSeenAt =
    workers.reduce((latest, worker) => {
      if (!worker.last_seen_at) {
        return latest;
      }

      const nextTime = new Date(worker.last_seen_at).getTime();
      return Number.isFinite(nextTime) && nextTime > latest ? nextTime : latest;
    }, 0) || null;

  return {
    workers,
    activeWorkers,
    workerConnected: activeWorkers.length > 0,
    lastWorkerSeenAt: lastWorkerSeenAt ? new Date(lastWorkerSeenAt).toISOString() : null,
    lastAckedCommandId: Number(ackResult.rows[0]?.lastAckedCommandId || 0),
    lastCommandId: Number(lastCommandResult.rows[0]?.lastCommandId || 0),
  };
}

async function getWorkerScreenState(deviceId) {
  const workerResult = await pool.query(
    `
    SELECT
      device_id,
      location_id,
      last_seen_at AS "lastSeenAt",
      status,
      last_known_volume AS "lastKnownVolume"
    FROM workers
    WHERE device_id = $1
    `,
    [deviceId]
  );

  const ackResult = await pool.query(
    `
    SELECT
      COALESCE(MAX(command_id), 0) AS "lastAckedCommandId",
      MAX(acked_at) AS "lastAckedAt"
    FROM command_deliveries
    WHERE device_id = $1
      AND status = 'ack'
    `,
    [deviceId]
  );

  const commandResult = await pool.query(`
    SELECT COALESCE(MAX(id), 0) AS "lastCommandId"
    FROM commands
  `);

  const worker = workerResult.rows[0];

  return {
    volumeState: {
      lastKnownPct: worker?.lastKnownVolume ?? null,
      lastCommandId: Number(commandResult.rows[0]?.lastCommandId || 0),
      lastAckedCommandId: Number(ackResult.rows[0]?.lastAckedCommandId || 0),
    },
    workerState: {
      lastSeenAt: worker?.lastSeenAt ?? null,
      lastAckedAt: ackResult.rows[0]?.lastAckedAt ?? null,
      lastError: null,
    },
  };
}

async function registerWorkerRecord(deviceId, locationId, lastKnownVolume = null) {
  const result = await pool.query(
    `
    INSERT INTO workers (
      device_id,
      location_id,
      last_seen_at,
      status,
      last_known_volume
    )
    VALUES ($1, $2, NOW(), 'online', $3)
    ON CONFLICT (device_id) DO UPDATE
    SET
      location_id = EXCLUDED.location_id,
      last_seen_at = NOW(),
      status = 'online',
      last_known_volume = COALESCE(EXCLUDED.last_known_volume, workers.last_known_volume)
    RETURNING
      device_id,
      location_id,
      last_seen_at AS "lastSeenAt",
      status,
      last_known_volume AS "lastKnownVolume"
    `,
    [deviceId, locationId, normalizeNullablePct(lastKnownVolume)]
  );

  return mapWorkerRow(result.rows[0]);
}

async function touchWorkerRecord(client, deviceId, locationId = null, lastKnownVolume = null) {
  await client.query(
    `
    INSERT INTO workers (
      device_id,
      location_id,
      last_seen_at,
      status,
      last_known_volume
    )
    VALUES ($1, COALESCE($2, $3), NOW(), 'online', $4)
    ON CONFLICT (device_id) DO UPDATE
    SET
      location_id = COALESCE($2, workers.location_id),
      last_seen_at = NOW(),
      status = 'online',
      last_known_volume = COALESCE($4, workers.last_known_volume)
    `,
    [deviceId, locationId, LEGACY_LOCATION_ID, normalizeNullablePct(lastKnownVolume)]
  );
}

async function countPendingDeliveriesForDevice(deviceId) {
  const result = await pool.query(
    `
    SELECT COUNT(*)::INTEGER AS count
    FROM command_deliveries
    WHERE device_id = $1
      AND status = 'pending'
    `,
    [deviceId]
  );

  return Number(result.rows[0]?.count || 0);
}

async function resolveTargetDeviceIds(client, target) {
  if (target.device_id) {
    const result = await client.query(
      `
      SELECT device_id
      FROM workers
      WHERE device_id = $1
        AND status = 'online'
      ORDER BY device_id ASC
      `,
      [target.device_id]
    );

    return result.rows.map((row) => row.device_id);
  }

  if (target.location_id) {
    const result = await client.query(
      `
      SELECT device_id
      FROM workers
      WHERE location_id = $1
        AND status = 'online'
      ORDER BY device_id ASC
      `,
      [target.location_id]
    );

    return result.rows.map((row) => row.device_id);
  }

  const result = await client.query(`
    SELECT device_id
    FROM workers
    WHERE status = 'online'
    ORDER BY device_id ASC
  `);

  return result.rows.map((row) => row.device_id);
}

async function createCommandRecord(target, type, payload) {
  if (!pool) {
    throw new Error("DATABASE_NOT_CONFIGURED");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const matchedDeviceIds = await resolveTargetDeviceIds(client, target);
    const initialStatus = matchedDeviceIds.length > 0 ? "pending" : "error";
    const commandResult = await client.query(
      `
      INSERT INTO commands (
        type,
        payload,
        target_device_id,
        target_location_id,
        created_at,
        executed_at,
        status
      )
      VALUES ($1, $2::jsonb, $3, $4, NOW(), $5, $6)
      RETURNING id, created_at AS "createdAt", status
      `,
      [
        type,
        toJsonPayload(payload),
        target.device_id,
        target.location_id,
        matchedDeviceIds.length > 0 ? null : new Date().toISOString(),
        initialStatus,
      ]
    );

    const commandId = Number(commandResult.rows[0].id);

    for (const deviceId of matchedDeviceIds) {
      await client.query(
        `
        INSERT INTO command_deliveries (
          command_id,
          device_id,
          status
        )
        VALUES ($1, $2, 'pending')
        `,
        [commandId, deviceId]
      );
    }

    await client.query("COMMIT");

    return {
      id: commandId,
      createdAt: commandResult.rows[0].createdAt,
      status: commandResult.rows[0].status,
      matchedDeviceIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function fetchPendingCommandsForDevice(deviceId, { locationId = null, lastKnownVolume = null } = {}) {
  if (!pool) {
    throw new Error("DATABASE_NOT_CONFIGURED");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await touchWorkerRecord(client, deviceId, locationId, lastKnownVolume);

    const result = await client.query(
      `
      SELECT
        cd.id AS "deliveryId",
        c.id,
        c.type,
        c.payload,
        c.created_at AS "createdAt"
      FROM command_deliveries cd
      JOIN commands c ON c.id = cd.command_id
      WHERE cd.device_id = $1
        AND cd.status = 'pending'
      ORDER BY c.created_at ASC
      LIMIT $2
      FOR UPDATE OF cd SKIP LOCKED
      `,
      [deviceId, COMMAND_BATCH_LIMIT]
    );

    const deliveryIds = result.rows.map((row) => row.deliveryId);
    const commandIds = [...new Set(result.rows.map((row) => row.id))];

    if (deliveryIds.length > 0) {
      await client.query(
        `
        UPDATE command_deliveries
        SET
          status = 'delivered',
          delivered_at = COALESCE(delivered_at, NOW())
        WHERE id = ANY($1::int[])
        `,
        [deliveryIds]
      );

      await client.query(
        `
        UPDATE commands
        SET status = 'sent'
        WHERE id = ANY($1::int[])
          AND status = 'pending'
        `,
        [commandIds]
      );
    }

    await client.query("COMMIT");

    return result.rows.map(({ deliveryId, ...row }) => mapCommandRow(row));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function acknowledgeCommandDelivery(commandId, deviceId, status, lastKnownVolume = null) {
  if (!pool) {
    throw new Error("DATABASE_NOT_CONFIGURED");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await touchWorkerRecord(client, deviceId, null, lastKnownVolume);

    const deliveryStatus = parseAckStatus(status);
    const deliveryResult = await client.query(
      `
      UPDATE command_deliveries
      SET
        status = $3,
        delivered_at = COALESCE(delivered_at, NOW()),
        acked_at = NOW()
      WHERE command_id = $1
        AND device_id = $2
      RETURNING command_id
      `,
      [commandId, deviceId, deliveryStatus]
    );

    if (deliveryResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const aggregateResult = await client.query(
      `
      SELECT
        COUNT(*)::INTEGER AS total,
        COUNT(*) FILTER (WHERE status = 'ack')::INTEGER AS ack_count,
        COUNT(*) FILTER (WHERE status = 'error')::INTEGER AS error_count,
        COUNT(*) FILTER (WHERE status = 'pending')::INTEGER AS pending_count,
        COUNT(*) FILTER (WHERE status = 'delivered')::INTEGER AS delivered_count
      FROM command_deliveries
      WHERE command_id = $1
      `,
      [commandId]
    );

    const aggregate = aggregateResult.rows[0];
    let commandStatus = "pending";
    let executedAt = null;

    if (aggregate.error_count > 0) {
      commandStatus = "error";
      executedAt = new Date().toISOString();
    } else if (aggregate.total > 0 && aggregate.ack_count === aggregate.total) {
      commandStatus = "ack";
      executedAt = new Date().toISOString();
    } else if (aggregate.delivered_count > 0 || aggregate.ack_count > 0) {
      commandStatus = "sent";
    }

    await client.query(
      `
      UPDATE commands
      SET
        status = $2,
        executed_at = CASE
          WHEN $3::timestamptz IS NULL THEN executed_at
          ELSE COALESCE(executed_at, $3::timestamptz)
        END
      WHERE id = $1
      `,
      [commandId, commandStatus, executedAt]
    );

    await client.query("COMMIT");

    return {
      commandId,
      deliveryStatus,
      commandStatus,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markOfflineWorkers() {
  if (!pool) {
    return;
  }

  await pool.query(
    `
    UPDATE workers
    SET status = 'offline'
    WHERE last_seen_at < NOW() - ($1::text || ' seconds')::interval
      AND status <> 'offline'
    `,
    [String(WORKER_OFFLINE_SECONDS)]
  );
}

app.get("/api/health", async (_req, res) => {
  if (!pool) {
    res.status(200).json({ ok: true, database: false, workers: 0, lastWorkerSeenAt: null });
    return;
  }

  try {
    await pool.query("SELECT 1");
    const snapshot = await getVolumeSystemSnapshot();

    res.status(200).json({
      ok: true,
      database: true,
      workers: snapshot.workers.length,
      lastWorkerSeenAt: snapshot.lastWorkerSeenAt,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: true,
      workers: 0,
      lastWorkerSeenAt: null,
      error: String(error),
    });
  }
});

app.get("/api/workers", async (_req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  try {
    const workers = await listWorkers();
    res.set("Cache-Control", "no-store");
    res.json({
      workers,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_LIST_WORKERS", detail: String(error) });
  }
});

app.post("/api/worker/register", requireWorkerAuth, async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const { device_id, location_id } = resolveWorkerIdentity(req);
  const lastKnownVolume = req.body?.last_known_volume ?? req.body?.lastKnownPct ?? null;

  if (!device_id || !location_id) {
    res.status(400).json({ error: "device_id_and_location_id_required" });
    return;
  }

  try {
    const worker = await registerWorkerRecord(device_id, location_id, lastKnownVolume);
    const queueSize = await countPendingDeliveriesForDevice(device_id);

    res.json({
      ok: true,
      worker,
      queueSize,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_REGISTER_WORKER", detail: String(error) });
  }
});

app.get("/api/commands", requireWorkerAuth, async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const device_id = parseOptionalString(req.query.device_id);
  const location_id = parseOptionalString(req.query.location_id);

  if (!device_id) {
    res.status(400).json({ error: "device_id_required" });
    return;
  }

  try {
    const commands = await fetchPendingCommandsForDevice(device_id, { locationId: location_id });
    res.set("Cache-Control", "no-store");
    res.json(commands);
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_FETCH_COMMANDS", detail: String(error) });
  }
});

app.post("/api/commands", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const type = parseOptionalString(req.body?.type);
  const target = resolveCommandTarget(req);
  const payload = req.body?.value ?? req.body?.payload ?? null;

  if (!type) {
    res.status(400).json({ error: "type_required" });
    return;
  }

  try {
    const command = await createCommandRecord(target, type, payload);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      id: command.id,
      type,
      value: payload,
      target,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_CREATE_COMMAND", detail: String(error) });
  }
});

app.post("/api/commands/:id/ack", requireWorkerAuth, async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const commandId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  const device_id = parseOptionalString(req.body?.device_id);
  const status = req.body?.status;
  const lastKnownVolume = req.body?.last_known_volume ?? req.body?.lastKnownPct ?? null;

  if (!commandId || !device_id) {
    res.status(400).json({ error: "command_id_and_device_id_required" });
    return;
  }

  try {
    const result = await acknowledgeCommandDelivery(commandId, device_id, status, lastKnownVolume);

    if (!result) {
      res.status(404).json({ error: "COMMAND_DELIVERY_NOT_FOUND" });
      return;
    }

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_ACK_COMMAND", detail: String(error) });
  }
});

app.get("/api/sessions", async (_req, res) => {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
    return;
  }

  try {
    const result = await pool.query(
      `
      SELECT payload
      FROM sessions
      ORDER BY created_at DESC
      LIMIT 100
      `
    );

    res.json(result.rows.map((row) => row.payload));
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_LIST_SESSIONS", detail: String(error) });
  }
});

app.post("/api/sessions", async (req, res) => {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
    return;
  }

  const session = req.body;

  if (!session || typeof session !== "object" || !session.id) {
    res.status(400).json({ error: "INVALID_SESSION_PAYLOAD" });
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO sessions (id, created_at, payload)
      VALUES ($1, COALESCE(($2)::timestamptz, NOW()), $3::jsonb)
      ON CONFLICT (id) DO UPDATE
      SET created_at = EXCLUDED.created_at,
          payload = EXCLUDED.payload
      `,
      [session.id, session.createdAt ?? null, JSON.stringify(session)]
    );

    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_SAVE_SESSION", detail: String(error) });
  }
});

app.get("/api/playlist/logs", requirePlaylistAuth, async (req, res) => {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
    return;
  }

  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 30));

  try {
    const logs = await getRecentLogs(pool, limit);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_LIST_PLAYLIST_LOGS", detail: String(error) });
  }
});

app.post("/api/playlist/rotate", requirePlaylistAuth, async (req, res) => {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
    return;
  }

  try {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
    const result = await runPlaylistRotation({ pool, dryRun });

    if (result.errors?.includes("rotation_already_running")) {
      res.status(409).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "PLAYLIST_ROTATION_FAILED", detail: String(error) });
  }
});

app.get("/screen", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.join(screenDir, "index.html"));
});

app.get("/screen/start.txt", (_req, res) => {
  const text = (startState.value || "").trim();

  if (text === "START") {
    startState.value = "";
    startState.consumedAt = new Date().toISOString();
  }

  res.set("Cache-Control", "no-store");
  res.send(text);
});

app.post("/screen/start.txt", (req, res) => {
  startState.value = typeof req.body === "string" ? req.body : "";
  res.set("Cache-Control", "no-store");
  res.send("Updated");
});

app.post("/screen/tts", (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
  if (!text) {
    res.status(400).json({ error: "no_text" });
    return;
  }

  if (!ELEVEN_API_KEY) {
    res.status(503).json({ error: "missing_elevenlabs_api_key" });
    return;
  }

  const payload = JSON.stringify({
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_SPEAKER_BOOST,
    },
  });

  const cacheKey = `${ELEVEN_VOICE_ID}::${ELEVEN_STABILITY}|${ELEVEN_SIMILARITY}|${ELEVEN_STYLE}|${ELEVEN_SPEAKER_BOOST}::${text}`;
  const cached = ttsCache.get(cacheKey);

  if (cached) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(cached);
    return;
  }

  const request = https.request(
    {
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      method: "POST",
      headers: {
        accept: "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": ELEVEN_API_KEY,
        "content-length": Buffer.byteLength(payload),
      },
    },
    (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);

        if (response.statusCode >= 200 && response.statusCode < 300) {
          ttsCache.set(cacheKey, body);
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Cache-Control", "no-store");
          res.send(body);
          return;
        }

        res.status(response.statusCode || 502).json({
          error: "tts_failed",
          status: response.statusCode,
          body: body.toString("utf8"),
        });
      });
    }
  );

  request.on("error", (error) => {
    res.status(502).json({ error: "tts_error", message: error.message });
  });

  request.write(payload);
  request.end();
});

app.get("/api/volume/:pct", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const pct = clampPct(req.params.pct);
  const target = resolveCommandTarget(req);

  try {
    const command = await createCommandRecord(target, "volume", pct);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      pct,
      target,
      commandId: command.id,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_SET_VOLUME", detail: String(error) });
  }
});

app.get("/api/volume/ramp/:pct", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const targetPct = clampPct(req.params.pct);
  const duration = Math.max(100, Number.parseInt(req.query.duration, 10) || 1200);
  const fromRaw = Number.parseInt(req.query.from, 10);
  const from = Number.isNaN(fromRaw) ? null : clampPct(fromRaw, targetPct);
  const target = resolveCommandTarget(req);
  const payload = from === null && duration === 1200 ? targetPct : { targetPct, duration, from };

  try {
    const command = await createCommandRecord(target, "volume_ramp", payload);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      targetPct,
      duration,
      from,
      target,
      commandId: command.id,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_RAMP_VOLUME", detail: String(error) });
  }
});

app.get("/screen/volume/mute", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const target = resolveCommandTarget(req);

  try {
    const command = await createCommandRecord(target, "mute", null);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      queued: true,
      commandId: command.id,
      target,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_QUEUE_MUTE", detail: String(error) });
  }
});

app.get("/screen/volume/unmute", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const target = resolveCommandTarget(req);

  try {
    const command = await createCommandRecord(target, "unmute", null);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      queued: true,
      commandId: command.id,
      target,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_QUEUE_UNMUTE", detail: String(error) });
  }
});

app.get("/screen/volume/ramp/:pct", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const targetPct = clampPct(req.params.pct);
  const duration = Math.max(100, Number.parseInt(req.query.duration, 10) || 1200);
  const fromRaw = Number.parseInt(req.query.from, 10);
  const from = Number.isNaN(fromRaw) ? null : clampPct(fromRaw, targetPct);
  const target = resolveCommandTarget(req);
  const payload = from === null && duration === 1200 ? targetPct : { targetPct, duration, from };

  try {
    const command = await createCommandRecord(target, "volume_ramp", payload);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      queued: true,
      commandId: command.id,
      targetPct,
      duration,
      from,
      target,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_QUEUE_RAMP", detail: String(error) });
  }
});

app.get("/screen/volume/:pct", async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const pct = clampPct(req.params.pct);
  const target = resolveCommandTarget(req);

  try {
    const command = await createCommandRecord(target, "volume", pct);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      queued: true,
      commandId: command.id,
      pct,
      target,
      matchedDeviceIds: command.matchedDeviceIds,
      workerCount: command.matchedDeviceIds.length,
      status: command.status,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_QUEUE_VOLUME", detail: String(error) });
  }
});

app.get("/screen/api/health", async (_req, res) => {
  if (!pool) {
    res.json({
      ok: true,
      workerConnected: false,
      lastWorkerSeenAt: null,
      lastAckedCommandId: 0,
      activeWorkers: [],
    });
    return;
  }

  try {
    const snapshot = await getVolumeSystemSnapshot();
    res.json({
      ok: true,
      workerConnected: snapshot.workerConnected,
      lastWorkerSeenAt: snapshot.lastWorkerSeenAt,
      lastAckedCommandId: snapshot.lastAckedCommandId,
      activeWorkers: snapshot.activeWorkers,
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_LOAD_SCREEN_HEALTH", detail: String(error) });
  }
});

app.get("/screen/api/worker/commands", requireWorkerAuth, async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const { device_id, location_id } = resolveWorkerIdentity(req, { allowLegacyDefaults: true });

  try {
    const commands = await fetchPendingCommandsForDevice(device_id, { locationId: location_id });
    const screenState = await getWorkerScreenState(device_id);

    res.set("Cache-Control", "no-store");
    res.json({
      commands: commands.map(mapLegacyCommandRow),
      volumeState: screenState.volumeState,
      workerState: screenState.workerState,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_FETCH_LEGACY_COMMANDS", detail: String(error) });
  }
});

app.post("/screen/api/worker/heartbeat", requireWorkerAuth, async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const { device_id, location_id } = resolveWorkerIdentity(req, { allowLegacyDefaults: true });
  const lastKnownVolume = req.body?.lastKnownPct ?? req.body?.last_known_volume ?? null;

  try {
    await registerWorkerRecord(device_id, location_id, lastKnownVolume);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_PROCESS_HEARTBEAT", detail: String(error) });
  }
});

app.post("/screen/api/worker/commands/:id/ack", requireWorkerAuth, async (req, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  const commandId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  const { device_id } = resolveWorkerIdentity(req, { allowLegacyDefaults: true });
  const status = req.body?.status;
  const lastKnownVolume = req.body?.lastKnownPct ?? req.body?.last_known_volume ?? null;

  if (!commandId) {
    res.status(400).json({ error: "command_id_required" });
    return;
  }

  try {
    const result = await acknowledgeCommandDelivery(commandId, device_id, status, lastKnownVolume);

    if (!result) {
      res.status(404).json({ error: "COMMAND_DELIVERY_NOT_FOUND" });
      return;
    }

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_ACK_LEGACY_COMMAND", detail: String(error) });
  }
});

async function withGymSpotify(fn) {
  if (!hasGymSpotify) throw new Error("gym_spotify_not_configured");
  if (!_gymSpotifyClient) {
    _gymSpotifyClient = new SpotifyClient({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      refreshToken: process.env.SPOTIFY_GYM_REFRESH_TOKEN,
    });
  }
  if (!_gymSpotifyClient.accessToken) {
    await _gymSpotifyClient.authenticate();
  }
  try {
    return await fn(_gymSpotifyClient);
  } catch (err) {
    if (String(err.message).includes("401")) {
      _gymSpotifyClient.accessToken = null;
      await _gymSpotifyClient.authenticate();
      return fn(_gymSpotifyClient);
    }
    throw err;
  }
}

app.get("/checkin/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  checkinClients.add(res);

  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch (_) {
      clearInterval(keepalive);
    }
  }, 25000);

  req.on("close", () => {
    checkinClients.delete(res);
    clearInterval(keepalive);
  });
});

app.get("/checkin/sdk-token", async (_req, res) => {
  if (!hasGymSpotify) {
    res.status(503).json({ error: "gym_spotify_not_configured" });
    return;
  }
  try {
    await withGymSpotify((client) => {
      res.json({ token: client.accessToken });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/checkin/volume/ramp/:pct", (req, res) => {
  const targetPct = clampPct(req.params.pct);
  const duration = Math.max(100, Number.parseInt(req.query.duration, 10) || 1200);
  broadcastCheckin("rampVolume", { targetPct, duration });
  res.json({ ok: true, targetPct, duration });
});

app.get("/api/checkin/volume/:pct", (req, res) => {
  const pct = clampPct(req.params.pct);
  broadcastCheckin("setVolume", { pct });
  res.json({ ok: true, pct });
});

app.get("/api/spotify/volume", async (_req, res) => {
  if (!hasSpotify) {
    res.status(503).json({ error: "spotify_not_configured" });
    return;
  }
  try {
    const state = await withSpotify((client) => client.getPlaybackState());
    if (!state) {
      res.json({ playing: false, volume: null, device: null });
      return;
    }
    res.json({
      playing: state.is_playing ?? false,
      volume: state.device?.volume_percent ?? null,
      device: state.device?.name ?? null,
    });
  } catch (err) {
    res.status(502).json({ error: "spotify_error", detail: err.message });
  }
});

app.get("/api/spotify/volume/:pct", async (req, res) => {
  if (!hasSpotify) {
    res.status(503).json({ error: "spotify_not_configured" });
    return;
  }
  const pct = clampPct(req.params.pct);
  try {
    await withSpotify((client) => client.setVolume(pct));
    res.json({ ok: true, pct });
  } catch (err) {
    res.status(502).json({ error: "spotify_error", detail: err.message });
  }
});

app.use(
  "/screen",
  express.static(screenDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        return;
      }

      if (/\.(js|css|png|jpg|jpeg|svg|webp|ico|mp3)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
      }
    },
  })
);

app.use(
  express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        return;
      }

      if (/\.(js|css|png|jpg|jpeg|svg|webp|ico)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

app.get(/.*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.join(distDir, "index.html"));
});

function startVolumeControlJobs() {
  cron.schedule(
    "45 * * * *",
    () => {
      runDetached("cron volume_ramp 50", createCommandRecord({ all: true }, "volume_ramp", 50));
      setTimeout(() => {
        runDetached("cron volume_ramp 90", createCommandRecord({ all: true }, "volume_ramp", 90));
      }, 5000);
    },
    { timezone: TZ }
  );

  cron.schedule(
    "55 * * * *",
    () => {
      runDetached("cron volume_ramp 50", createCommandRecord({ all: true }, "volume_ramp", 50));
    },
    { timezone: TZ }
  );

  cron.schedule(
    "8 * * * *",
    () => {
      runDetached("cron volume_ramp 90", createCommandRecord({ all: true }, "volume_ramp", 90));
    },
    { timezone: TZ }
  );

  setInterval(() => {
    runDetached("markOfflineWorkers", markOfflineWorkers());
  }, WORKER_OFFLINE_INTERVAL_MS);
}

initDb()
  .then(() => {
    startVolumeControlJobs();
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server", error);
    process.exit(1);
  });
