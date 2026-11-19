import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VOICE_LINES } from "../public/screen/v2/voice-lines.js";
import {
  CUES,
  computeView,
  createClassMemory,
  demoLobby,
  dueCues,
  hourStartOf,
  musicShouldBeLow,
  outputTimeFor,
  sameDayAt,
  voiceFileUrl,
  voiceStatus,
} from "../public/screen/v2/timeline.js";

const v2Dir = fileURLToPath(new URL("../public/screen/v2/", import.meta.url));

const at = (time, day = "2026-11-18") => Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}-03:00`);
const OPTIONS = { namesFromMinute: 57, namesUntilMinute: 5, finalCountSeconds: 10 };

function scheduleWith(classHours, { lobby = false } = {}) {
  const starts = new Set(classHours.map((time) => at(time)));
  return {
    hasClassAt: (classStart) => starts.has(classStart),
    lobbyFor: (classStart, now) => (lobby && starts.has(classStart) ? demoLobby(classStart, now) : null),
  };
}

const everyHour = { hasClassAt: () => true, lobbyFor: () => null };
const view = (time, schedule) => computeView(at(time), schedule, OPTIONS);

test("minutes 0-44 show only the countdown, «Últimos 10 minutos» from :45, the bar fills to :55", () => {
  const schedule = scheduleWith(["20:00", "21:00"], { lobby: true });
  assert.deepEqual(
    ["20:08", "20:30", "20:48"].map((time) => {
      const v = view(time, schedule);
      return [v.mode, v.stage, v.num, v.last, v.inverted];
    }),
    [
      ["class", "work", "47:00", false, false],
      ["class", "work", "25:00", false, false],
      ["class", "last", "07:00", true, false],
    ]
  );
  assert.deepEqual([view("20:44:59", schedule).stage, view("20:45", schedule).stage], ["work", "last"]);
  assert.deepEqual([view("20:00", schedule).fill, view("20:27:30", schedule).fill], [0, 0.5]);
  assert.equal(view("20:54:59", schedule).num, "00:01");
});

test("voice lines: no minute 20, «Quedan diez minutos» at :45, every cue has its line", () => {
  assert.equal(VOICE_LINES.minute20, undefined);
  assert.equal(VOICE_LINES.minute45, "Quedan diez minutos");
  assert.deepEqual(
    CUES.map((cue) => cue.id),
    ["count5", "count4", "count3", "count2", "count1", "start", "minute45", "end"]
  );
  for (const cue of CUES) assert.equal(typeof VOICE_LINES[cue.line], "string", cue.line);
});

test("a recorded mp3 exists for every voice line, and nothing else", () => {
  const keys = Object.keys(VOICE_LINES);
  assert.deepEqual(readdirSync(`${v2Dir}voice`).sort(), keys.map((key) => `${key}.mp3`).sort());
  for (const key of keys) {
    const bytes = readFileSync(`${v2Dir}voice/${key}.mp3`);
    const id3 = bytes.subarray(0, 3).toString("latin1") === "ID3";
    const frameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    assert.ok(bytes.length > 4000 && (id3 || frameSync), `${key}.mp3 is an mp3`);
    assert.equal(voiceFileUrl(key), `/screen/v2/voice/${key}.mp3`);
  }
});

test("/screen/v2 plays the recorded files and never asks /screen/tts", () => {
  for (const file of readdirSync(v2Dir).filter((name) => /\.(js|html)$/.test(name))) {
    assert.ok(!readFileSync(`${v2Dir}${file}`, "utf8").includes("/screen/tts"), `${file} mentions /screen/tts`);
  }
  assert.match(readFileSync(`${v2Dir}app.js`, "utf8"), /fetch\(voiceFileUrl\(key\)\)/);
});

test("«start» fires 0.30 s before the hour; the numbers stay one per second", () => {
  assert.deepEqual(Object.fromEntries(CUES.map((cue) => [cue.id, cue.offset])), {
    count5: -5000,
    count4: -4000,
    count3: -3000,
    count2: -2000,
    count1: -1000,
    start: -300,
    minute45: 45 * 60 * 1000,
    end: 55 * 60 * 1000,
  });
  const due = dueCues(at("20:59:59.650"), everyHour, { hasLine: () => true, lookaheadMs: 100, lateMs: 300 });
  assert.deepEqual(
    due.map((cue) => [cue.cue.id, cue.at]),
    [["start", at("21:00") - 300]]
  );
});

test("cues wait for the audio output clock to start before being scheduled", () => {
  // 1 s of sim time per 1000 ms of performance time, sim epoch = performance.now() + 1e12.
  const epochAtPerf = (perf) => perf + 1e12;
  assert.equal(outputTimeFor(1e12 + 5000, { contextTime: 0, performanceTime: 0 }, epochAtPerf), null);
  // Heard at performance 2000 ms is context sample 1.25 s: a sound for sim 5000 ms starts at context 4.25 s.
  assert.equal(outputTimeFor(1e12 + 5000, { contextTime: 1.25, performanceTime: 2000 }, epochAtPerf), 4.25);
});

test("a missing recorded file keeps the whole voice silent and is reported", () => {
  const keys = Object.keys(VOICE_LINES);
  const loaded = new Map(keys.map((key) => [key, { duration: 1 }]));
  assert.deepEqual(voiceStatus(keys, loaded), { ready: true, missing: [] });

  loaded.delete("count3");
  const status = voiceStatus(keys, loaded);
  assert.deepEqual(status, { ready: false, missing: ["count3"] });
  const canSpeak = (line) => status.ready && loaded.has(line);
  assert.deepEqual(dueCues(at("20:59:45"), everyHour, { hasLine: canSpeak, lookaheadMs: 20000, lateMs: 300 }), []);
});

test("«Sesión completa» from :55, then from :57 the white lobby of the class coming in, and the 10 count", () => {
  const schedule = scheduleWith(["20:00", "21:00"], { lobby: true });
  const done = view("20:55", schedule);
  assert.deepEqual([done.mode, done.inverted, done.num, done.fill, done.names], ["done", true, "05:00", null, null]);
  assert.equal(view("20:59:52", schedule).fill, null, "no exercise bar during «Sesión completa» and the lobby, 10 count included");
  assert.notEqual(view("21:00", schedule).fill, null, "the bar is back with the new class");
  assert.deepEqual([view("20:56:59", schedule).mode, view("20:56:59", schedule).names], ["done", null]);

  const lobby = view("20:57", schedule);
  assert.deepEqual(
    [lobby.mode, lobby.stage, lobby.inverted, lobby.fill, lobby.num, lobby.nextClassStart],
    ["lobby", "lobby", true, null, "03:00", at("21:00")]
  );
  assert.equal(lobby.names.total, 6);
  assert.equal(lobby.names.lit, 0);
  assert.equal(view("20:57:10", schedule).names.lit, 1);
  assert.equal(view("20:59:36", schedule).mode, "lobby");

  assert.deepEqual([view("20:59:45", schedule).final, view("20:59:45", schedule).num], [false, "00:15"]);
  assert.deepEqual([view("20:59:50", schedule).final, view("20:59:50", schedule).num], [true, "10"]);
  assert.equal(view("20:59:59", schedule).num, "1");
});

test(":00 starts the new class and the names stay until minute 5", () => {
  const schedule = scheduleWith(["20:00", "21:00"], { lobby: true });
  const start = view("21:00", schedule);
  assert.deepEqual([start.mode, start.stage, start.inverted, start.num], ["class", "work", false, "55:00"]);
  assert.equal(start.names.total, 6);
  assert.equal(view("21:00:39", schedule).names.lit, 4);
  assert.equal(view("21:00:40", schedule).names.lit, 5);
  assert.notEqual(view("21:04:59", schedule).names, null);
  assert.equal(view("21:05", schedule).names, null);
});

test("first class of the day: the same white lobby from :57, nothing before", () => {
  const schedule = scheduleWith(["21:00"], { lobby: true });
  const before = view("20:55", schedule);
  assert.deepEqual([before.mode, before.nextClassStart], ["idle", at("21:00")]);
  const lobby = view("20:57", schedule);
  assert.deepEqual([lobby.mode, lobby.inverted, lobby.fill, lobby.num, lobby.names.total], ["lobby", true, null, "03:00", 6]);
  assert.deepEqual([view("20:59:50", schedule).final, view("20:59:50", schedule).num], [true, "10"]);
  assert.equal(view("21:00", schedule).mode, "class");

  // Nobody booked yet: still the incoming class's lobby (title and countdown), without names.
  const empty = view("20:58", scheduleWith(["21:00"]));
  assert.deepEqual([empty.mode, empty.inverted, empty.names], ["lobby", true, null]);
});

test("without a class coming in, or without its names, «Sesión completa» stays the five minutes", () => {
  const last = view("20:58", scheduleWith(["20:00"], { lobby: true }));
  assert.deepEqual([last.mode, last.stage, last.names], ["done", "done", null]);

  const nobody = {
    hasClassAt: (classStart) => classStart === at("20:00") || classStart === at("21:00"),
    lobbyFor: (classStart) => ({ starts_at: new Date(classStart).toISOString(), coach: "Joaquín", athletes: [] }),
  };
  const noNames = view("20:58", nobody);
  assert.deepEqual([noNames.mode, noNames.names], ["done", null]);
  assert.deepEqual([view("20:59:50", nobody).final, view("20:59:50", nobody).num], [true, "10"]);
});

test("the line above the names is the coach alone, and missing without one", () => {
  const withCoach = (coach) => ({
    hasClassAt: () => true,
    lobbyFor: (classStart) => ({ starts_at: new Date(classStart).toISOString(), coach, athletes: [{ id: "a", name: "Marta" }] }),
  });
  assert.equal(view("20:58", withCoach(" Joaquín ")).names.coach, "Joaquín");
  assert.equal(view("21:01", withCoach("Joaquín")).names.coach, "Joaquín");
  for (const coach of [null, undefined, "", "   ", 7]) assert.equal(view("20:58", withCoach(coach)).names.coach, null);
});

test("last class of a block counts to the hour without the 10 count", () => {
  const schedule = scheduleWith(["20:00"]);
  const end = view("20:59:50", schedule);
  assert.deepEqual([end.mode, end.final, end.num], ["done", false, "00:10"]);
  assert.equal(view("21:00", schedule).mode, "idle");
});

test("no class and no lobby shows the clock", () => {
  const schedule = scheduleWith([]);
  const idle = view("20:12", schedule);
  assert.deepEqual([idle.mode, idle.num, idle.fill, idle.nextClassStart], ["idle", "20:12", null, null]);
  assert.equal(view("20:57", schedule).mode, "idle");
});

test("without portal data every hour behaves like a class, without names", () => {
  const v = view("20:57", everyHour);
  assert.deepEqual([v.mode, v.inverted, v.names], ["done", true, null]);
  assert.equal(view("20:59:51", everyHour).num, "9");
});

test("voice cues are due only for hours with a class", () => {
  const options = { hasLine: () => true, lookaheadMs: 20000, lateMs: 300 };
  const ids = (time, schedule) => dueCues(at(time), schedule, options).map((cue) => cue.cue.id);

  assert.deepEqual(ids("20:59:40", everyHour), ["count5", "count4", "count3", "count2", "count1", "start"]);
  assert.deepEqual(ids("20:44:41", everyHour), ["minute45"]);
  assert.deepEqual(ids("20:54:50", everyHour), ["end"]);
  assert.deepEqual(ids("20:45:00.200", everyHour), ["minute45"]);
  assert.deepEqual(ids("20:45:01", everyHour), []);
  for (const time of ["20:14:50", "20:19:50", "20:24:50", "20:34:50"]) {
    assert.deepEqual(ids(time, everyHour), [], `no voice before ${time.slice(0, 5)}`);
  }

  assert.deepEqual(ids("20:54:50", scheduleWith(["21:00"])), [], "no «Sesión completa» without a class");
  assert.deepEqual(ids("20:59:45", scheduleWith(["20:00"])), [], "no countdown without an incoming class");
  assert.deepEqual(ids("20:12", scheduleWith([])), []);
  assert.deepEqual(dueCues(at("20:59:40"), everyHour, { ...options, hasLine: (line) => line !== "count3" }).length, 5);
});

test("music goes low for «Sesión completa» until :02 and around each phrase", () => {
  const options = (durationMs) => ({
    lineDurationMs: () => durationMs,
    leadMs: 3500,
    tailMs: 800,
    restoreMinute: 2,
  });
  const low = (time, schedule, durationMs = null) => musicShouldBeLow(at(time), schedule, options(durationMs));

  assert.equal(low("20:54:56", everyHour), false);
  assert.equal(low("20:54:57", everyHour), true);
  assert.equal(low("21:01:59", everyHour), true);
  assert.equal(low("21:02:00", everyHour), false);
  assert.equal(low("20:19:57", everyHour), false, "no voice, no duck");

  assert.equal(low("20:19:57", everyHour, 2000), false, "no phrase at minute 20 any more");
  assert.equal(low("20:44:57", everyHour, 2000), true);
  assert.equal(low("20:45:02.700", everyHour, 2000), true);
  assert.equal(low("20:45:03", everyHour, 2000), false);

  const first = scheduleWith(["21:00"]);
  assert.equal(low("20:55:30", first, 1500), false, "no hold without a class that ends");
  assert.equal(low("20:59:52", first, 1500), true);
  assert.equal(low("21:00:03", first, 1500), false);

  assert.equal(low("20:56", scheduleWith([]), 1500), false, "no class: the volume is never touched");
});

test("class memory keeps the hour that just ended and drops cancelled lobbies", () => {
  const memory = createClassMemory();
  memory.absorb({ current: { starts_at: "2026-11-18T20:00:00-03:00" }, lobby: null }, at("20:30"));
  memory.absorb({ current: null, lobby: { starts_at: "2026-11-18T21:00:00-03:00" } }, at("20:57"));
  assert.ok(memory.has(at("20:00")));
  assert.ok(memory.has(at("21:00")));

  memory.absorb({ current: null, lobby: null }, at("20:58"));
  assert.ok(!memory.has(at("21:00")), "the portal dropped the 21:00 class");
  assert.ok(memory.has(at("20:00")));

  memory.absorb({ current: null, lobby: null }, at("23:30"));
  assert.ok(!memory.has(at("20:00")), "old hours are pruned");
});

test("demo lobby keeps the portal order and shows every card state", () => {
  const lobby = demoLobby(at("21:00"), at("21:00"));
  assert.deepEqual(
    lobby.athletes.map((a) => [a.name, Boolean(a.checked_in_at), a.session_number, a.first_session, a.milestone]),
    [
      ["Agustina", true, 1, true, false],
      ["Marta", true, 100, false, true],
      ["Luna", true, 247, false, false],
      ["Tomás", true, 12, false, false],
      ["Maximiliano", false, 88, false, false],
      ["Belén", false, 31, false, false],
    ]
  );
  assert.equal(demoLobby(at("21:00"), at("21:00"), 8).athletes.length, 8);
  assert.deepEqual(
    demoLobby(at("21:00"), at("20:57:20"), 2).athletes.map((a) => [a.name, Boolean(a.checked_in_at)]),
    [
      ["Agustina", false],
      ["Marta", true],
    ]
  );
});

test("athlete cards carry the session number, first session and milestone", () => {
  const athletes = [
    { id: "a", name: "Agustina", first_session: true, session_number: 1, checked_in_at: "2026-11-18T20:58:00-03:00" },
    { id: "b", name: "Marta", session_number: 100, milestone: true },
    { id: "c", name: "Luna", session_number: 247 },
    { id: "d", name: "Tomás" },
    { id: "e", name: "Belén", session_number: 0 },
    { id: "f", name: "Bruno", session_number: "12", milestone: "yes" },
    { id: "g", name: "Facundo", session_number: 4.5 },
    { id: "h", name: "Sol", first_session: true },
  ];
  const schedule = {
    hasClassAt: () => true,
    lobbyFor: (classStart) => ({ starts_at: new Date(classStart).toISOString(), coach: "Joaquín", athletes }),
  };
  const cards = view("20:58:30", schedule).names.athletes;
  assert.deepEqual(
    cards.map((c) => [c.name, c.number, c.first, c.milestone, c.lit]),
    [
      ["Agustina", 1, true, false, true],
      ["Marta", 100, false, true, false],
      ["Luna", 247, false, false, false],
      ["Tomás", null, false, false, false],
      ["Belén", null, false, false, false],
      ["Bruno", null, false, false, false],
      ["Facundo", null, false, false, false],
      ["Sol", 1, true, false, false],
    ]
  );
});

test("Argentina wall clock helpers", () => {
  assert.equal(hourStartOf(Date.parse("2026-11-18T20:57:12-03:00")), at("20:00"));
  assert.equal(hourStartOf(Date.parse("2026-11-19T02:30:00Z")), at("23:00"));
  assert.equal(sameDayAt(at("10:00"), (20 * 60 + 57) * 60 * 1000), at("20:57"));
  assert.equal(sameDayAt(Date.parse("2026-11-19T02:30:00Z"), 60 * 1000), at("00:01"));
});
