import { VOICE_LINES } from "/screen/v2/voice-lines.js";
import {
  CLASS_END,
  DEMO_DEFAULT_COUNT,
  DEMO_ROSTER,
  MIN,
  SEC,
  computeView,
  createClassMemory,
  demoLobby,
  dueCues,
  hhmm,
  hourStartOf,
  hourStartOfIso,
  musicShouldBeLow,
  sameDayAt,
  wallTime,
} from "/screen/v2/timeline.js";

// ===== Textos de pantalla (las frases de la voz están en voice-lines.js) =====
const TEXT = {
  place: { A: "Estudio A", B: "Estudio B" },
  stages: {
    work: { phase: "", sub: "" }, // minutos 0 a 44: solo la cuenta
    last: { phase: "Últimos 10 minutos", sub: "" },
    done: { phase: "Sesión completa", sub: "Guardá tus elementos y liberá tu lugar" },
    lobby: { phase: (hour) => (hour === 1 ? "Turno de la 1" : `Turno de las ${hour}`), sub: "Escaneá tu QR al entrar" },
  },
  idleNext: (time) => `Próximo turno ${time}`,
  namesTitle: (time, coach) => (coach ? `Turno ${time} · Coach ${coach}` : `Turno ${time}`),
  sessionLabel: "Sesión",
  firstSessionLabel: "Primera sesión",
  // Barra: un tramo por ejercicio («1», «2», …) y el último es el extra.
  segmentLabel: (index, count) => (index === count - 1 ? "Extra" : String(index + 1)),
  gate: { title: "Activar sonido", hint: "Tocá la pantalla o apretá cualquier tecla" },
  soundMuted: "Sin voz",
  soundUnavailable: "Voz no disponible",
  test: { label: "Prueba", clock: "Reloj simulado", demo: "Datos de demo" },
};

// ===== Ajustes =====
const SETTINGS = {
  // Cortes de la barra de abajo, en minutos de la clase: 4 ejercicios y el extra hasta el minuto 55.
  // Solo guían el ritmo: no hay voz en los cortes.
  EXERCISE_CUTS: [15, 25, 35, 45],
  RADIO_FILTER: true, // false = voz limpia, sin filtro de radio
  VOICE_GAIN: 1.15,
  // Las mismas llamadas que usa hoy /screen (public/screen/script.js).
  MUSIC_DOWN_PATH: "/screen/volume/ramp/50?duration=1200&from=88",
  MUSIC_UP_PATH: "/screen/volume/ramp/88?duration=1200",
  MUSIC_RESTORE_MINUTE: 2, // tras «Sesión completa» la música vuelve a subir en este minuto de la clase nueva
  MUSIC_DUCK_LEAD_MS: 3500, // el worker pregunta cada 2 s y la rampa dura 1,2 s
  MUSIC_DUCK_TAIL_MS: 800,
  NAMES_FROM_MINUTE: 57,
  NAMES_UNTIL_MINUTE: 5,
  FINAL_COUNT_SECONDS: 10,
  LOBBY_FAST_MS: 5000, // de :50 a :10
  LOBBY_SLOW_MS: 60000,
  PORTAL_FRESH_MS: 3 * 60 * 1000,
  PORTAL_GRACE_MS: 20 * 1000, // tras un error del portal, cuánto se siguen usando los últimos datos
  HEARTBEAT_MS: 30000,
  VOICE_LOOKAHEAD_MS: 20000,
  VOICE_LATE_MS: 300,
  VOICE_RETRY_MS: 60000,
  CLOCK_SYNC_MIN_MS: 1000, // se corrige el reloj de la notebook solo si está corrido más que esto
  BOOT_WAIT_MS: 1500,
};

