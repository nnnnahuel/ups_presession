import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getRecentLogs, initPlaylistTables } from "./playlist/state.mjs";
import { runPlaylistRotation } from "./playlist/rotate.mjs";
import { SpotifyClient } from "./playlist/spotify.mjs";
import { acceptFairRequest, initFairQueue, runFairQueueTick, validateFairRequest } from "./playlist/fair-queue.mjs";
import { VOICE_LINES as SCREEN_V2_VOICE_LINES } from "./public/screen/v2/voice-lines.js";
import cron from "node-cron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const screenDir = path.join(__dirname, "public", "screen");
const screenV2Dir = path.join(screenDir, "v2");
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
const spotifyStudioConfigs = buildSpotifyStudioConfigs();
const spotifyStudioClients = new Map();

const checkinClients = new Set();
const ttsCache = new Map();
const ttsInflight = new Map();

// /screen/tts only speaks these texts. Each new text is a paid ElevenLabs call,
// so the endpoint must not accept arbitrary input.
// Legacy lines: the exact phrases public/screen/script.js picks from at :45 and :55.
const LEGACY_SCREEN_TTS_LINES = [
  "¡Ya quedan diez minutos!, ¡A terminar fuerte!",
  "¡Los últimos diez minutos!, ¡Vamos con todo!",
  "¡Últimos diez minutos!, ¡Último empujón!",
  "¡Sesión completada!, ¡Buen trabajo!",
  "¡Entrenamiento terminado!, ¡Excelente esfuerzo!",
];
const ALLOWED_TTS_TEXTS = new Set(
  [...LEGACY_SCREEN_TTS_LINES, ...Object.values(SCREEN_V2_VOICE_LINES)].map((text) => String(text).trim())
);

// Lobby bridge: the studio screen never talks to the portal directly.
const UPS_PORTAL_API_BASE_URL = String(process.env.UPS_PORTAL_API_BASE_URL || "").trim().replace(/\/+$/, "");
const STUDIO_SCREEN_API_TOKEN = String(process.env.STUDIO_SCREEN_API_TOKEN || "").trim();
const SCREEN_LOBBY_CACHE_MS = 4000;
const SCREEN_LOBBY_TIMEOUT_MS = 3500;
const SCREEN_LOBBY_ERROR_LOG_MS = 5 * 60 * 1000;
const screenLobbyCache = new Map();
const screenLobbyInflight = new Map();
const screenLobbyLastErrorLogAt = new Map();

// The lobby lists first names and arrival times, so /screen/v2 must present this
// key (header X-Screen-Key) for the lobby and the heartbeat. Unset = closed.
const SCREEN_DISPLAY_KEY_DIGEST = String(process.env.SCREEN_DISPLAY_KEY || "").trim()
  ? createHash("sha256").update(String(process.env.SCREEN_DISPLAY_KEY).trim()).digest()
  : null;

// Heartbeats from /screen/v2, kept in memory per studio.
const SCREEN_DISPLAY_ONLINE_SECONDS = 90;
const screenDisplays = new Map();
const startState = { value: "", consumedAt: null };
const TZ = "America/Argentina/Buenos_Aires";
const DEFAULT_GYM_PLAYLIST_NAME = "UP.S - SPT";
const SPOTIFY_PLAYLIST_GUARD_CRON = "0 7,15 * * *";
const DEFAULT_PLAYLIST_HANDOFF_DELAY_SECONDS = 22;
const DEFAULT_PLAYLIST_HANDOFF_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_PLAYLIST_HANDOFF_POLL_SECONDS = 5;

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS screen_tts_audio (
      cache_key TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      audio BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await initPlaylistTables(pool);
  await initFairQueue(pool);
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStudioId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-");

  if (["a", "studio-a", "estudio-a", "estudioa", "ups-a", "up-s-a"].includes(normalized)) {
    return "studio-a";
  }

  if (["b", "studio-b", "estudio-b", "estudiob", "ups-b", "up-s-b"].includes(normalized)) {
    return "studio-b";
  }

  return null;
}

function buildSpotifyStudioConfigs() {
  const common = {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
  };

  return {
    "studio-a": {
      ...common,
      id: "studio-a",
      label: process.env.SPOTIFY_STUDIO_A_LABEL || "Estudio A UP.S",
      refreshToken: process.env.SPOTIFY_STUDIO_A_REFRESH_TOKEN || process.env.SPOTIFY_GYM_REFRESH_TOKEN || "",
      deviceId: process.env.SPOTIFY_STUDIO_A_DEVICE_ID || process.env.SPOTIFY_GYM_DEVICE_ID || "",
    },
    "studio-b": {
      ...common,
      id: "studio-b",
      label: process.env.SPOTIFY_STUDIO_B_LABEL || "Estudio B UP.S",
      refreshToken: process.env.SPOTIFY_STUDIO_B_REFRESH_TOKEN || "",
      deviceId: process.env.SPOTIFY_STUDIO_B_DEVICE_ID || "",
    },
  };
}

