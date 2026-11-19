import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createVolumeControl, describeVolumeMode, executeCommand } = require("../worker.cjs");

// NirCmd is never run: every call is recorded instead.
function fakeVolume(options = {}) {
  const calls = [];
  const waits = [];
  const saved = [];
  const volume = createVolumeControl({
    runNircmd: async (args) => {
      calls.push(args);
    },
    onChange: (pct) => saved.push(pct),
    wait: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { volume, calls, waits, saved };
}

const RAMP_88_TO_50 = [86, 84, 82, 80, 79, 77, 75, 73, 71, 69, 67, 65, 63, 61, 60, 58, 56, 54, 52, 50];

test("without MUSIC_PROCESS the commands drive the Windows master volume exactly as before", async () => {
  const { volume, calls, saved } = fakeVolume();
  assert.equal(volume.target, "master");

  await executeCommand({ type: "volume", value: "50" }, volume);
  await executeCommand({ type: "volume", value: 100 }, volume);
  await executeCommand({ type: "volume", value: 0 }, volume);
  await executeCommand({ type: "mute" }, volume);
  await executeCommand({ type: "unmute" }, volume);
  assert.deepEqual(calls, [
    ["setsysvolume", "32768"],
    ["setsysvolume", "65535"],
    ["setsysvolume", "0"],
    ["mutesysvolume", "1"],
    ["mutesysvolume", "0"],
  ]);
  assert.deepEqual(saved, [50, 100, 0]);
  assert.equal(volume.currentPct, 0);
});

test("the ramp keeps its steps and timing: 20 steps of 60 ms for 1.2 s", async () => {
  const { volume, calls, waits } = fakeVolume({ initialPct: 88 });
  await executeCommand({ type: "volume_ramp", value: { targetPct: 50, duration: 1200, from: 88 } }, volume);
  assert.deepEqual(
    calls,
    RAMP_88_TO_50.map((pct) => ["setsysvolume", String(Math.round((pct / 100) * 65535))])
  );
  assert.deepEqual(waits, Array(19).fill(60));
  assert.equal(volume.currentPct, 50);

  // A bare number (as the server's old timers sent, `volume_ramp 90`) still ramps from the last known level.
  const bare = fakeVolume({ initialPct: 50 });
  await executeCommand({ type: "volume_ramp", value: 90 }, bare.volume);
  assert.equal(bare.calls.length, 20);
  assert.deepEqual(bare.calls.at(-1), ["setsysvolume", String(Math.round(0.9 * 65535))]);

  // Unknown start: `from` is used, as before.
  const fresh = fakeVolume();
  await fresh.volume.ramp({ targetPct: 50, duration: 1200, from: 88 });
  assert.deepEqual(fresh.calls.map((args) => args[1]), RAMP_88_TO_50.map((pct) => String(Math.round((pct / 100) * 65535))));
});

test("with MUSIC_PROCESS the same commands drive only that program in the volume mixer", async () => {
  const { volume, calls, waits } = fakeVolume({ musicProcess: "Spotify.exe", initialPct: 88 });
  assert.equal(volume.target, "app:Spotify.exe");

  await executeCommand({ type: "volume_ramp", value: { targetPct: 50, duration: 1200, from: 88 } }, volume);
  assert.deepEqual(
    calls,
    RAMP_88_TO_50.map((pct) => ["setappvolume", "Spotify.exe", String(pct / 100)])
  );
  assert.deepEqual(calls[0], ["setappvolume", "Spotify.exe", "0.86"]);
  assert.deepEqual(waits, Array(19).fill(60));

  calls.length = 0;
  await executeCommand({ type: "volume", value: 100 }, volume);
  await executeCommand({ type: "volume", value: 0 }, volume);
  await executeCommand({ type: "mute" }, volume);
  await executeCommand({ type: "unmute" }, volume);
  assert.deepEqual(calls, [
    ["setappvolume", "Spotify.exe", "1"],
    ["setappvolume", "Spotify.exe", "0"],
    ["muteappvolume", "Spotify.exe", "1"],
    ["muteappvolume", "Spotify.exe", "0"],
  ]);
  assert.ok(!calls.some((args) => args[0].includes("sysvolume")), "the master volume is never touched by the commands");
});

test("SYSTEM_VOLUME_PCT sets the master volume once at start-up, only in music mode", async () => {
  const music = fakeVolume({ musicProcess: "Spotify.exe" });
  assert.equal(await music.volume.applyStartupSystemVolume("100"), 100);
  assert.deepEqual(music.calls, [
    ["setsysvolume", "65535"],
    ["mutesysvolume", "0"],
  ]);

  for (const value of ["", undefined, "abc"]) {
    const unset = fakeVolume({ musicProcess: "Spotify.exe" });
    assert.equal(await unset.volume.applyStartupSystemVolume(value), null);
    assert.deepEqual(unset.calls, []);
  }

  const master = fakeVolume();
  assert.equal(await master.volume.applyStartupSystemVolume("100"), null, "ignored without MUSIC_PROCESS");
  assert.deepEqual(master.calls, []);
});

test("the worker says in its console which volume it drives", () => {
  assert.match(describeVolumeMode("", "").join("\n"), /maestro de Windows/);
  const music = describeVolumeMode("Spotify.exe", "100").join("\n");
  assert.match(music, /solo la música \(Spotify\.exe\)/);
  assert.match(music, /NirCmd 2\.50/);
  assert.match(music, /una vez en 100 %/);
  assert.match(describeVolumeMode("Spotify.exe", "").join("\n"), /no se toca/);
});

test("an unknown command type is still an error", async () => {
  const { volume, calls } = fakeVolume();
  await assert.rejects(executeCommand({ type: "reboot" }, volume), /Unsupported command type: reboot/);
  assert.deepEqual(calls, []);
});
