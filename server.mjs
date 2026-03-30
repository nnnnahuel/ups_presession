import express from "express";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getRecentLogs, initPlaylistTables } from "./playlist/state.mjs";
import { runPlaylistRotation } from "./playlist/rotate.mjs";

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

const hasDatabase = Boolean(process.env.DATABASE_URL);
const ttsCache = new Map();
const commandQueue = [];
const startState = { value: "", consumedAt: null };
const volumeState = {
  lastKnownPct: null,
  lastCommandId: 0,
  lastAckedCommandId: 0,
};
const workerState = {
  lastSeenAt: null,
  lastAckedAt: null,
  lastError: null,
};

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

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL
    )
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

function clampPct(value, fallback = 50) {
  const pct = Number.parseInt(value, 10);
  if (Number.isNaN(pct)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, pct));
}

function queueCommand(type, payload = {}) {
  const command = {
    id: ++volumeState.lastCommandId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };

  commandQueue.push(command);

  if (commandQueue.length > 500) {
    commandQueue.splice(0, commandQueue.length - 500);
  }

  return command;
}

app.get("/api/health", async (_req, res) => {
  if (!pool) {
    res.status(200).json({ ok: true, database: false });
    return;
  }

  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, database: true });
  } catch (error) {
    res.status(500).json({ ok: false, database: true, error: String(error) });
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

app.get("/screen/volume/mute", (_req, res) => {
  const command = queueCommand("mute");
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, queued: true, commandId: command.id });
});

app.get("/screen/volume/unmute", (_req, res) => {
  const command = queueCommand("unmute");
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, queued: true, commandId: command.id });
});

app.get("/screen/volume/ramp/:pct", (req, res) => {
  const targetPct = clampPct(req.params.pct);
  const duration = Math.max(100, Number.parseInt(req.query.duration, 10) || 1200);
  const fromRaw = Number.parseInt(req.query.from, 10);
  const from = Number.isNaN(fromRaw) ? null : clampPct(fromRaw, targetPct);
  const command = queueCommand("rampVolume", { targetPct, duration, from });

  res.set("Cache-Control", "no-store");
  res.json({ ok: true, queued: true, commandId: command.id, targetPct, duration, from });
});

app.get("/screen/volume/:pct", (req, res) => {
  const pct = clampPct(req.params.pct);
  const command = queueCommand("setVolume", { pct });

  res.set("Cache-Control", "no-store");
  res.json({ ok: true, queued: true, commandId: command.id, pct });
});

app.get("/screen/api/health", (_req, res) => {
  res.json({
    ok: true,
    workerConnected: Boolean(workerState.lastSeenAt),
    lastWorkerSeenAt: workerState.lastSeenAt,
    lastAckedCommandId: volumeState.lastAckedCommandId,
  });
});

app.get("/screen/api/worker/commands", requireWorkerAuth, (req, res) => {
  const since = Math.max(0, Number.parseInt(req.query.since, 10) || 0);
  workerState.lastSeenAt = new Date().toISOString();

  res.set("Cache-Control", "no-store");
  res.json({
    commands: commandQueue.filter((command) => command.id > since),
    volumeState,
    workerState,
    serverTime: new Date().toISOString(),
  });
});

app.post("/screen/api/worker/heartbeat", requireWorkerAuth, (req, res) => {
  workerState.lastSeenAt = new Date().toISOString();

  const lastKnownPct = Number(req.body?.lastKnownPct);
  if (Number.isFinite(lastKnownPct)) {
    volumeState.lastKnownPct = clampPct(lastKnownPct, 0);
  }

  const lastCommandId = Number(req.body?.lastCommandId);
  if (Number.isFinite(lastCommandId)) {
    volumeState.lastAckedCommandId = Math.max(volumeState.lastAckedCommandId, lastCommandId);
  }

  res.json({ ok: true });
});

app.post("/screen/api/worker/commands/:id/ack", requireWorkerAuth, (req, res) => {
  const id = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  const status = req.body?.status === "error" ? "error" : "ok";
  const lastKnownPct = Number(req.body?.lastKnownPct);

  workerState.lastSeenAt = new Date().toISOString();
  workerState.lastAckedAt = workerState.lastSeenAt;
  volumeState.lastAckedCommandId = Math.max(volumeState.lastAckedCommandId, id);

  if (Number.isFinite(lastKnownPct)) {
    volumeState.lastKnownPct = clampPct(lastKnownPct, 0);
  }

  workerState.lastError = status === "error" ? String(req.body?.error || "unknown_error") : null;

  res.json({ ok: true });
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
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server", error);
    process.exit(1);
  });
