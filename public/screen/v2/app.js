import { VOICE_LINES } from "/screen/v2/voice-lines.js";
import {
  DEMO_DEFAULT_COUNT,
  DEMO_ROSTER,
  SEC,
  computeView,
  createClassMemory,
  demoLobby,
  dueCues,
  hhmm,
  lobbyPollDelayMs,
  hourStartOf,
  hourStartOfIso,
  musicShouldBeLow,
  outputTimeFor,
  sameDayAt,
  voiceFileUrl,
  voiceStatus,
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
  coachLine: (coach) => `Coach ${coach}`, // arriba de los nombres; sin coach el renglón no se muestra
  sessionLabel: "Sesión",
  firstSessionLabel: "Primera sesión",
  gate: { title: "Activar sonido", hint: "Tocá la pantalla o apretá cualquier tecla" },
  soundMuted: "Sin voz",
  soundUnavailable: "Voz no disponible",
  test: { label: "Prueba", clock: "Reloj simulado", demo: "Datos de demo" },
};

// ===== Ajustes =====
const SETTINGS = {
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
  LOBBY_CLASS_MS: 15000, // con una clase en curso (de :10 a :50), para que el que llega tarde aparezca rápido
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
// ?athletes=1..10: how many demo athletes (default 6). Not ?demo=N, because ?demo=1 already means "demo on".
const DEMO_COUNT = clamp(Number.parseInt(params.get("athletes"), 10) || DEMO_DEFAULT_COUNT, 1, DEMO_ROSTER.length);
const MUTE = isTrue(params.get("mute"));
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
  // The class in progress, with its athletes once the portal sends them (`current.athletes`).
  currentFor(classStart, now) {
    if (DEMO) return demoHasClass(classStart) ? demoLobby(classStart, now, DEMO_COUNT) : null;
    const data = portalData();
    if (!data || !data.current || hourStartOfIso(data.current.starts_at) !== classStart) return null;
    return data.current;
  },
  known() {
    return DEMO !== null || portalData() !== null;
  },
};

const VIEW_OPTIONS = {
  namesFromMinute: SETTINGS.NAMES_FROM_MINUTE,
  namesUntilMinute: SETTINGS.NAMES_UNTIL_MINUTE,
  finalCountSeconds: SETTINGS.FINAL_COUNT_SECONDS,
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
  fill: $("fill"),
  lobby: $("lobby"),
  lobbyHead: $("lobbyHead"),
  lobbyTitle: $("lobbyTitle"),
  names: $("names"),
  gate: $("gate"),
  sound: $("sound"),
  testTag: $("testTag"),
};

el.place.textContent = TEXT.place[STUDIO];

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
  if (view.fill !== null) el.fill.style.width = `${(view.fill * 100).toFixed(3)}%`;
  renderNames(view.names);

  if (cut) {
    void body.offsetWidth;
    requestAnimationFrame(() => body.classList.remove("cut"));
    retrigger(body, "go", 900);
  }
  previous = view;
}

// Keyed athlete cards, reordered with a FLIP animation when the server order changes.
// Left to right is the portal order; the session number is the hero of each card.
// From minute 5 (`names.compact`) the same cards become a quiet row of the athletes present.
const ROSTER_MORPH_MS = 900;
const LEAVE_FADE_MS = 450;
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

function fillSlot(li, athlete, rollNumber) {
  const hasNumber = athlete.number !== null;
  li.classList.toggle("no-number", !hasNumber);
  li.classList.toggle("first", athlete.first && hasNumber);
  li.classList.toggle("milestone", athlete.milestone && hasNumber);
  setText(li.querySelector(".tag"), hasNumber ? (athlete.first ? TEXT.firstSessionLabel : TEXT.sessionLabel) : "");
  const sn = li.querySelector(".sn");
  sn.style.setProperty("--sn-digits", String(hasNumber ? String(athlete.finalNumber).length : 1));
  setNumber(sn, hasNumber ? String(athlete.number) : "", rollNumber);
  setText(li.querySelector(".name"), athlete.name);
}

