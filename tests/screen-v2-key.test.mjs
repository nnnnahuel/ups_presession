import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VOICE_LINES } from "../public/screen/v2/voice-lines.js";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const SCREEN_KEY = "screen-key-for-tests-7f3a";
const PORTAL_TOKEN = "portal-token-for-tests";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startPortal(current = null) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        now: "2026-11-18T20:57:12-03:00",
        studio: "A",
        current,
        lobby: {
          starts_at: "2026-11-18T21:00:00-03:00",
          coach: "Joaquín",
          athletes: [
            { id: "a1b2c3", name: "Marta", checked_in_at: "2026-11-18T20:58:03-03:00", first_session: false, session_number: 100, milestone: true },
            { id: "d4e5f6", name: "Luna", checked_in_at: null, first_session: false, session_number: "12", milestone: "yes" },
          ],
        },
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Real server.mjs with a minimal environment: no database, Spotify or ElevenLabs.
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const base = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill();
    });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/screen/api/health`)).ok) return { base, stop, output: () => output };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`server did not start:\n${output}`);
}

const lobby = (server, headers = {}, query = "studio=A") =>
  fetch(`${server.base}/screen/api/lobby?${query}`, { headers }).then(async (res) => ({ status: res.status, body: await res.json() }));

const heartbeat = (server, headers = {}) =>
  fetch(`${server.base}/screen/api/display/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      studio: "A",
      audioUnlocked: true,
      voiceReady: false,
      voiceMissing: ["count3", "not a key!", 7],
      lastCue: "minute45",
      lastCueAt: "2026-11-18T23:45:00.000Z",
    }),
  }).then((res) => res.json());

const displays = (server) => fetch(`${server.base}/screen/api/health`).then((res) => res.json()).then((body) => body.screenDisplays);

test("without SCREEN_DISPLAY_KEY the lobby and the heartbeat stay closed", async (t) => {
  const portal = await startPortal();
  const server = await startServer({ UPS_PORTAL_API_BASE_URL: portal.url, STUDIO_SCREEN_API_TOKEN: PORTAL_TOKEN });
  t.after(async () => {
    await server.stop();
    await portal.close();
  });

  for (const headers of [{}, { "x-screen-key": SCREEN_KEY }, { "x-screen-key": "" }]) {
    const answer = await lobby(server, headers);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.ok, false);
    assert.equal(answer.body.lobby, undefined);
  }
  assert.deepEqual(await heartbeat(server, { "x-screen-key": SCREEN_KEY }), { ok: false });
  assert.deepEqual(await displays(server), []);
  assert.equal(portal.requests.length, 0, "the portal is never asked");
});

test("a wrong or misplaced key gets nothing and the portal is not asked", async (t) => {
  const portal = await startPortal();
  const server = await startServer({
    UPS_PORTAL_API_BASE_URL: portal.url,
    STUDIO_SCREEN_API_TOKEN: PORTAL_TOKEN,
    SCREEN_DISPLAY_KEY: SCREEN_KEY,
  });
  t.after(async () => {
    await server.stop();
    await portal.close();
  });

  const attempts = [
    [{}, "studio=A"],
    [{ "x-screen-key": "wrong" }, "studio=A"],
    [{ "x-screen-key": `${SCREEN_KEY}x` }, "studio=A"],
    [{ "x-screen-key": SCREEN_KEY.slice(0, -1) }, "studio=A"],
    [{}, `studio=A&key=${SCREEN_KEY}`],
    [{ authorization: `Bearer ${SCREEN_KEY}` }, "studio=A"],
  ];
  for (const [headers, query] of attempts) {
    const answer = await lobby(server, headers, query);
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ["ok", "serverTime"]);
    assert.equal(answer.body.ok, false);
  }
  assert.deepEqual(await heartbeat(server), { ok: false });
  assert.deepEqual(await heartbeat(server, { "x-screen-key": "wrong" }), { ok: false });
  assert.deepEqual(await displays(server), []);
  assert.equal(portal.requests.length, 0);
});