// ===== URL =====
const params = new URLSearchParams(location.search);
const STUDIO = (params.get("studio") || "A").trim().toUpperCase() === "B" ? "B" : "A";
const SIM_START = parseClockParam(params.get("now"));
const SPEED = clamp(Number.parseFloat(params.get("speed")) || 1, 0.1, 600);
const SIMULATED = SIM_START !== null || SPEED !== 1;
const DEMO = parseDemoParam(params.get("demo"));
// ?athletes=1..8: how many demo athletes (default 6). Not ?demo=N, because ?demo=1 already means "demo on".
const DEMO_COUNT = clamp(Number.parseInt(params.get("athletes"), 10) || DEMO_DEFAULT_COUNT, 1, DEMO_ROSTER.length);
const MUTE = isTrue(params.get("mute"));
// ?roster=grid: comparison variant, the athletes in two rows with bigger names (all in style.css).
const ROSTER_GRID = params.get("roster") === "grid";
const TEST_MODE = SIMULATED || DEMO !== null; // never touches the studio volume, never sends heartbeats
const RATE = SIMULATED ? SPEED : 1;
// Screen key (?key=...): kept in localStorage so a reload without the parameter still works,
// and sent only as a header. An empty ?key= forgets it.
const SCREEN_KEY = readScreenKey();
const KEY_HEADERS = SCREEN_KEY ? { "x-screen-key": SCREEN_KEY } : {};

function readScreenKey() {
  const storageKey = "ups-screen-v2:key";
  const fromUrl = params.get("key");
  try {
    if (fromUrl === null) return (localStorage.getItem(storageKey) || "").trim();
    const key = fromUrl.trim();
    if (key) localStorage.setItem(storageKey, key);
    else localStorage.removeItem(storageKey);
    return key;
  } catch {
    return (fromUrl || "").trim();
  }
}

function isTrue(value) {
  return value === "1" || value === "true" || value === "";
}

function parseDemoParam(value) {
  if (value === null) return null;
  if (value === "first" || value === "idle") return value;
  return isTrue(value) ? "hourly" : null;
}

function parseClockParam(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
  if (!match) return null;
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  if (h > 23 || m > 59 || s > 59) return null;
  return ((h * 60 + m) * 60 + s) * SEC;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ===== Clock: Argentina wall clock, corrected to server time; simulated in test mode =====
let clockOffset = 0;
const perfAtBoot = performance.now();
const simEpochAtBoot = SIMULATED ? (SIM_START === null ? Date.now() : sameDayAt(Date.now(), SIM_START)) : 0;

function nowMs() {
  if (SIMULATED) return simEpochAtBoot + (performance.now() - perfAtBoot) * RATE;
  return Date.now() + clockOffset;
}

function epochAtPerf(perfTime) {
  return nowMs() - (performance.now() - perfTime) * RATE;
}

// ===== Class schedule: portal bridge or demo =====
const portal = { data: null, okAt: 0, lastOk: false, answered: false };
const STORAGE_KEY = `ups-screen-v2:classes:${STUDIO}`;
const classMemory = createClassMemory(loadStoredClasses());
const demoFirstHour = hourStartOf(nowMs());

function loadStoredClasses() {
  if (TEST_MODE) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function storeClasses() {
  if (TEST_MODE) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(classMemory.list()));
  } catch {
    // Storage can be blocked; memory is enough while the page stays open.
  }
}

function portalData() {
  if (!portal.data) return null;
  const age = performance.now() - portal.okAt;
  return age < (portal.lastOk ? SETTINGS.PORTAL_FRESH_MS : SETTINGS.PORTAL_GRACE_MS) ? portal.data : null;
}

function demoHasClass(classStart) {
  if (DEMO === "idle") return false;
  if (DEMO === "first") return classStart > demoFirstHour;
  return true;
}

const schedule = {
  // Without portal data the screen behaves as today: a class every hour, no names.
  hasClassAt(classStart) {
    if (DEMO) return demoHasClass(classStart);
    if (!portalData()) return true;
    return classMemory.has(classStart);
  },
  lobbyFor(classStart, now) {
    if (DEMO) return demoHasClass(classStart) ? demoLobby(classStart, now, DEMO_COUNT) : null;
    const data = portalData();
    if (!data || !data.lobby || hourStartOfIso(data.lobby.starts_at) !== classStart) return null;
    return data.lobby;
  },
  known() {
    return DEMO !== null || portalData() !== null;
  },
};

const VIEW_OPTIONS = {
  namesFromMinute: SETTINGS.NAMES_FROM_MINUTE,
  namesUntilMinute: SETTINGS.NAMES_UNTIL_MINUTE,
  finalCountSeconds: SETTINGS.FINAL_COUNT_SECONDS,
  exerciseCuts: SETTINGS.EXERCISE_CUTS,
};