// The number of a card, rolled up digit by digit when the scan adds one (see .digit in style.css).
const NUMBER_ROLL_MS = 600;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function setNumber(sn, value, roll) {
  if (sn.dataset.rollTo !== undefined) {
    if (sn.dataset.rollTo === value) return; // already rolling there
    delete sn.dataset.rollTo;
    sn.textContent = "";
  }
  const from = sn.textContent;
  if (!roll || !from || from === value || reducedMotion.matches) {
    setText(sn, value);
    return;
  }
  const width = Math.max(from.length, value.length);
  sn.replaceChildren(...Array.from({ length: width }, (_, index) => digitCell(from[index] || "", value[index] || "")));
  sn.dataset.rollTo = value;
  setTimeout(() => {
    if (sn.dataset.rollTo !== value) return;
    delete sn.dataset.rollTo;
    sn.textContent = value;
  }, NUMBER_ROLL_MS + 80);
}

function digitCell(oldDigit, newDigit) {
  const cell = document.createElement("span");
  cell.className = "digit";
  if (oldDigit === newDigit) {
    cell.textContent = newDigit;
    return cell;
  }
  const roll = document.createElement("span");
  roll.className = "roll";
  for (const digit of [oldDigit, newDigit]) {
    const face = document.createElement("span");
    // An empty position (9 -> 10) still needs a digit's width: a hidden 0.
    face.textContent = digit || "0";
    if (!digit) face.className = "blank";
    roll.appendChild(face);
  }
  cell.appendChild(roll);
  return cell;
}

function clearSlots() {
  slots.clear();
  el.names.replaceChildren();
  body.classList.remove("roster");
}

function cardParts(li) {
  return [...li.children];
}

