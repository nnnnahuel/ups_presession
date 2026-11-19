// Pure timing logic of /screen/v2: no DOM, no network, no audio.
// app.js feeds it the clock and the class schedule; tests/screen-v2.test.mjs checks it.

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const CLASS_END = 55 * MIN;
export const LAST_STRETCH = 45 * MIN; // «Quedan 10 minutos»: the number turns #04afdd and the voice says it
export const TZ = "America/Argentina/Buenos_Aires";

// Voice cues, relative to the start of the class they belong to. Each plays a recorded file.
// «start», «minute45» and «end» open with a 0.4 s electronic chime and the voice comes in at 0.8 s;
// «start» fires 0.3 s early so the chime lands just before :00 and the voice about 0.5 s after it.
export const START_LEAD_MS = 300;
export const CUES = [
  { id: "count5", line: "count5", offset: -5 * SEC },
  { id: "count4", line: "count4", offset: -4 * SEC },
  { id: "count3", line: "count3", offset: -3 * SEC },
  { id: "count2", line: "count2", offset: -2 * SEC },
  { id: "count1", line: "count1", offset: -1 * SEC },
  { id: "start", line: "start", offset: -START_LEAD_MS },
  { id: "minute45", line: "minute45", offset: LAST_STRETCH },
  { id: "end", line: "end", offset: CLASS_END },
];

// ===== Argentina wall clock =====
const tzFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});
let tzCache = { minute: Number.NaN, offset: 0 };

export function tzOffset(epoch) {
  const minute = Math.floor(epoch / MIN);
  if (minute === tzCache.minute) return tzCache.offset;
  const parts = {};
  for (const part of tzFormat.formatToParts(new Date(epoch))) parts[part.type] = part.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  tzCache = { minute, offset: Math.round((asUtc - epoch) / MIN) * MIN };
  return tzCache.offset;
}

export function wallTime(epoch) {
  const date = new Date(epoch + tzOffset(epoch));
  return { h: date.getUTCHours(), m: date.getUTCMinutes(), s: date.getUTCSeconds() };
}

export function hourStartOf(epoch) {
  const offset = tzOffset(epoch);
  return Math.floor((epoch + offset) / HOUR) * HOUR - offset;
}

export function hourStartOfIso(value) {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? hourStartOf(epoch) : Number.NaN;
}

// Epoch of a wall-clock time (ms since local midnight) on the same Argentina day as `reference`.
export function sameDayAt(reference, msIntoDay) {
  const offset = tzOffset(reference);
  return Math.floor((reference + offset) / DAY) * DAY + msIntoDay - offset;
}

