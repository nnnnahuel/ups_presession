const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEVICE_ID = process.env.DEVICE_ID;
const LOCATION_ID = process.env.LOCATION_ID;
const SERVER_URL = (process.env.SERVER_URL || process.env.APP_BASE_URL || "https://sesiones.up-s.ar").replace(/\/+$/, "");
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const NIRCMD_PATH = process.env.NIRCMD_PATH || "nircmd.exe";
const HEARTBEAT_INTERVAL_MS = 5000;
const COMMAND_POLL_INTERVAL_MS = 2000;
const STATE_FILE = path.join(__dirname, "worker.state.json");

const persistedState = loadState();
let currentVolumePct = typeof persistedState.lastKnownPct === "number" ? persistedState.lastKnownPct : null;
let registerInFlight = false;
let pollInFlight = false;

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      lastKnownPct: typeof parsed.lastKnownPct === "number" ? parsed.lastKnownPct : null,
    };
  } catch {
    return { lastKnownPct: null };
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
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

async function setSystemVolume(pct) {
  const targetPct = clampPct(pct);
  await execFileAsync(NIRCMD_PATH, ["setsysvolume", String(pctToSystemVolume(targetPct))]);
  currentVolumePct = targetPct;
  saveState();
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

async function setVolume(value) {
  await setSystemVolume(value);
}

async function rampVolume(value) {
  if (value && typeof value === "object") {
    await rampSystemVolume(value.targetPct ?? value.pct ?? value.value, value.duration, value.from);
    return;
  }

  await rampSystemVolume(value);
}

async function registerWorker() {
  const response = await fetch(`${SERVER_URL}/api/worker/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      device_id: DEVICE_ID,
      location_id: LOCATION_ID,
      last_known_volume: currentVolumePct,
    }),
  });

  if (!response.ok) {
    throw new Error(`Register failed with ${response.status}`);
  }
}

async function acknowledgeCommand(commandId, status, errorMessage = null) {
  const response = await fetch(`${SERVER_URL}/api/commands/${commandId}/ack`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      device_id: DEVICE_ID,
      status,
      last_known_volume: currentVolumePct,
      error: errorMessage,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ack failed with ${response.status}`);
  }
}

async function executeCommand(command) {
  switch (command.type) {
    case "volume":
      await setVolume(command.value);
      break;
    case "volume_ramp":
      await rampVolume(command.value);
      break;
    case "mute":
      await muteSystemVolume();
      break;
    case "unmute":
      await unmuteSystemVolume();
      break;
    default:
      throw new Error(`Unsupported command type: ${command.type}`);
  }
}

async function fetchCommands() {
  const response = await fetch(
    `${SERVER_URL}/api/commands?device_id=${encodeURIComponent(DEVICE_ID)}`,
    {
      headers: headers(null),
    }
  );

  if (!response.ok) {
    throw new Error(`Command poll failed with ${response.status}`);
  }

  const commands = await response.json();

  for (const command of Array.isArray(commands) ? commands : []) {
    let executionError = null;

    try {
      await executeCommand(command);
      console.log(`Command ${command.id} (${command.type}) executed`);
    } catch (error) {
      executionError = error;
      console.error(`Command ${command.id} failed:`, error.message);
    }

    try {
      await acknowledgeCommand(
        command.id,
        executionError ? "error" : "ok",
        executionError ? executionError.message : null
      );
    } catch (ackError) {
      console.error(`Command ${command.id} ack failed:`, ackError.message);
    }
  }
}

async function safeRegister() {
  if (registerInFlight) {
    return;
  }

  registerInFlight = true;
  try {
    await registerWorker();
  } catch (error) {
    console.error("Worker register error:", error.message);
  } finally {
    registerInFlight = false;
  }
}

async function safePoll() {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    await fetchCommands();
  } catch (error) {
    console.error("Worker poll error:", error.message);
  } finally {
    pollInFlight = false;
  }
}

async function main() {
  if (!DEVICE_ID) {
    throw new Error("Missing DEVICE_ID environment variable");
  }

  if (!LOCATION_ID) {
    throw new Error("Missing LOCATION_ID environment variable");
  }

  console.log(`Worker ${DEVICE_ID} (${LOCATION_ID}) connected to ${SERVER_URL}`);

  await safeRegister();
  await safePoll();

  setInterval(() => {
    void safeRegister();
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(() => {
    void safePoll();
  }, COMMAND_POLL_INTERVAL_MS);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