// ===== Rendering =====
const $ = (id) => document.getElementById(id);
const body = document.body;
const el = {
  place: $("place"),
  clock: $("clock"),
  phase: $("phase"),
  num: $("num"),
  sub: $("sub"),
  bar: $("bar"),
  legend: $("legend"),
  lobby: $("lobby"),
  lobbyTitle: $("lobbyTitle"),
  names: $("names"),
  gate: $("gate"),
  sound: $("sound"),
  testTag: $("testTag"),
  flash: $("flash"),
};

el.place.textContent = TEXT.place[STUDIO];
body.classList.toggle("roster-grid", ROSTER_GRID);

// Progress bar: one segment per exercise plus the extra, sized by its minutes.
const CLASS_MINUTES = CLASS_END / MIN;
const segmentBounds = [0, ...SETTINGS.EXERCISE_CUTS, CLASS_MINUTES];
const segments = segmentBounds.slice(1).map((end, index) => {
  const start = segmentBounds[index];
  const track = document.createElement("div");
  track.className = "seg";
  track.style.flexGrow = String(end - start);
  const fill = document.createElement("i");
  track.appendChild(fill);
  const label = document.createElement("span");
  label.style.flexGrow = String(end - start);
  label.textContent = TEXT.segmentLabel(index, segmentBounds.length - 1);
  el.bar.appendChild(track);
  el.legend.appendChild(label);
  return { start, end, track, fill, label };
});

function renderBar(view) {
  if (view.fill !== null) {
    const minutes = view.fill * CLASS_MINUTES;
    for (const seg of segments) {
      const part = clamp((minutes - seg.start) / (seg.end - seg.start), 0, 1);
      seg.fill.style.width = `${(part * 100).toFixed(3)}%`;
    }
  }
  segments.forEach((seg, index) => {
    seg.track.classList.toggle("on", index === view.step);
    seg.label.classList.toggle("on", index === view.step);
  });
}
$("gateTitle").textContent = TEXT.gate.title;
$("gateHint").textContent = TEXT.gate.hint;
if (TEST_MODE) {
  const tag = [TEXT.test.label];
  if (SIMULATED) tag.push(`${TEXT.test.clock}${RATE !== 1 ? ` ×${RATE}` : ""}`);
  if (DEMO) tag.push(TEXT.test.demo);
  el.testTag.textContent = tag.join(" · ");
}

function textsFor(view) {
  if (view.stage === "lobby") {
    return { phase: TEXT.stages.lobby.phase(wallTime(view.nextClassStart).h), sub: TEXT.stages.lobby.sub };
  }
  if (view.stage) return TEXT.stages[view.stage];
  const sub = view.nextClassStart !== null && schedule.known() ? TEXT.idleNext(hhmm(view.nextClassStart)) : "";
  return { phase: "", sub };
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function retrigger(node, className, removeAfterMs = 0) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  if (removeAfterMs) setTimeout(() => node.classList.remove(className), removeAfterMs);
}

let previous = null;

function render(view) {
  const before = previous || {};
  // :00 — from the white «Sesión completa» (or the black lobby) straight to the new class, no fade.
  const cut = (before.mode === "done" || before.mode === "lobby") && view.mode === "class";
  if (cut) body.classList.add("cut");

  body.classList.toggle("inv", view.inverted);
  body.classList.toggle("last", view.last);
  body.classList.toggle("final", view.final);
  body.classList.toggle("no-bar", view.fill === null);
  for (const mode of ["idle", "class", "done", "lobby"]) body.classList.toggle(`mode-${mode}`, view.mode === mode);

  const texts = textsFor(view);
  // Without a title or subtitle the countdown sits alone in the middle.
  body.classList.toggle("no-phase", !texts.phase);
  body.classList.toggle("no-sub", !texts.sub);
  setText(el.clock, view.clock);
  setText(el.phase, texts.phase);
  setText(el.sub, texts.sub);
  if (view.num !== before.num) {
    el.num.textContent = view.num;
    if (view.final) retrigger(el.num, "tick");
    else el.num.classList.remove("tick");
  }
  renderBar(view);
  renderNames(view.names);

  if (cut) {
    void body.offsetWidth;
    requestAnimationFrame(() => body.classList.remove("cut"));
    retrigger(body, "go", 900);
    if (before.mode === "lobby") retrigger(el.flash, "on", 700);
  }
  previous = view;
}