function renderNames(names) {
  const key = names ? JSON.stringify([names.classStart, names.coach, names.compact, names.athletes]) : "";
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
  if (!appearing && names.compact && !body.classList.contains("roster")) {
    morphToRoster(names);
    return;
  }
  body.classList.add("has-lobby");
  body.classList.toggle("roster", names.compact);

  const firstBox = new Map();
  if (!appearing) for (const [id, li] of slots) firstBox.set(id, li.getBoundingClientRect());
  updateSlots(names, appearing);

  const moved = [];
  for (const [id, li] of slots) {
    const before = firstBox.get(id);
    if (!before) continue;
    const dx = before.left - li.getBoundingClientRect().left;
    if (Math.abs(dx) < 1) continue;
    li.style.transition = "none";
    li.style.transform = `translateX(${dx}px)`;
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
}

// Cards for these names, in this order. A card that is not wanted any more is removed, unless
// `keepLeaving` takes it (the minute-5 morph fades it out in place).
function updateSlots(names, appearing, keepLeaving = null) {
  setText(el.lobbyTitle, names.coach ? TEXT.coachLine(names.coach) : "");
  el.lobbyHead.classList.toggle("empty", !names.coach);

  const wanted = new Set();
  names.athletes.forEach((athlete, index) => {
    let li = slots.get(athlete.id);
    const isNew = !li;
    if (!li) {
      li = createSlot();
      slots.set(athlete.id, li);
      // On first appearance the cards come in one after another; later (a late arrival in the
      // row), the new card comes in on its own.
      if (appearing || names.compact) {
        li.style.setProperty("--i", String(appearing ? index : 0));
        li.classList.add("enter");
        li.addEventListener("animationend", () => li.classList.remove("enter"), { once: true });
      }
    }
    const wasLit = li.classList.contains("lit");
    const scanning = athlete.lit && !wasLit && !appearing;
    // A card already on the wall rolls its number up at the scan; a late arrival in the row comes
    // in with its final number.
    fillSlot(li, athlete, scanning && !isNew);
    li.classList.toggle("lit", athlete.lit);
    if (scanning) retrigger(li, "ignite", 1000);
    el.names.appendChild(li);
    wanted.add(athlete.id);
  });
  // Every number in the row shares one size, set by the longest number (3 digits fit at full size).
  const digits = Math.max(1, ...names.athletes.map((a) => (a.finalNumber === null ? 0 : String(a.finalNumber).length)));
  el.names.style.setProperty("--digits", String(digits));
  el.lobby.classList.toggle("compact", names.athletes.every((a) => a.number === null));
  for (const [id, li] of slots) {
    if (wanted.has(id)) continue;
    slots.delete(id);
    if (keepLeaving) keepLeaving(li);
    else li.remove();
  }
  fitNames();
}

// Minute 5, one movement: the cards of the athletes present shrink into the row, the absent ones
// fade where they are, the countdown grows. The final layout is applied at once (no CSS
// transitions) and every piece is then animated from where it was to where it is (FLIP).
function morphToRoster(names) {
  const pieces = [el.num, el.lobbyHead];
  for (const li of slots.values()) pieces.push(...cardParts(li));
  const before = new Map(pieces.map((node) => [node, node.getBoundingClientRect()]));
  // Where each card is and how big its text is now: a card leaving the wall keeps both.
  const cardsBefore = new Map(
    [...slots.values()].map((li) => [li, { box: li.getBoundingClientRect(), sizes: cardParts(li).map((part) => getComputedStyle(part).fontSize) }])
  );
  const leaving = [];

  body.classList.add("instant", "morphing");
  body.classList.add("roster");
  updateSlots(names, false, (li) => {
    const { box, sizes } = cardsBefore.get(li);
    cardParts(li).forEach((part, index) => (part.style.fontSize = sizes[index]));
    li.classList.add("leaving");
    leaving.push({ li, box });
  });
  const namesBox = el.names.getBoundingClientRect();
  for (const { li, box } of leaving) {
    Object.assign(li.style, {
      position: "absolute",
      left: `${box.left - namesBox.left}px`,
      top: `${box.top - namesBox.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
  }

  const animated = [];
  for (const [node, from] of before) {
    if (!node.isConnected || node.closest(".leaving")) continue;
    const to = node.getBoundingClientRect();
    if (!to.width || !to.height || !from.height) continue;
    const scale = from.height / to.height;
    if (node === el.num) {
      // Centred text: scale around its centre.
      node.style.transformOrigin = "50% 50%";
      node.style.transform = `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${
        from.top + from.height / 2 - (to.top + to.height / 2)
      }px) scale(${scale})`;
    } else {
      node.style.transformOrigin = "0 0";
      node.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})`;
    }
    animated.push(node);
  }
  void body.offsetWidth;
  body.classList.remove("instant");

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const node of animated) {
        node.style.transition = `transform ${ROSTER_MORPH_MS}ms var(--ease)`;
        node.style.transform = "";
      }
      for (const { li } of leaving) {
        li.style.transition = `opacity ${LEAVE_FADE_MS}ms ease`;
        li.style.opacity = "0";
      }
      setTimeout(() => {
        for (const node of animated) {
          node.style.transition = "";
          node.style.transformOrigin = "";
        }
        for (const { li } of leaving) li.remove();
        body.classList.remove("morphing");
      }, ROSTER_MORPH_MS + 100);
    })
  );
}

// Names are always one line and never cut. Every name in the row shares one size: the largest at
// which the longest name fits its column, capped at the normal size. The «Primera sesión» label
// shrinks on its own (a transform, so its measured width is always the natural one).
function fitText(node, available) {
  const natural = node.scrollWidth;
  node.style.setProperty("--fit", natural > available && natural > 0 ? String(available / natural) : "1");
}

// Each name is measured on a hidden copy at the row's full size, so a font-size transition in
// progress (or the font still loading) never skews the fit.
const nameProbe = document.createElement("li");
nameProbe.className = "athlete probe";
nameProbe.setAttribute("aria-hidden", "true");
nameProbe.innerHTML = '<span class="name"></span>';

function fitNames() {
  if (!nameProbe.isConnected) el.names.appendChild(nameProbe);
  const probeName = nameProbe.firstChild;
  let fit = 1;
  for (const li of slots.values()) {
    const available = li.clientWidth;
    if (!available) continue;
    nameProbe.classList.toggle("no-number", li.classList.contains("no-number"));
    probeName.textContent = li.querySelector(".name").textContent;
    const natural = probeName.scrollWidth;
    if (natural > available) fit = Math.min(fit, available / natural);
    fitText(li.querySelector(".tag"), available);
  }
  el.names.style.setProperty("--name-fit", String(Math.floor(fit * 1000) / 1000));
}

window.addEventListener("resize", () => requestAnimationFrame(fitNames));
document.fonts.addEventListener("loadingdone", () => requestAnimationFrame(fitNames));
document.fonts.ready.then(() => requestAnimationFrame(fitNames));

