const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEVICE_ID = process.env.DEVICE_ID;
const LOCATION_ID = process.env.LOCATION_ID;
const SERVER_URL = (process.env.SERVER_URL || process.env.APP_BASE_URL || "https://sesiones.up-s.ar").replace(/\/+$/, "");
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const NIRCMD_PATH = process.env.NIRCMD_PATH || "nircmd.exe";
// Optional. With MUSIC_PROCESS (for example Spotify.exe) the volume commands change only that
// program in the Windows volume mixer, so the screen's voice (played by the browser) keeps its
// level. Without it they change the Windows master volume, as they always did.
const MUSIC_PROCESS = String(process.env.MUSIC_PROCESS || "").trim();
// Optional, only with MUSIC_PROCESS: the master volume is set to this once at start-up and left alone.
const SYSTEM_VOLUME_PCT = String(process.env.SYSTEM_VOLUME_PCT || "").trim();
const HEARTBEAT_INTERVAL_MS = 5000;
const COMMAND_POLL_INTERVAL_MS = 2000;
const STATE_FILE = path.join(__dirname, "worker.state.json");

let registerInFlight = false;
let pollInFlight = false;

// What the volume commands move: "master" or "app:<process>". Saved with lastKnownPct so that a
// level remembered for one target is not used as the starting point of a ramp on the other.
function volumeTarget(musicProcess) {
  return musicProcess ? `app:${musicProcess}` : "master";
}

function loadState(target) {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const savedTarget = typeof parsed.target === "string" ? parsed.target : "master";
    return {
      lastKnownPct: savedTarget === target && typeof parsed.lastKnownPct === "number" ? parsed.lastKnownPct : null,
    };
  } catch {
    return { lastKnownPct: null };
  }
}