// Keyed athlete cards, reordered with a FLIP animation when the server order changes.
// Left to right is the portal order; the session number is the hero of each card.
const slots = new Map();
let namesKey = "";
let namesShown = false;
let namesClearTimer = 0;

function createSlot() {
  const li = document.createElement("li");
  li.className = "athlete";
  li.innerHTML = '<span class="tag"></span><span class="sn"></span><span class="name"></span>';
  return li;
}

function fillSlot(li, athlete) {
  const hasNumber = athlete.number !== null;
  li.classList.toggle("no-number", !hasNumber);
  li.classList.toggle("first", athlete.first && hasNumber);
  li.classList.toggle("milestone", athlete.milestone && hasNumber);
  setText(li.querySelector(".tag"), hasNumber ? (athlete.first ? TEXT.firstSessionLabel : TEXT.sessionLabel) : "");
  setText(li.querySelector(".sn"), hasNumber ? String(athlete.number) : "");
  setText(li.querySelector(".name"), athlete.name);
}

function clearSlots() {
  slots.clear();
  el.names.replaceChildren();
}

function renderNames(names) {
  const key = names ? JSON.stringify([names.classStart, names.coach, names.athletes]) : "";
  if (key === namesKey) return;
  namesKey = key;

  if (!names) {
    if (namesShown) {
      namesShown = false;
      body.classList.remove("has-lobby");
      namesClearTimer = setTimeout(clearSlots, 900);
    }
    return;
  }

  clearTimeout(namesClearTimer);
  const appearing = !namesShown;
  if (appearing) clearSlots();
  namesShown = true;
  body.classList.add("has-lobby");
  setText(el.lobbyTitle, TEXT.namesTitle(hhmm(names.classStart), names.coach));

  const firstBox = new Map();
  if (!appearing) for (const [id, li] of slots) firstBox.set(id, li.getBoundingClientRect());

  const wanted = new Set();
  names.athletes.forEach((athlete, index) => {
    let li = slots.get(athlete.id);
    if (!li) {
      li = createSlot();
      slots.set(athlete.id, li);
      if (appearing) {
        li.style.setProperty("--i", String(index));
        li.classList.add("enter");
        li.addEventListener("animationend", () => li.classList.remove("enter"), { once: true });
      }
    }
    fillSlot(li, athlete);
    const wasLit = li.classList.contains("lit");
    li.classList.toggle("lit", athlete.lit);
    if (athlete.lit && !wasLit && !appearing) retrigger(li, "ignite", 1000);
    el.names.appendChild(li);
    wanted.add(athlete.id);
  });
  // Every number in the row shares one size, set by the longest number (3 digits fit at full size).
  const digits = Math.max(1, ...names.athletes.map((a) => (a.number === null ? 0 : String(a.number).length)));
  el.names.style.setProperty("--digits", String(digits));
  el.lobby.classList.toggle("compact", names.athletes.every((a) => a.number === null));
  for (const [id, li] of slots) {
    if (!wanted.has(id)) {
      li.remove();
      slots.delete(id);
    }
  }

  const moved = [];
  for (const [id, li] of slots) {
    const before = firstBox.get(id);
    if (!before) continue;
    const now = li.getBoundingClientRect();
    const dx = before.left - now.left;
    const dy = before.top - now.top; // only in the grid, when a card changes rows
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    li.style.transition = "none";
    li.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(li);
  }
  if (moved.length) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const li of moved) {
          li.style.transition = "";
          li.style.transform = "";
        }
      })
    );
  }
  fitNames();
}

// Names are always one line and never cut. Every name in the row shares one size: the largest at
// which the longest name fits its column, capped at the normal size. The «Primera sesión» label
// shrinks on its own (a transform, so its measured width is always the natural one).
function fitText(node, available) {
  const natural = node.scrollWidth;
  node.style.setProperty("--fit", natural > available && natural > 0 ? String(available / natural) : "1");
}