// ===== Audio =====
const SPEAKER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/></svg>';
const MUTED_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
const VOICE_KEYS = Object.keys(VOICE_LINES);

let audioCtx = null;
const voiceBuffers = new Map();
let voicePreloadDone = false;

function voice() {
  return voiceStatus(VOICE_KEYS, voiceBuffers);
}

// A phrase plays only when every recorded file is decoded (see voiceStatus).
function canSpeak(line) {
  return voice().ready && voiceBuffers.has(line);
}

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

// The recorded files are static (the announcer effect is already in them) and all of them are
// decoded up front, so every cue can be scheduled to the sample.
async function preloadVoice() {
  if (!audioCtx) return;
  for (const key of VOICE_KEYS) {
    if (voiceBuffers.has(key)) continue;
    try {
      const response = await fetch(voiceFileUrl(key));
      if (!response.ok) continue;
      voiceBuffers.set(key, await audioCtx.decodeAudioData(await response.arrayBuffer()));
    } catch {
      // Retried below.
    }
  }
  voicePreloadDone = true;
  updateSoundUi();
  sendHeartbeat();
  if (!voice().ready) setTimeout(preloadVoice, SETTINGS.VOICE_RETRY_MS);
}

function updateSoundUi() {
  const locked = Boolean(audioCtx) && !audioRunning();
  el.gate.hidden = !locked;
  body.classList.toggle("locked", locked);

  let html = "";
  if (MUTE || !audioCtx) html = `${MUTED_ICON}<span>${TEXT.soundMuted}</span>`;
  else if (!locked && voicePreloadDone && !voice().ready) html = `${MUTED_ICON}<span>${TEXT.soundUnavailable}</span>`;
  else if (!locked) html = SPEAKER_ICON;
  if (el.sound.innerHTML !== html) el.sound.innerHTML = html;
}

// ===== Voice scheduling on the Web Audio clock =====
const scheduledCues = new Map();
const playedCues = new Set();
let lastCue = null;
let lastCueAt = null;

// null while the output clock has not started yet (see outputTimeFor).
function contextTimeFor(epoch) {
  if (typeof audioCtx.getOutputTimestamp === "function") {
    return outputTimeFor(epoch, audioCtx.getOutputTimestamp(), epochAtPerf, RATE);
  }
  const latency = audioCtx.outputLatency || audioCtx.baseLatency || 0;
  return audioCtx.currentTime + (epoch - nowMs()) / SEC / RATE - latency;
}

function scheduleVoice(now) {
  if (!audioRunning() || contextTimeFor(now) === null) return;
  const due = dueCues(now, schedule, {
    hasLine: canSpeak,
    lookaheadMs: SETTINGS.VOICE_LOOKAHEAD_MS,
    lateMs: SETTINGS.VOICE_LATE_MS,
    rate: RATE,
  });
  for (const { key, cue, at, classStart } of due) {
    if (scheduledCues.has(key) || playedCues.has(key)) continue;
    const source = audioCtx.createBufferSource();
    source.buffer = voiceBuffers.get(cue.line);
    source.connect(audioCtx.destination);
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
    lineDurationMs: (line) => (audioRunning() && canSpeak(line) ? voiceBuffers.get(line).duration * SEC : null),
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
  return lobbyPollDelayMs(now, schedule.hasClassAt(hourStartOf(now)), {
    fastMs: SETTINGS.LOBBY_FAST_MS,
    classMs: SETTINGS.LOBBY_CLASS_MS,
    slowMs: SETTINGS.LOBBY_SLOW_MS,
    rate: RATE,
  });
}

function sendHeartbeat() {
  if (TEST_MODE || !SCREEN_KEY) return;
  fetch("/screen/api/display/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", ...KEY_HEADERS },
    body: JSON.stringify({
      studio: STUDIO,
      audioUnlocked: audioRunning(),
      voiceReady: voice().ready,
      voiceMissing: voicePreloadDone ? voice().missing : [],
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
    voiceLines: `${voiceBuffers.size}/${VOICE_KEYS.length}`,
    voiceMissing: voicePreloadDone ? voice().missing : [],
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