function spotifyEndpointError(statusCode, errorCode, message) {
  const error = new Error(message || errorCode);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function getSpotifyStudioConfig(value) {
  const studioId = normalizeStudioId(value);
  if (!studioId) {
    throw spotifyEndpointError(400, "spotify_studio_required", "A valid studio is required.");
  }

  const config = spotifyStudioConfigs[studioId];
  if (!config || !config.clientId || !config.clientSecret || !config.refreshToken) {
    throw spotifyEndpointError(503, "spotify_studio_not_configured", "Spotify is not configured for this studio.");
  }

  return config;
}

async function withStudioSpotify(studio, fn) {
  const config = getSpotifyStudioConfig(studio);
  let client = spotifyStudioClients.get(config.id);

  if (!client) {
    client = new SpotifyClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    });
    spotifyStudioClients.set(config.id, client);
  }

  if (!client.accessToken) {
    await client.authenticate();
  }

  try {
    return await fn(client, config);
  } catch (err) {
    if (String(err.message).includes("401")) {
      client.accessToken = null;
      await client.authenticate();
      return fn(client, config);
    }

    throw err;
  }
}

function parseSpotifyTrackUri(value) {
  const match = String(value || "").trim().match(/^spotify:track:([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

function mapSpotifyTrack(track) {
  const albumImages = Array.isArray(track?.album?.images) ? track.album.images : [];
  const image = albumImages.find((item) => item?.url)?.url || null;

  return {
    id: track?.id || null,
    uri: track?.uri || null,
    name: track?.name || "",
    artists: Array.isArray(track?.artists)
      ? track.artists.map((artist) => artist?.name).filter(Boolean)
      : [],
    album: track?.album?.name || "",
    album_image_url: image,
    duration_ms: track?.duration_ms ?? null,
    explicit: track?.explicit === true,
    spotify_url: track?.external_urls?.spotify || null,
  };
}

function mapSpotifyDevice(device) {
  return {
    id: device?.id || null,
    name: device?.name || "",
    type: device?.type || "",
    is_active: device?.is_active === true,
    is_restricted: device?.is_restricted === true,
    volume_percent: device?.volume_percent ?? null,
  };
}

function spotifyPlaylistGuardEnabled() {
  return String(process.env.SPOTIFY_PLAYLIST_GUARD_ENABLED || "true").toLowerCase() !== "false";
}

function spotifyPlaylistGuardMode(value, fallback = "immediate") {
  const normalized = String(value || fallback).trim().toLowerCase();
  return normalized === "soft" ? "soft" : "immediate";
}

function spotifyPlaylistHandoffDelayMs() {
  return (
    parsePositiveInteger(
      process.env.SPOTIFY_PLAYLIST_HANDOFF_DELAY_SECONDS,
      DEFAULT_PLAYLIST_HANDOFF_DELAY_SECONDS
    ) * 1000
  );
}

function spotifyPlaylistHandoffTimeoutMs() {
  return (
    parsePositiveInteger(
      process.env.SPOTIFY_PLAYLIST_HANDOFF_TIMEOUT_SECONDS,
      DEFAULT_PLAYLIST_HANDOFF_TIMEOUT_SECONDS
    ) * 1000
  );
}

function spotifyPlaylistHandoffPollMs() {
  return (
    parsePositiveInteger(
      process.env.SPOTIFY_PLAYLIST_HANDOFF_POLL_SECONDS,
      DEFAULT_PLAYLIST_HANDOFF_POLL_SECONDS
    ) * 1000
  );
}

function parseSpotifyPlaylistId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const uriMatch = raw.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uriMatch) {
    return uriMatch[1];
  }

  const urlMatch = raw.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  return /^[A-Za-z0-9]+$/.test(raw) ? raw : "";
}

function spotifyGuardPlaylistId() {
  return parseSpotifyPlaylistId(
    process.env.SPOTIFY_GYM_PLAYLIST_ID ||
    process.env.SPOTIFY_GYM_ENFORCED_PLAYLIST_ID ||
    process.env.SPOTIFY_MAIN_PLAYLIST_ID ||
    ""
  );
}

function spotifyGuardPlaylistName() {
  return (process.env.SPOTIFY_GYM_PLAYLIST_NAME || DEFAULT_GYM_PLAYLIST_NAME).trim();
}

function spotifyGuardStudioIds(value = process.env.SPOTIFY_PLAYLIST_GUARD_STUDIOS) {
  if (!value) {
    return ["studio-a"];
  }

  const raw = String(value)
    .split(",")
    .map((item) => normalizeStudioId(item))
    .filter(Boolean);
  return [...new Set(raw)];
}

function spotifyPlaylistContextUri(playlistId) {
  const safePlaylistId = String(playlistId || "").trim();
  return safePlaylistId ? `spotify:playlist:${safePlaylistId}` : "";
}

function spotifyPlaybackSummary(state) {
  if (!state) {
    return {
      playing: false,
      context_uri: null,
      repeat_state: null,
      device_id: null,
      device_name: null,
      item_uri: null,
      item_name: null,
      progress_ms: null,
      duration_ms: null,
    };
  }

  return {
    playing: state.is_playing === true,
    context_uri: state.context?.uri || null,
    repeat_state: state.repeat_state || null,
    device_id: state.device?.id || null,
    device_name: state.device?.name || null,
    item_uri: state.item?.uri || null,
    item_name: state.item?.name || null,
    progress_ms: Number.isFinite(Number(state.progress_ms)) ? Number(state.progress_ms) : null,
    duration_ms: Number.isFinite(Number(state.item?.duration_ms)) ? Number(state.item.duration_ms) : null,
  };
}

function spotifyTrackSummary(track) {
  return {
    id: track?.id || null,
    uri: track?.uri || null,
    name: track?.name || "",
    artists: Array.isArray(track?.artists)
      ? track.artists.map((artist) => artist?.name).filter(Boolean)
      : [],
  };
}

async function selectSpotifyPlaylistHandoffTrack(client, playlistId, currentTrackUri = null) {
  const playlistItems = await client.getPlaylistItems(playlistId);
  const tracks = playlistItems
    .map((item) => item?.track)
    .filter((track) => track?.uri && parseSpotifyTrackUri(track.uri) && track.explicit !== true);

  if (!tracks.length) {
    throw spotifyEndpointError(422, "spotify_playlist_empty", "The playlist has no playable tracks.");
  }

  const currentTrack = currentTrackUri ? tracks.find((track) => track.uri === currentTrackUri) : null;
  if (currentTrack) {
    return {
      track: currentTrack,
      current_track_in_playlist: true,
    };
  }

  return {
    track: tracks[Math.floor(Math.random() * tracks.length)],
    current_track_in_playlist: false,
  };
}

async function waitForSpotifyTrack(client, trackUri, targetDeviceId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = await client.getPlaybackState();
    const summary = spotifyPlaybackSummary(state);
    const onExpectedDevice = !targetDeviceId || summary.device_id === targetDeviceId;
    if (summary.item_uri === trackUri && onExpectedDevice && summary.playing) {
      return state;
    }

    await sleep(Math.min(pollMs, Math.max(1000, deadline - Date.now())));
  }

  return null;
}

async function waitPastSpotifyCrossfade(client, trackUri, delayMs) {
  let state = await client.getPlaybackState();
  let summary = spotifyPlaybackSummary(state);
  if (summary.item_uri !== trackUri || !summary.playing) {
    return null;
  }

  const remainingDelayMs = Math.max(0, delayMs - (summary.progress_ms || 0));
  if (remainingDelayMs > 0) {
    await sleep(remainingDelayMs);
    state = await client.getPlaybackState();
    summary = spotifyPlaybackSummary(state);
  }

  return summary.item_uri === trackUri && summary.playing ? state : null;
}

async function runSpotifySoftPlaylistHandoff({ client, config, playlistId, state }) {
  const targetDeviceId = config.deviceId || null;
  const delayMs = spotifyPlaylistHandoffDelayMs();
  const timeoutMs = spotifyPlaylistHandoffTimeoutMs();
  const pollMs = spotifyPlaylistHandoffPollMs();
  const currentTrackUri = spotifyPlaybackSummary(state).item_uri;
  const selected = await selectSpotifyPlaylistHandoffTrack(client, playlistId, currentTrackUri);
  const handoffTrack = selected.track;
  const actions = [];

  if (!selected.current_track_in_playlist) {
    await client.addToQueue(handoffTrack.uri, targetDeviceId);
    actions.push("queue_playlist_track");
  }

  actions.push("wait_for_handoff_track");
  const startedState = selected.current_track_in_playlist
    ? state
    : await waitForSpotifyTrack(client, handoffTrack.uri, targetDeviceId, timeoutMs, pollMs);

  if (!startedState) {
    return {
      skipped: true,
      reason: "soft_handoff_timeout",
      actions,
      handoff_track: spotifyTrackSummary(handoffTrack),
      timeout_ms: timeoutMs,
      delay_ms: delayMs,
    };
  }

  const settledState = await waitPastSpotifyCrossfade(client, handoffTrack.uri, delayMs);
  if (!settledState) {
    return {
      skipped: true,
      reason: "handoff_track_changed",
      actions,
      handoff_track: spotifyTrackSummary(handoffTrack),
      timeout_ms: timeoutMs,
      delay_ms: delayMs,
    };
  }

  const settledSummary = spotifyPlaybackSummary(settledState);
  await client.playPlaylist(playlistId, targetDeviceId, {
    offsetUri: handoffTrack.uri,
    positionMs: settledSummary.progress_ms || 0,
  });
  actions.push("play_playlist_context_from_track");

  await client.setRepeatMode("context", targetDeviceId);
  actions.push("set_repeat_context");

  return {
    skipped: false,
    reason: null,
    actions,
    handoff_track: spotifyTrackSummary(handoffTrack),
    timeout_ms: timeoutMs,
    delay_ms: delayMs,
  };
}

async function planSpotifySoftPlaylistHandoff({ client, playlistId, state }) {
  const currentTrackUri = spotifyPlaybackSummary(state).item_uri;
  const selected = await selectSpotifyPlaylistHandoffTrack(client, playlistId, currentTrackUri);
  const actions = selected.current_track_in_playlist
    ? ["wait_for_handoff_track", "play_playlist_context_from_track", "set_repeat_context"]
    : ["queue_playlist_track", "wait_for_handoff_track", "play_playlist_context_from_track", "set_repeat_context"];

  return {
    skipped: false,
    reason: null,
    actions,
    handoff_track: spotifyTrackSummary(selected.track),
    current_track_in_playlist: selected.current_track_in_playlist,
    timeout_ms: spotifyPlaylistHandoffTimeoutMs(),
    delay_ms: spotifyPlaylistHandoffDelayMs(),
  };
}

async function ensureSpotifyPlaylistForStudio({ studio, dryRun = false, mode = "immediate" }) {
  const playlistId = spotifyGuardPlaylistId();
  if (!playlistId) {
    return {
      studio,
      skipped: true,
      reason: "playlist_not_configured",
      playlist_id: null,
      playlist_name: spotifyGuardPlaylistName(),
      actions: [],
    };
  }

  const targetContextUri = spotifyPlaylistContextUri(playlistId);
  const guardMode = spotifyPlaylistGuardMode(mode);
  return withStudioSpotify(studio, async (client, config) => {
    const state = await client.getPlaybackState();
    const before = spotifyPlaybackSummary(state);
    const targetDeviceId = config.deviceId || null;
    const onTargetPlaylist = before.context_uri === targetContextUri;
    const onTargetDevice = !targetDeviceId || before.device_id === targetDeviceId;
    const repeatOk = before.repeat_state === "context";
    const actions = [];

    if (onTargetPlaylist && onTargetDevice) {
      if (!repeatOk) {
        actions.push("set_repeat_context");
      }

      if (dryRun) {
        return {
          studio: config.id,
          label: config.label,
          skipped: false,
          dry_run: true,
          mode: guardMode,
          playlist_id: playlistId,
          playlist_name: spotifyGuardPlaylistName(),
          target_context_uri: targetContextUri,
          target_device_id: targetDeviceId,
          before,
          actions,
        };
      }

      if (!repeatOk) {
        await client.setRepeatMode("context", targetDeviceId);
      }

      const after = await client.getPlaybackState();
      return {
        studio: config.id,
        label: config.label,
        skipped: false,
        dry_run: false,
        mode: guardMode,
        playlist_id: playlistId,
        playlist_name: spotifyGuardPlaylistName(),
        target_context_uri: targetContextUri,
        target_device_id: targetDeviceId,
        before,
        after: spotifyPlaybackSummary(after),
        actions,
      };
    }

    if (guardMode === "soft" && before.playing && onTargetDevice) {
      const handoff = dryRun
        ? await planSpotifySoftPlaylistHandoff({ client, playlistId, state })
        : await runSpotifySoftPlaylistHandoff({ client, config, playlistId, state });
      const after = dryRun ? null : await client.getPlaybackState();

      return {
        studio: config.id,
        label: config.label,
        skipped: handoff.skipped,
        reason: handoff.reason,
        dry_run: dryRun,
        mode: guardMode,
        playlist_id: playlistId,
        playlist_name: spotifyGuardPlaylistName(),
        target_context_uri: targetContextUri,
        target_device_id: targetDeviceId,
        before,
        after: after ? spotifyPlaybackSummary(after) : null,
        actions: handoff.actions,
        handoff,
      };
    }

    if (!onTargetPlaylist || !onTargetDevice || !state) {
      actions.push("play_playlist");
    }

    if (!repeatOk) {
      actions.push("set_repeat_context");
    }

    if (dryRun) {
      return {
        studio: config.id,
        label: config.label,
        skipped: false,
        dry_run: true,
        mode: guardMode,
        playlist_id: playlistId,
        playlist_name: spotifyGuardPlaylistName(),
        target_context_uri: targetContextUri,
        target_device_id: targetDeviceId,
        before,
        actions,
      };
    }

    if (actions.includes("play_playlist")) {
      await client.playPlaylist(playlistId, targetDeviceId);
    }

    if (actions.includes("set_repeat_context")) {
      await client.setRepeatMode("context", targetDeviceId);
    }

    const after = await client.getPlaybackState();
    return {
      studio: config.id,
      label: config.label,
      skipped: false,
      dry_run: false,
      mode: guardMode,
      playlist_id: playlistId,
      playlist_name: spotifyGuardPlaylistName(),
      target_context_uri: targetContextUri,
      target_device_id: targetDeviceId,
      before,
      after: spotifyPlaybackSummary(after),
      actions,
    };
  });
}

async function runSpotifyPlaylistGuard({ dryRun = false, studios = null, mode = "immediate" } = {}) {
  const startedAt = new Date().toISOString();
  if (!spotifyPlaylistGuardEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: "disabled",
      started_at: startedAt,
      results: [],
    };
  }

  const studioIds = studios?.length ? studios : spotifyGuardStudioIds();
  const guardMode = spotifyPlaylistGuardMode(mode);
  const results = [];
  const errors = [];

  for (const studio of studioIds) {
    try {
      results.push(await ensureSpotifyPlaylistForStudio({ studio, dryRun, mode: guardMode }));
    } catch (error) {
      errors.push({
        studio,
        error: error?.errorCode || "spotify_playlist_guard_error",
        detail: error?.message || String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    skipped: false,
    dry_run: dryRun,
    mode: guardMode,
    started_at: startedAt,
    playlist_id: spotifyGuardPlaylistId() || null,
    playlist_name: spotifyGuardPlaylistName(),
    studios: studioIds,
    results,
    errors,
  };
}

function sendSpotifyEndpointError(res, error, fallbackCode = "spotify_error") {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
  res.status(status).json({
    error: error?.errorCode || fallbackCode,
    detail: error?.message || String(error),
  });
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

app.get("/api/spotify/studios", requirePlaylistAuth, (_req, res) => {
  res.json({
    studios: Object.values(spotifyStudioConfigs).map((config) => ({
      id: config.id,
      label: config.label,
      configured: Boolean(config.clientId && config.clientSecret && config.refreshToken),
      device_id: config.deviceId || null,
      device_configured: Boolean(config.deviceId),
    })),
  });
});

app.get("/api/spotify/devices", requirePlaylistAuth, async (req, res) => {
  try {
    const result = await withStudioSpotify(req.query.studio, async (client, config) => {
      const devices = await client.getAvailableDevices();
      return {
        studio: {
          id: config.id,
          label: config.label,
          device_id: config.deviceId || null,
          device_configured: Boolean(config.deviceId),
        },
        devices: devices.map(mapSpotifyDevice),
      };
    });

    res.json(result);
  } catch (error) {
    sendSpotifyEndpointError(res, error, "spotify_devices_error");
  }
});

app.get("/api/spotify/search", requirePlaylistAuth, async (req, res) => {
  const query = parseOptionalString(req.query.q);
  if (!query) {
    res.status(400).json({ error: "spotify_search_query_required" });
    return;
  }

  const limit = Math.max(1, Math.min(10, Number.parseInt(req.query.limit, 10) || 5));
  const includeExplicit = parseBoolean(req.query.include_explicit ?? req.query.includeExplicit);

  try {
    const result = await withStudioSpotify(req.query.studio, async (client, config) => {
      const tracks = await client.searchTracks(query, limit, 1, { strict: true });
      return {
        studio: {
          id: config.id,
          label: config.label,
        },
        tracks: tracks
          .map(mapSpotifyTrack)
          .filter((track) => track.uri && (includeExplicit || track.explicit !== true)),
      };
    });

    res.json(result);
  } catch (error) {
    sendSpotifyEndpointError(res, error, "spotify_search_error");
  }
});

app.post("/api/spotify/queue", requirePlaylistAuth, async (req, res) => {
  const uri = parseOptionalString(req.body?.uri ?? req.body?.track_uri);
  const rawTrackId = parseOptionalString(req.body?.track_id);
  const trackId =
    parseSpotifyTrackUri(uri) ||
    (/^[A-Za-z0-9]+$/.test(rawTrackId || "") ? rawTrackId : null);

  if (!trackId) {
    res.status(400).json({ error: "spotify_track_required" });
    return;
  }

  try {
    const fairRequest = req.body?.athlete_id != null || req.body?.request_id != null;
    if (fairRequest) {
      validateFairRequest({ athleteId: req.body.athlete_id, requestId: req.body.request_id });
      if (!pool) throw spotifyEndpointError(503, "music_queue_unavailable", "Music queue storage is unavailable.");
    }
    const result = await withStudioSpotify(req.body?.studio ?? req.query.studio, async (client, config) => {
      const track = await client.getTrack(trackId);
      let queueRequest = null;
      if (fairRequest) {
        queueRequest = await acceptFairRequest(pool, {
          athleteId: req.body.athlete_id, requestId: req.body.request_id, studio: config.id, track: mapSpotifyTrack(track),
        });
      } else {
        // Preserve callers outside the athlete app during the staged rollout.
        await client.addToQueue(track.uri, config.deviceId || null);
      }

      return {
        ok: true,
        studio: {
          id: config.id,
          label: config.label,
        },
        device_id: config.deviceId || null,
        track: mapSpotifyTrack(track),
        queue_mode: fairRequest ? "athlete_rotation" : "spotify",
        queue_request: queueRequest,
      };
    });

    res.status(202).json(result);
  } catch (error) {
    sendSpotifyEndpointError(res, error, "spotify_queue_error");
  }
});

app.post("/api/spotify/playlist-guard", requirePlaylistAuth, async (req, res) => {
  const rawStudios = req.body?.studios ?? req.query.studios ?? req.body?.studio ?? req.query.studio;
  let studios = null;
  if (Array.isArray(rawStudios)) {
    studios = [...new Set(rawStudios.map((item) => normalizeStudioId(item)).filter(Boolean))];
  } else if (typeof rawStudios === "string" && rawStudios.trim()) {
    studios = spotifyGuardStudioIds(rawStudios);
  }

  if (rawStudios && studios?.length === 0) {
    res.status(400).json({ error: "spotify_studio_required" });
    return;
  }

  try {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
    const mode = spotifyPlaylistGuardMode(req.body?.mode ?? req.query.mode, "immediate");
    const result = await runSpotifyPlaylistGuard({ dryRun, studios, mode });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    sendSpotifyEndpointError(res, error, "spotify_playlist_guard_error");
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

async function readStoredTts(cacheKey) {
  const cached = ttsCache.get(cacheKey);
  if (cached) return cached;
  if (!pool) return null;

  try {
    const result = await pool.query("SELECT audio FROM screen_tts_audio WHERE cache_key = $1", [cacheKey]);
    const audio = result.rows[0]?.audio;
    if (audio) {
      ttsCache.set(cacheKey, audio);
      return audio;
    }
  } catch (error) {
    console.error("[screen-tts] stored audio read failed:", error.message);
  }
  return null;
}

async function storeTts(cacheKey, text, audio) {
  ttsCache.set(cacheKey, audio);
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO screen_tts_audio (cache_key, text, audio)
       VALUES ($1, $2, $3)
       ON CONFLICT (cache_key) DO NOTHING`,
      [cacheKey, text, audio]
    );
  } catch (error) {
    console.error("[screen-tts] stored audio write failed:", error.message);
  }
}

function requestElevenLabsSpeech(text) {
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

  return new Promise((resolve, reject) => {
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
        response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      }
    );

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

app.post("/screen/tts", async (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
  if (!text) {
    res.status(400).json({ error: "no_text" });
    return;
  }

  if (!ALLOWED_TTS_TEXTS.has(text)) {
    res.status(400).json({ error: "text_not_allowed" });
    return;
  }

  const cacheKey = `${ELEVEN_VOICE_ID}::${ELEVEN_STABILITY}|${ELEVEN_SIMILARITY}|${ELEVEN_STYLE}|${ELEVEN_SPEAKER_BOOST}::${text}`;
  const sendAudio = (audio) => {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  };

  const stored = await readStoredTts(cacheKey);
  if (stored) {
    sendAudio(stored);
    return;
  }

  if (!ELEVEN_API_KEY) {
    res.status(503).json({ error: "missing_elevenlabs_api_key" });
    return;
  }

  // The screen preloads every line at once; one ElevenLabs call per text.
  let pending = ttsInflight.get(cacheKey);
  if (!pending) {
    pending = requestElevenLabsSpeech(text).finally(() => ttsInflight.delete(cacheKey));
    ttsInflight.set(cacheKey, pending);
  }

  try {
    const { statusCode, body } = await pending;
    if (statusCode >= 200 && statusCode < 300) {
      await storeTts(cacheKey, text, body);
      sendAudio(body);
      return;
    }

    res.status(statusCode || 502).json({
      error: "tts_failed",
      status: statusCode,
      body: body.toString("utf8"),
    });
  } catch (error) {
    res.status(502).json({ error: "tts_error", message: error.message });
  }
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
      screenDisplays: screenDisplaySnapshot(),
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
      screenDisplays: screenDisplaySnapshot(),
    });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_LOAD_SCREEN_HEALTH", detail: String(error) });
  }
});

// ===== /screen/v2 =====

function parseScreenStudio(value) {
  const studio = String(value ?? "A").trim().toUpperCase() || "A";
  return studio === "A" || studio === "B" ? studio : null;
}

function parseIsoTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeScreenSlot(slot) {
  if (!slot || typeof slot !== "object") return null;
  const startsAt = parseIsoTimestamp(slot.starts_at);
  if (!startsAt) return null;
  return { starts_at: startsAt, ends_at: parseIsoTimestamp(slot.ends_at) };
}

// Pass through only the contract fields the screen uses.
function normalizeScreenLobbyPayload(data, studio) {
  if (!data || typeof data !== "object") return null;

  let lobby = null;
  const rawLobby = data.lobby;
  const lobbyStartsAt = rawLobby && typeof rawLobby === "object" ? parseIsoTimestamp(rawLobby.starts_at) : null;
  if (lobbyStartsAt) {
    const athletes = Array.isArray(rawLobby.athletes) ? rawLobby.athletes : [];
    lobby = {
      starts_at: lobbyStartsAt,
      coach: typeof rawLobby.coach === "string" ? rawLobby.coach.slice(0, 60) : null,
      athletes: athletes
        .filter((athlete) => athlete && typeof athlete === "object" && typeof athlete.name === "string")
        .slice(0, 30)
        .map((athlete, index) => ({
          id: String(athlete.id ?? `athlete-${index}`).slice(0, 64),
          name: athlete.name.trim().slice(0, 40),
          checked_in_at: parseIsoTimestamp(athlete.checked_in_at),
          first_session: athlete.first_session === true,
        })),
    };
  }

  return {
    ok: true,
    now: parseIsoTimestamp(data.now),
    studio,
    current: normalizeScreenSlot(data.current),
    lobby,
  };
}

function logScreenLobbyFailure(studio, message) {
  const lastLoggedAt = screenLobbyLastErrorLogAt.get(studio) || 0;
  if (Date.now() - lastLoggedAt < SCREEN_LOBBY_ERROR_LOG_MS) return;
  screenLobbyLastErrorLogAt.set(studio, Date.now());
  console.error(`[screen-lobby] studio ${studio}: ${message}`);
}

async function fetchPortalScreenLobby(studio) {
  if (!UPS_PORTAL_API_BASE_URL || !STUDIO_SCREEN_API_TOKEN) {
    return { ok: false };
  }

  try {
    const response = await fetch(
      `${UPS_PORTAL_API_BASE_URL}/api/studio-screen/lobby/?studio=${encodeURIComponent(studio)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${STUDIO_SCREEN_API_TOKEN}`,
        },
        signal: AbortSignal.timeout(SCREEN_LOBBY_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      logScreenLobbyFailure(studio, `portal answered ${response.status}`);
      return { ok: false };
    }

    const normalized = normalizeScreenLobbyPayload(await response.json(), studio);
    if (!normalized) {
      logScreenLobbyFailure(studio, "portal answered an unexpected body");
      return { ok: false };
    }
    return normalized;
  } catch (error) {
    logScreenLobbyFailure(studio, error?.name === "TimeoutError" ? "portal timed out" : String(error?.message || error));
    return { ok: false };
  }
}

async function getScreenLobby(studio) {
  const cached = screenLobbyCache.get(studio);
  if (cached && Date.now() - cached.at < SCREEN_LOBBY_CACHE_MS) {
    return cached.data;
  }

  let pending = screenLobbyInflight.get(studio);
  if (!pending) {
    pending = fetchPortalScreenLobby(studio)
      .then((data) => {
        screenLobbyCache.set(studio, { at: Date.now(), data });
        return data;
      })
      .finally(() => screenLobbyInflight.delete(studio));
    screenLobbyInflight.set(studio, pending);
  }
  return pending;
}

// Constant-time check of X-Screen-Key; comparing digests keeps the length out of the timing too.
function hasScreenDisplayKey(req) {
  if (!SCREEN_DISPLAY_KEY_DIGEST) return false;
  const provided = req.get("x-screen-key");
  if (typeof provided !== "string" || !provided.trim()) return false;
  return timingSafeEqual(createHash("sha256").update(provided.trim()).digest(), SCREEN_DISPLAY_KEY_DIGEST);
}

app.get("/screen/api/lobby", async (req, res) => {
  res.set("Cache-Control", "no-store");
  // Without the key the screen gets the same answer as a portal outage and runs by the clock alone.
  if (!hasScreenDisplayKey(req)) {
    res.json({ ok: false, serverTime: new Date().toISOString() });
    return;
  }

  const studio = parseScreenStudio(req.query.studio);
  if (!studio) {
    res.status(400).json({ ok: false, error: "invalid_studio" });
    return;
  }

  const data = await getScreenLobby(studio);
  res.json({ ...data, serverTime: new Date().toISOString() });
});

function screenDisplaySnapshot() {
  const now = Date.now();
  return [...screenDisplays.values()]
    .sort((a, b) => a.studio.localeCompare(b.studio))
    .map((display) => ({
      ...display,
      online: now - Date.parse(display.lastSeenAt) < SCREEN_DISPLAY_ONLINE_SECONDS * 1000,
    }));
}

app.post("/screen/api/display/heartbeat", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!hasScreenDisplayKey(req)) {
    res.json({ ok: false });
    return;
  }

  const studio = parseScreenStudio(req.body?.studio);
  if (!studio) {
    res.status(400).json({ ok: false, error: "invalid_studio" });
    return;
  }

  const lastCue =
    typeof req.body?.lastCue === "string" && /^[a-z0-9_-]{1,32}$/i.test(req.body.lastCue) ? req.body.lastCue : null;

  screenDisplays.set(studio, {
    studio,
    audioUnlocked: req.body?.audioUnlocked === true,
    voiceReady: req.body?.voiceReady === true,
    lastCue,
    lastCueAt: lastCue ? parseIsoTimestamp(req.body?.lastCueAt) : null,
    lastSeenAt: new Date().toISOString(),
  });
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.get("/screen/v2", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  // `root` keeps send's dotfile check to the file name, so this also works from a checkout under a dot folder.
  res.sendFile("index.html", { root: screenV2Dir });
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

function startSpotifyPlaylistGuardJobs() {
  if (!spotifyPlaylistGuardEnabled()) {
    return;
  }

  cron.schedule(
    SPOTIFY_PLAYLIST_GUARD_CRON,
    () => {
      runDetached(
        "cron spotify_playlist_guard",
        runSpotifyPlaylistGuard({ mode: "soft" }).then((result) => {
          console.log(
            "[spotify] playlist_guard",
            JSON.stringify({
              ok: result.ok,
              skipped: result.skipped,
              mode: result.mode,
              playlist_id: result.playlist_id,
              playlist_name: result.playlist_name,
              studios: result.studios,
              actions: result.results?.map((item) => ({
                studio: item.studio,
                actions: item.actions,
                skipped: item.skipped,
                reason: item.reason,
                handoff_track: item.handoff?.handoff_track || null,
              })),
              errors: result.errors,
            })
          );
        })
      );
    },
    { timezone: TZ }
  );
}

initDb()
  .then(() => {
    // Per-studio database locks prevent duplicate dispatches. A slow Spotify
    // account must not stop polling the other studio.
    const fairQueueTimer = setInterval(() => {
      runFairQueueTick({ pool, withStudioSpotify }).catch(error => {
        console.error('[fair-music]', error.message);
      });
    }, 5000);
    fairQueueTimer.unref();
    startVolumeControlJobs();
    startSpotifyPlaylistGuardJobs();
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server", error);
    process.exit(1);
  });