export const pad = (n) => String(n).padStart(2, "0");
export const mmss = (seconds) => `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
export function hhmm(epoch) {
  const t = wallTime(epoch);
  return `${pad(t.h)}:${pad(t.m)}`;
}

// ===== Which hours have a class =====
// The portal reports `current` only until :55, so the screen remembers the
// hours it saw with a class to know at :55-:59 that one just ended.
export function createClassMemory(initial = []) {
  const hours = new Set(initial.filter(Number.isFinite));
  return {
    has: (classStart) => hours.has(classStart),
    list: () => [...hours],
    absorb(data, now) {
      for (const slot of [data.current, data.lobby]) {
        const start = slot ? hourStartOfIso(slot.starts_at) : Number.NaN;
        if (Number.isFinite(start)) hours.add(start);
      }
      // Inside its lobby window the portal is authoritative: a class it no longer lists was cancelled.
      const lobbyStart = data.lobby ? hourStartOfIso(data.lobby.starts_at) : Number.NaN;
      for (const start of [...hours]) {
        if (start < now - 3 * HOUR) hours.delete(start);
        else if (start > now - 9 * MIN && start <= now + 14 * MIN && start !== lobbyStart) hours.delete(start);
      }
    },
  };
}

// ===== What the screen shows =====
function namesFor(schedule, classStart, now) {
  const lobby = schedule.lobbyFor(classStart, now);
  if (!lobby || !Array.isArray(lobby.athletes) || lobby.athletes.length === 0) return null;
  const seen = new Set();
  const athletes = lobby.athletes.map((athlete, index) => {
    let id = String(athlete.id || `athlete-${index}`);
    if (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    const first = athlete.first_session === true;
    const session =
      Number.isSafeInteger(athlete.session_number) && athlete.session_number >= 1 ? athlete.session_number : null;
    return {
      id,
      name: String(athlete.name || ""),
      lit: Boolean(athlete.checked_in_at),
      first,
      milestone: athlete.milestone === true,
      // A first session is session 1; without session_number (older bridge) the card shows only the name.
      number: first ? 1 : session,
    };
  });
  return {
    classStart,
    coach: typeof lobby.coach === "string" && lobby.coach.trim() ? lobby.coach.trim() : null,
    lit: athletes.filter((a) => a.lit).length,
    total: athletes.length,
    athletes,
  };
}

// schedule: { hasClassAt(classStart), lobbyFor(classStart, now) }
export function computeView(now, schedule, options) {
  const { namesFromMinute, namesUntilMinute, finalCountSeconds } = options;
  const hour = hourStartOf(now);
  const next = hour + HOUR;
  const elapsed = Math.floor((now - hour) / SEC);
  const minute = Math.floor(elapsed / 60);
  const classNow = schedule.hasClassAt(hour);
  const classNext = schedule.hasClassAt(next);
  const clock = hhmm(now);
  const view = {
    mode: "idle",
    stage: null,
    clock,
    num: clock,
    inverted: false,
    last: false,
    final: false,
    fill: null,
    names: null,
    nextClassStart: classNext ? next : null,
  };
  const classSeconds = CLASS_END / SEC;

  if (elapsed < classSeconds) {
    if (classNow) {
      const last = elapsed * SEC >= LAST_STRETCH;
      Object.assign(view, {
        mode: "class",
        stage: last ? "last" : "work",
        num: mmss(classSeconds - elapsed),
        last,
        fill: elapsed / classSeconds,
      });
      if (minute < namesUntilMinute) view.names = namesFor(schedule, hour, now);
    }
    return view;
  }

  const remaining = 3600 - elapsed;
  // From :57 the screen belongs to the class coming in: its lobby, on white until the :00 cut.
  // With a class going out, that needs names to show; otherwise «Sesión completa» stays.
  const lobbyTime = classNext && minute >= namesFromMinute;
  const incoming = lobbyTime ? namesFor(schedule, next, now) : null;
  if (lobbyTime && (incoming || !classNow)) {
    Object.assign(view, { mode: "lobby", stage: "lobby", num: mmss(remaining), inverted: true, names: incoming });
  } else if (classNow) {
    // The class is over: no exercise bar until the next one starts at :00.
    Object.assign(view, { mode: "done", stage: "done", num: mmss(remaining), inverted: true });
  }
  if (view.mode !== "idle" && classNext && remaining <= finalCountSeconds) {
    view.final = true;
    view.num = String(remaining);
  }
  return view;
}

// ===== Voice =====
// The recorded phrases live in public/screen/v2/voice/<key>.mp3, one per key of voice-lines.js.
export const voiceFileUrl = (key) => `/screen/v2/voice/${key}.mp3`;

// The screen speaks only once every file is decoded: a countdown with a missing number would sound
// broken. `missing` goes to the heartbeat.
export function voiceStatus(keys, loaded) {
  const missing = keys.filter((key) => !loaded.has(key));
  return { ready: missing.length === 0, missing };
}

// Web Audio time at which to start a sample so it leaves the speakers at `epoch`. `stamp` is
// AudioContext.getOutputTimestamp(): contextTime is the sample being heard at performanceTime, so
// output latency is included. Right after the context starts the stamp is all zeros for a moment;
// then this returns null and the cue waits for the next tick instead of being placed on a dead clock.
export function outputTimeFor(epoch, stamp, epochAtPerf, rate = 1) {
  if (!stamp || !(stamp.performanceTime > 0) || !(stamp.contextTime > 0)) return null;
  return stamp.contextTime + (epoch - epochAtPerf(stamp.performanceTime)) / SEC / rate;
}

// Cues that should be handed to Web Audio now (within the lookahead, not too late).
export function dueCues(now, schedule, { hasLine, lookaheadMs, lateMs, rate = 1 }) {
  const hour = hourStartOf(now);
  const due = [];
  for (const classStart of [hour, hour + HOUR]) {
    for (const cue of CUES) {
      const at = classStart + cue.offset;
      const dueInRealMs = (at - now) / rate;
      if (dueInRealMs > lookaheadMs || dueInRealMs < -lateMs) continue;
      if (!hasLine(cue.line) || !schedule.hasClassAt(classStart)) continue;
      due.push({ key: `${cue.id}@${at}`, cue, at, classStart });
    }
  }
  return due;
}

// ===== Studio music =====
// Low from «Sesión completa» until `restoreMinute` of the next class, and around every phrase.
// lineDurationMs(line) returns the phrase length, or null when it will not play.
export function musicShouldBeLow(now, schedule, { lineDurationMs, leadMs, tailMs, restoreMinute }) {
  const hour = hourStartOf(now);
  for (const classStart of [hour - HOUR, hour, hour + HOUR]) {
    if (!schedule.hasClassAt(classStart)) continue;
    const holdFrom = classStart + CLASS_END - leadMs;
    const holdUntil = classStart + HOUR + restoreMinute * MIN;
    if (now >= holdFrom && now < holdUntil) return true;
    for (const cue of CUES) {
      const duration = lineDurationMs(cue.line);
      if (duration === null) continue;
      const at = classStart + cue.offset;
      if (now >= at - leadMs && now < at + duration + tailMs) return true;
    }
  }
  return false;
}

// ===== Demo data (?demo=1, ?athletes=1..8) =====
// scan: seconds from the class start (null = never scans). The first six are the default demo.
export const DEMO_ROSTER = [
  { id: "demo-agustina", name: "Agustina", session: 1, firstSession: true, scan: -150 },
  { id: "demo-marta", name: "Marta", session: 100, milestone: true, scan: -170 },
  { id: "demo-luna", name: "Luna", session: 247, scan: -125 },
  { id: "demo-tomas", name: "Tomás", session: 12, scan: -70 },
  { id: "demo-maximiliano", name: "Maximiliano", session: 88, scan: 40 },
  { id: "demo-belen", name: "Belén", session: 31, scan: null },
  { id: "demo-valentina", name: "Valentina", session: 54, scan: -100 },
  { id: "demo-bruno", name: "Bruno", session: 7, scan: 20 },
];
export const DEMO_DEFAULT_COUNT = 6;

// Same order the portal sends: first sessions, then by scan time, then not scanned.
export function sortLikePortal(athletes) {
  const rank = (a, index) => [
    a.first_session ? 0 : 1,
    a.checked_in_at ? 0 : 1,
    a.checked_in_at ? Date.parse(a.checked_in_at) : index,
  ];
  return athletes
    .map((athlete, index) => ({ athlete, key: rank(athlete, index) }))
    .sort((x, y) => x.key[0] - y.key[0] || x.key[1] - y.key[1] || x.key[2] - y.key[2])
    .map(({ athlete }) => athlete);
}

export function demoLobby(classStart, now, count = DEMO_DEFAULT_COUNT) {
  const athletes = DEMO_ROSTER.slice(0, count).map((a) => {
    const scannedAt = a.scan === null ? null : classStart + a.scan * SEC;
    return {
      id: a.id,
      name: a.name,
      first_session: Boolean(a.firstSession),
      session_number: a.session,
      milestone: Boolean(a.milestone),
      checked_in_at: scannedAt !== null && now >= scannedAt ? new Date(scannedAt).toISOString() : null,
    };
  });
  return { starts_at: new Date(classStart).toISOString(), coach: "Joaquín", athletes: sortLikePortal(athletes) };
}