function fitNames() {
  el.names.style.setProperty("--name-fit", "1");
  let fit = 1;
  for (const li of slots.values()) {
    const available = li.clientWidth;
    if (!available) continue;
    const natural = li.querySelector(".name").scrollWidth;
    if (natural > available) fit = Math.min(fit, available / natural);
    fitText(li.querySelector(".tag"), available);
  }
  el.names.style.setProperty("--name-fit", String(Math.floor(fit * 1000) / 1000));
}

window.addEventListener("resize", () => requestAnimationFrame(fitNames));
document.fonts.addEventListener("loadingdone", () => requestAnimationFrame(fitNames));

// ===== Audio =====
const SPEAKER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/></svg>';
const MUTED_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
const LINE_COUNT = Object.keys(VOICE_LINES).length;

let audioCtx = null;
let voiceInput = null;
const voiceBuffers = new Map();
let voicePreloadDone = false;

function initAudio() {
  if (MUTE) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    audioCtx = new AudioContextClass({ latencyHint: "playback" });
  } catch {
    audioCtx = null;
    return;
  }
  voiceInput = buildVoiceChain(audioCtx);
  audioCtx.addEventListener("statechange", onAudioStateChange);
  for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, unlockAudio, { passive: true });
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
}

function unlockAudio() {
  if (audioCtx && audioCtx.state !== "running") audioCtx.resume().then(onAudioStateChange, () => {});
}

function audioRunning() {
  return Boolean(audioCtx) && audioCtx.state === "running";
}

function onAudioStateChange() {
  updateSoundUi();
  sendHeartbeat();
}

// Subtle radio/announcer colour: band-limited, a little presence, soft drive, compressed.
function buildVoiceChain(ctx) {
  const output = ctx.createGain();
  output.gain.value = SETTINGS.VOICE_GAIN;
  output.connect(ctx.destination);
  if (!SETTINGS.RADIO_FILTER) return output;

  const filter = (type, frequency, q, gain = 0) => {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    node.gain.value = gain;
    return node;
  };
  const highpass = filter("highpass", 170, 0.7);
  const presence = filter("peaking", 2600, 0.9, 3);
  const lowpass = filter("lowpass", 6800, 0.7);
  const drive = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
  }
  drive.curve = curve;
  drive.oversample = "2x";
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.knee.value = 10;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.2;

  highpass.connect(presence).connect(lowpass).connect(drive).connect(compressor).connect(output);
  return highpass;
}