function saveState(lastKnownPct, target) {
  try {
    const state = { lastKnownPct };
    if (target !== "master") state.target = target;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
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

// nircmd setappvolume takes 0..1 (0.5 = 50%).
function pctToAppVolume(pct) {
  return String(Math.round(pct) / 100);
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

// The volume the commands control. runNircmd(args) runs NirCmd; tests pass a fake.
// NirCmd syntax (nirsoft.net/utils/nircmd2.html): setsysvolume 0..65535, mutesysvolume 1|0,
// setappvolume <process> 0..1, muteappvolume <process> 1|0 (the app commands need NirCmd 2.50+).
function createVolumeControl({ runNircmd, musicProcess = "", initialPct = null, onChange = () => {}, wait = sleep }) {
  const app = String(musicProcess || "").trim();
  let currentPct = typeof initialPct === "number" ? initialPct : null;

  const setArgs = (pct) => (app ? ["setappvolume", app, pctToAppVolume(pct)] : ["setsysvolume", String(pctToSystemVolume(pct))]);
  const muteArgs = (mode) => (app ? ["muteappvolume", app, mode] : ["mutesysvolume", mode]);

  async function set(pct) {
    const targetPct = clampPct(pct);
    await runNircmd(setArgs(targetPct));
    currentPct = targetPct;
    onChange(currentPct);
  }

  async function ramp(targetPct, duration, from) {
    const safeTarget = clampPct(targetPct);
    const safeDuration = Math.max(100, Number(duration) || 1200);
    const startPct =
      typeof currentPct === "number"
        ? currentPct
        : typeof from === "number"
          ? clampPct(from, safeTarget)
          : safeTarget;

    const steps = Math.max(1, Math.round(safeDuration / 60));

    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const nextPct = Math.round(startPct + (safeTarget - startPct) * progress);
      await set(nextPct);
      if (index < steps) {
        await wait(Math.round(safeDuration / steps));
      }
    }
  }

  return {
    target: volumeTarget(app),
    get currentPct() {
      return currentPct;
    },
    set,
    async ramp(value) {
      if (value && typeof value === "object") {
        await ramp(value.targetPct ?? value.pct ?? value.value, value.duration, value.from);
        return;
      }

      await ramp(value);
    },
    mute: () => runNircmd(muteArgs("1")),
    unmute: () => runNircmd(muteArgs("0")),
    // Music mode only: leave the master volume at a known level (and unmuted) once at start-up,
    // so nothing inherited from the master-volume mode keeps the voice low.
    async applyStartupSystemVolume(systemVolumePct) {
      if (!app || systemVolumePct === "" || systemVolumePct === null || systemVolumePct === undefined) return null;
      const pct = clampPct(systemVolumePct, null);
      if (pct === null) return null;
      await runNircmd(["setsysvolume", String(pctToSystemVolume(pct))]);
      await runNircmd(["mutesysvolume", "0"]);
      return pct;
    },
  };
}

function describeVolumeMode(musicProcess, systemVolumePct) {
  if (!musicProcess) {
    return [
      "Volumen: maestro de Windows (modo de siempre). Las órdenes de la pantalla bajan la música y también la voz.",
      ...(systemVolumePct ? ["SYSTEM_VOLUME_PCT se ignora sin MUSIC_PROCESS."] : []),
    ];
  }
  const masterPct = systemVolumePct ? clampPct(systemVolumePct, null) : null;
  return [
    `Volumen: solo la música (${musicProcess}) en el mezclador de Windows. La voz de la pantalla no baja.`,
    "Hace falta NirCmd 2.50 o más nuevo (setappvolume/muteappvolume).",
    masterPct === null
      ? `Volumen maestro de Windows: no se toca${systemVolumePct ? ` (SYSTEM_VOLUME_PCT="${systemVolumePct}" no es un número)` : ""}.`
      : `Volumen maestro de Windows: se pone una vez en ${masterPct} % al arrancar y no se vuelve a tocar.`,
  ];
}

async function executeCommand(command, volume) {
  switch (command.type) {
    case "volume":
      await volume.set(command.value);
      break;
    case "volume_ramp":
      await volume.ramp(command.value);
      break;
    case "mute":
      await volume.mute();
      break;
    case "unmute":
      await volume.unmute();
      break;
    default:
      throw new Error(`Unsupported command type: ${command.type}`);
  }
}

async function registerWorker(volume) {
  const response = await fetch(`${SERVER_URL}/api/worker/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      device_id: DEVICE_ID,
      location_id: LOCATION_ID,
      last_known_volume: volume.currentPct,
    }),
  });

  if (!response.ok) {
    throw new Error(`Register failed with ${response.status}`);
  }
}

async function acknowledgeCommand(volume, commandId, status, errorMessage = null) {
  const response = await fetch(`${SERVER_URL}/api/commands/${commandId}/ack`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      device_id: DEVICE_ID,
      status,
      last_known_volume: volume.currentPct,
      error: errorMessage,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ack failed with ${response.status}`);
  }
}

async function fetchCommands(volume) {
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
      await executeCommand(command, volume);
      console.log(`Command ${command.id} (${command.type}) executed`);
    } catch (error) {
      executionError = error;
      console.error(`Command ${command.id} failed:`, error.message);
    }

    try {
      await acknowledgeCommand(
        volume,
        command.id,
        executionError ? "error" : "ok",
        executionError ? executionError.message : null
      );
    } catch (ackError) {
      console.error(`Command ${command.id} ack failed:`, ackError.message);
    }
  }
}

async function safeRegister(volume) {
  if (registerInFlight) {
    return;
  }

  registerInFlight = true;
  try {
    await registerWorker(volume);
  } catch (error) {
    console.error("Worker register error:", error.message);
  } finally {
    registerInFlight = false;
  }
}

async function safePoll(volume) {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    await fetchCommands(volume);
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

  const target = volumeTarget(MUSIC_PROCESS);
  const volume = createVolumeControl({
    runNircmd: (args) => execFileAsync(NIRCMD_PATH, args),
    musicProcess: MUSIC_PROCESS,
    initialPct: loadState(target).lastKnownPct,
    onChange: (pct) => saveState(pct, target),
  });

  console.log(`Worker ${DEVICE_ID} (${LOCATION_ID}) connected to ${SERVER_URL}`);
  for (const line of describeVolumeMode(MUSIC_PROCESS, SYSTEM_VOLUME_PCT)) console.log(line);

  try {
    await volume.applyStartupSystemVolume(SYSTEM_VOLUME_PCT);
  } catch (error) {
    console.error("Could not set the master volume at start-up:", error.message);
  }

  await safeRegister(volume);
  await safePoll(volume);

  setInterval(() => {
    void safeRegister(volume);
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(() => {
    void safePoll(volume);
  }, COMMAND_POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { createVolumeControl, describeVolumeMode, executeCommand, pctToAppVolume, pctToSystemVolume, volumeTarget };
