const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const SCREEN_BASE = (process.env.SCREEN_BASE_PATH || "/screen").replace(/\/+$/, "");
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const NIRCMD_PATH = process.env.NIRCMD_PATH || "nircmd.exe";
const POLL_INTERVAL_MS = Math.max(500, Number(process.env.WORKER_POLL_INTERVAL_MS) || 1500);
const STATE_FILE = path.join(__dirname, "worker.state.json");

let state = loadState();
let currentVolumePct = typeof state.lastKnownPct === "number" ? state.lastKnownPct : null;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastCommandId: 0, lastKnownPct: null };
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          lastCommandId: state.lastCommandId,
          lastKnownPct: currentVolumePct,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.warn("Failed to persist worker state:", error.message);
  }
}

function headers(contentType = "application/json") {
  const result = {};

  if (contentType) {
    result["content-type"] = contentType;
  }

  if (WORKER_TOKEN) {
    result.authorization = `Bearer ${WORKER_TOKEN}`;
  }

  return result;
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function pctToSystemVolume(pct) {
  return Math.round((pct / 100) * 65535);
}

function clampPct(value, fallback = 50) {
  const pct = Number.parseInt(value, 10);
  if (Number.isNaN(pct)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, pct));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiUrl(pathname) {
  return `${BASE_URL}${SCREEN_BASE}${pathname}`;
}

async function setSystemVolume(pct) {
  const targetPct = clampPct(pct);
  await execFileAsync(NIRCMD_PATH, ["setsysvolume", String(pctToSystemVolume(targetPct))]);
  currentVolumePct = targetPct;
}

async function muteSystemVolume() {
  await execFileAsync(NIRCMD_PATH, ["mutesysvolume", "1"]);
}

async function unmuteSystemVolume() {
  await execFileAsync(NIRCMD_PATH, ["mutesysvolume", "0"]);
}

async function rampSystemVolume(targetPct, duration, from) {
  const safeTarget = clampPct(targetPct);
  const safeDuration = Math.max(100, Number(duration) || 1200);
  const startPct =
    typeof currentVolumePct === "number"
      ? currentVolumePct
      : typeof from === "number"
        ? clampPct(from, safeTarget)
        : safeTarget;

  const steps = Math.max(1, Math.round(safeDuration / 60));

  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const nextPct = Math.round(startPct + (safeTarget - startPct) * progress);
    await setSystemVolume(nextPct);
    if (index < steps) {
      await sleep(Math.round(safeDuration / steps));
    }
  }
}

async function acknowledgeCommand(id, status, errorMessage = null) {
  const response = await fetch(apiUrl(`/api/worker/commands/${id}/ack`), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      status,
      lastKnownPct: currentVolumePct,
      error: errorMessage,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ack failed with ${response.status}`);
  }
}

async function sendHeartbeat() {
  const response = await fetch(apiUrl("/api/worker/heartbeat"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      lastCommandId: state.lastCommandId,
      lastKnownPct: currentVolumePct,
    }),
  });

  if (!response.ok) {
    throw new Error(`Heartbeat failed with ${response.status}`);
  }
}

async function handleCommand(command) {
  switch (command.type) {
    case "setVolume":
      await setSystemVolume(command.payload?.pct);
      break;
    case "mute":
      await muteSystemVolume();
      break;
    case "unmute":
      await unmuteSystemVolume();
      break;
    case "rampVolume":
      await rampSystemVolume(
        command.payload?.targetPct,
        command.payload?.duration,
        command.payload?.from
      );
      break;
    default:
      throw new Error(`Unsupported command type: ${command.type}`);
  }
}

async function pollOnce() {
  const response = await fetch(apiUrl(`/api/worker/commands?since=${state.lastCommandId}`), {
    headers: headers(null),
  });

  if (!response.ok) {
    throw new Error(`Poll failed with ${response.status}`);
  }

  const payload = await response.json();
  const commands = Array.isArray(payload.commands) ? payload.commands : [];

  for (const command of commands) {
    try {
      await handleCommand(command);
      state.lastCommandId = Math.max(state.lastCommandId, command.id);
      saveState();
      await acknowledgeCommand(command.id, "ok");
      console.log(`Command ${command.id} (${command.type}) executed`);
    } catch (error) {
      state.lastCommandId = Math.max(state.lastCommandId, command.id);
      saveState();
      await acknowledgeCommand(command.id, "error", error.message);
      console.error(`Command ${command.id} failed:`, error.message);
    }
  }

  await sendHeartbeat();
}

async function main() {
  if (!BASE_URL) {
    throw new Error("Missing APP_BASE_URL environment variable");
  }

  console.log(`Worker polling ${apiUrl("")} every ${POLL_INTERVAL_MS}ms`);

  while (true) {
    try {
      await pollOnce();
    } catch (error) {
      console.error("Worker loop error:", error.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