async function preloadVoice() {
  if (!audioCtx) return;
  for (const [key, text] of Object.entries(VOICE_LINES)) {
    if (voiceBuffers.has(key)) continue;
    try {
      const response = await fetch("/screen/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) continue;
      voiceBuffers.set(key, await audioCtx.decodeAudioData(await response.arrayBuffer()));
    } catch {
      // Retried below.
    }
  }
  voicePreloadDone = true;
  updateSoundUi();
  sendHeartbeat();
  if (voiceBuffers.size < LINE_COUNT) setTimeout(preloadVoice, SETTINGS.VOICE_RETRY_MS);
}

function updateSoundUi() {
  const locked = Boolean(audioCtx) && !audioRunning();
  el.gate.hidden = !locked;
  body.classList.toggle("locked", locked);

  let html = "";
  if (MUTE || !audioCtx) html = `${MUTED_ICON}<span>${TEXT.soundMuted}</span>`;
  else if (!locked && voicePreloadDone && voiceBuffers.size < LINE_COUNT) html = `${MUTED_ICON}<span>${TEXT.soundUnavailable}</span>`;
  else if (!locked) html = SPEAKER_ICON;
  if (el.sound.innerHTML !== html) el.sound.innerHTML = html;
}

// ===== Voice scheduling on the Web Audio clock =====
const scheduledCues = new Map();
const playedCues = new Set();
let lastCue = null;
let lastCueAt = null;

function contextTimeFor(epoch) {
  const stamp = typeof audioCtx.getOutputTimestamp === "function" ? audioCtx.getOutputTimestamp() : null;
  if (stamp && stamp.performanceTime > 0) {
    // contextTime is the sample leaving the speakers at performanceTime: output latency included.
    return stamp.contextTime + (epoch - epochAtPerf(stamp.performanceTime)) / SEC / RATE;
  }
  const latency = audioCtx.outputLatency || audioCtx.baseLatency || 0;
  return audioCtx.currentTime + (epoch - nowMs()) / SEC / RATE - latency;
}

function scheduleVoice(now) {
  if (!audioRunning()) return;
  const due = dueCues(now, schedule, {
    hasLine: (line) => voiceBuffers.has(line),
    lookaheadMs: SETTINGS.VOICE_LOOKAHEAD_MS,
    lateMs: SETTINGS.VOICE_LATE_MS,
    rate: RATE,
  });
  for (const { key, cue, at, classStart } of due) {
    if (scheduledCues.has(key) || playedCues.has(key)) continue;
    const source = audioCtx.createBufferSource();
    source.buffer = voiceBuffers.get(cue.line);
    source.connect(voiceInput);
    const startAt = Math.max(audioCtx.currentTime, contextTimeFor(at));
    source.start(startAt);
    source.onended = () => source.disconnect();
    const timer = setTimeout(() => {
      scheduledCues.delete(key);
      playedCues.add(key);
      lastCue = cue.id;
      lastCueAt = new Date(at).toISOString();
    }, Math.max(0, (startAt - audioCtx.currentTime) * SEC));
    scheduledCues.set(key, { source, timer, at, classStart });
  }

  // A cue whose class disappeared (the portal changed its mind) is cancelled before it plays.
  for (const [key, item] of scheduledCues) {
    if (item.at - now > 150 * RATE && !schedule.hasClassAt(item.classStart)) cancelCue(key, item);
  }
  if (playedCues.size > 200) playedCues.clear();
}

function cancelCue(key, item) {
  clearTimeout(item.timer);
  try {
    item.source.stop();
  } catch {
    // Already stopped.
  }
  item.source.disconnect();
  scheduledCues.delete(key);
}

function rescheduleVoice() {
  const now = nowMs();
  for (const [key, item] of scheduledCues) {
    if (item.at - now > 150) cancelCue(key, item);
  }
}

// ===== Studio music volume (real clock only) =====
let musicLowSent = false;

function controlMusic(now) {
  if (TEST_MODE) return;
  const low = musicShouldBeLow(now, schedule, {
    lineDurationMs: (line) => (audioRunning() && voiceBuffers.has(line) ? voiceBuffers.get(line).duration * SEC : null),
    leadMs: SETTINGS.MUSIC_DUCK_LEAD_MS,
    tailMs: SETTINGS.MUSIC_DUCK_TAIL_MS,
    restoreMinute: SETTINGS.MUSIC_RESTORE_MINUTE,
  });
  if (low === musicLowSent) return;
  musicLowSent = low;
  fetch(low ? SETTINGS.MUSIC_DOWN_PATH : SETTINGS.MUSIC_UP_PATH, { cache: "no-store" }).catch(() => {});
}

// ===== Server: lobby bridge, clock sync, heartbeat =====
const clockSamples = [];

function absorbServerTime(serverTime, sentAt, receivedAt) {
  if (SIMULATED) return;
  const server = Date.parse(serverTime);
  const roundTrip = receivedAt - sentAt;
  if (!Number.isFinite(server) || roundTrip > 800) return;
  const localAtMidpoint = Date.now() - (performance.now() - (sentAt + receivedAt) / 2);
  clockSamples.push({ roundTrip, offset: server - localAtMidpoint });
  if (clockSamples.length > 8) clockSamples.shift();
  const best = clockSamples.reduce((a, b) => (b.roundTrip < a.roundTrip ? b : a));
  const next = Math.abs(best.offset) >= SETTINGS.CLOCK_SYNC_MIN_MS ? Math.round(best.offset) : 0;
  if (Math.abs(next - clockOffset) > 250) {
    clockOffset = next;
    rescheduleVoice();
  }
}

async function pollLobby() {
  const sentAt = performance.now();
  try {
    const response = await fetch(`/screen/api/lobby?studio=${STUDIO}`, { cache: "no-store", headers: KEY_HEADERS });
    const data = await response.json();
    const receivedAt = performance.now();
    absorbServerTime(data.serverTime, sentAt, receivedAt);
    if (response.ok && data && data.ok === true) {
      portal.data = data;
      portal.okAt = receivedAt;
      portal.lastOk = true;
      classMemory.absorb(data, nowMs());
      storeClasses();
    } else {
      portal.lastOk = false;
    }
  } catch {
    portal.lastOk = false;
  }
  portal.answered = true;
  dirty = true;
  setTimeout(pollLobby, nextLobbyDelay());
}

function nextLobbyDelay() {
  const now = nowMs();
  const intoHour = now - hourStartOf(now);
  if (intoHour >= 50 * MIN || intoHour < 10 * MIN) return SETTINGS.LOBBY_FAST_MS;
  return clamp((50 * MIN - intoHour) / RATE, 1000, SETTINGS.LOBBY_SLOW_MS);
}

function sendHeartbeat() {
  if (TEST_MODE || !SCREEN_KEY) return;
  fetch("/screen/api/display/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", ...KEY_HEADERS },
    body: JSON.stringify({
      studio: STUDIO,
      audioUnlocked: audioRunning(),
      voiceReady: voiceBuffers.size === LINE_COUNT,
      lastCue,
      lastCueAt,
    }),
    keepalive: true,
  }).catch(() => {});
}