test("the right key reads the lobby through the portal and records the heartbeat", async (t) => {
  const portal = await startPortal();
  const server = await startServer({
    UPS_PORTAL_API_BASE_URL: portal.url,
    STUDIO_SCREEN_API_TOKEN: PORTAL_TOKEN,
    SCREEN_DISPLAY_KEY: SCREEN_KEY,
  });
  t.after(async () => {
    await server.stop();
    await portal.close();
  });

  const answer = await lobby(server, { "x-screen-key": SCREEN_KEY });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.deepEqual(
    answer.body.lobby.athletes.map((a) => [a.name, a.session_number, a.milestone]),
    [
      ["Marta", 100, true],
      ["Luna", null, false],
    ],
    "session_number and milestone pass through; anything that is not a whole number or true is dropped"
  );
  assert.equal(portal.requests.length, 1);
  assert.equal(portal.requests[0].url, "/api/studio-screen/lobby/?studio=A");
  assert.equal(portal.requests[0].authorization, `Bearer ${PORTAL_TOKEN}`);

  assert.equal((await heartbeat(server, { "x-screen-key": SCREEN_KEY })).ok, true);
  const [display] = await displays(server);
  assert.deepEqual(
    [display.studio, display.audioUnlocked, display.voiceReady, display.voiceMissing, display.lastCue, display.online],
    ["A", true, false, ["count3"], "minute45", true]
  );

  assert.ok(!server.output().includes(SCREEN_KEY), "the key never reaches the logs");
});

test("/screen/tts only speaks the old /screen phrases; the v2 voice is served as static files", async (t) => {
  const server = await startServer({});
  t.after(() => server.stop());

  const tts = (text) =>
    fetch(`${server.base}/screen/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(async (res) => [res.status, (await res.json()).error]);

  // Allowed, but this server has no ElevenLabs key and nothing stored: 503 instead of 400.
  assert.deepEqual(await tts("¡Sesión completada!, ¡Buen trabajo!"), [503, "missing_elevenlabs_api_key"]);
  for (const text of Object.values(VOICE_LINES)) assert.deepEqual(await tts(text), [400, "text_not_allowed"], text);

  const file = await fetch(`${server.base}/screen/v2/voice/start.mp3`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type"), /^audio\/mpeg/);
  const size = statSync(fileURLToPath(new URL("../public/screen/v2/voice/start.mp3", import.meta.url))).size;
  assert.equal((await file.arrayBuffer()).byteLength, size);
});

test("the lobby passes the class in progress through, with its athletes once the portal sends them", async (t) => {
  const current = {
    starts_at: "2026-11-18T20:00:00-03:00",
    ends_at: "2026-11-18T20:55:00-03:00",
    coach: "Sol",
    athletes: [
      { id: "c1", name: "Ana", checked_in_at: "2026-11-18T19:58:00-03:00", first_session: false, session_number: 40, milestone: false, extra: "x" },
      { id: "c2", name: "Juan", checked_in_at: null, first_session: true, session_number: 1, milestone: false },
    ],
  };
  const portal = await startPortal(current);
  const server = await startServer({
    UPS_PORTAL_API_BASE_URL: portal.url,
    STUDIO_SCREEN_API_TOKEN: PORTAL_TOKEN,
    SCREEN_DISPLAY_KEY: SCREEN_KEY,
  });
  t.after(async () => {
    await server.stop();
    await portal.close();
  });

  const answer = await lobby(server, { "x-screen-key": SCREEN_KEY });
  assert.deepEqual(answer.body.current, {
    starts_at: current.starts_at,
    ends_at: current.ends_at,
    coach: "Sol",
    athletes: [
      { id: "c1", name: "Ana", checked_in_at: "2026-11-18T19:58:00-03:00", first_session: false, session_number: 40, milestone: false },
      { id: "c2", name: "Juan", checked_in_at: null, first_session: true, session_number: 1, milestone: false },
    ],
  });
});

test("an older portal's current (only starts_at and ends_at) passes without athletes", async (t) => {
  const portal = await startPortal({ starts_at: "2026-11-18T20:00:00-03:00", ends_at: "2026-11-18T20:55:00-03:00" });
  const server = await startServer({
    UPS_PORTAL_API_BASE_URL: portal.url,
    STUDIO_SCREEN_API_TOKEN: PORTAL_TOKEN,
    SCREEN_DISPLAY_KEY: SCREEN_KEY,
  });
  t.after(async () => {
    await server.stop();
    await portal.close();
  });

  const answer = await lobby(server, { "x-screen-key": SCREEN_KEY });
  assert.deepEqual(answer.body.current, { starts_at: "2026-11-18T20:00:00-03:00", ends_at: "2026-11-18T20:55:00-03:00" });
});