// Read-only snapshot for checking the wall screen from DevTools: upsScreen.status()
window.upsScreen = {
  status: () => ({
    studio: STUDIO,
    now: new Date(nowMs()).toISOString(),
    testMode: TEST_MODE,
    screenKey: SCREEN_KEY ? "set" : "missing",
    clockOffsetMs: clockOffset,
    audio: audioCtx ? audioCtx.state : "off",
    voiceLines: `${voiceBuffers.size}/${LINE_COUNT}`,
    scheduledCues: [...scheduledCues.keys()],
    lastCue,
    lastCueAt,
    musicLow: musicLowSent,
    portal: portalData() ? "ok" : portal.answered ? "fallback" : "waiting",
    knownClasses: classMemory.list().map((epoch) => new Date(epoch).toISOString()),
  }),
};

// ===== Loops =====
let dirty = true;
let lastSecond = -1;
let booted = false;

function renderTick() {
  if (!booted) return;
  const now = nowMs();
  const second = Math.floor(now / SEC);
  if (dirty || second !== lastSecond) {
    dirty = false;
    lastSecond = second;
    render(computeView(now, schedule, VIEW_OPTIONS));
  }
}

// requestAnimationFrame lands each second on time; the 250 ms loop keeps the
// screen updating even if the browser stops animation frames.
function frame() {
  renderTick();
  requestAnimationFrame(frame);
}

function control() {
  if (!booted) return;
  renderTick();
  const now = nowMs();
  scheduleVoice(now);
  controlMusic(now);
}

function revealFrame() {
  body.classList.remove("booting");
}

async function boot() {
  initAudio();
  updateSoundUi();
  if (audioCtx) preloadVoice();
  if (!DEMO) pollLobby();

  // Wait a moment for the brand font and the first lobby answer, so the first
  // frame already shows the right state with the right digits.
  const fontReady = document.fonts.load('700 100px "UP.S Numeral"').catch(() => {});
  const lobbyReady = new Promise((resolve) => {
    if (DEMO) return resolve();
    const check = () => (portal.answered ? resolve() : setTimeout(check, 50));
    check();
  });
  await Promise.race([Promise.all([fontReady, lobbyReady]), new Promise((r) => setTimeout(r, SETTINGS.BOOT_WAIT_MS))]);

  booted = true;
  dirty = true;
  // The first frame snaps into place (no transitions while booting), then fades in.
  renderTick();
  requestAnimationFrame(() => requestAnimationFrame(revealFrame));
  setTimeout(revealFrame, 1000);
  setInterval(control, 250);
  if (!TEST_MODE) {
    sendHeartbeat();
    setInterval(sendHeartbeat, SETTINGS.HEARTBEAT_MS);
  }
}

document.addEventListener("visibilitychange", () => {
  dirty = true;
});

requestAnimationFrame(frame);
boot();
