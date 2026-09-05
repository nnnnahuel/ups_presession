import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFairQueue, chooseNextRequest, dispatchWindowOpen, runFairQueueTick, validateFairRequest, wasDefinitelyRejected } from '../playlist/fair-queue.mjs';

const song = (id, athlete) => ({ id, athlete_id: athlete, uri: `spotify:track:t${id}`, created_at: new Date(id * 1000), status: 'waiting', absent_observations: 0 });
function fixture(requests) {
  let sequence = 0;
  const lastServed = new Map();
  const state = { playback: { is_playing: true, device: { id: 'speaker' }, item: { uri: 'spotify:track:base', duration_ms: 180000 }, progress_ms: 170000 }, queue: [], sent: [] };
  const store = {
    outstanding: async () => requests.find(r => ['sending', 'sent'].includes(r.status)),
    next: async () => chooseNextRequest(requests.filter(r => r.status === 'waiting'), lastServed),
    sending: async id => { const r = requests.find(r => r.id === id); r.status = 'sending'; lastServed.set(r.athlete_id, ++sequence); },
    sent: async id => { requests.find(r => r.id === id).status = 'sent'; },
    played: async id => { requests.find(r => r.id === id).status = 'played'; },
    observed: async id => { const r = requests.find(r => r.id === id); r.observed_in_queue = true; r.absent_observations = 0; r.status = 'sent'; },
    absent: async id => { requests.find(r => r.id === id).absent_observations++; },
    failedSend: async (id, error) => { requests.find(r => r.id === id).error = error.message; },
  };
  const spotify = {
    getPlaybackState: async () => state.playback,
    getQueue: async () => ({ queue: state.queue }),
    addToQueue: async uri => { state.sent.push(uri); state.queue.push({ uri }); },
  };
  return { state, spotify, store, tick: () => advanceFairQueue({ store, spotify, deviceId: 'speaker' }) };
}

test('a bulk submission cannot occupy another athlete’s turn, preserving their own FIFO', async () => {
  const requests = [song(1, 'Ana'), song(2, 'Ana'), song(3, 'Ana'), song(4, 'Bruno'), song(5, 'Bruno'), song(6, 'Carla')];
  const f = fixture(requests);
  const order = [];
  for (let i = 0; i < requests.length; i++) {
    const result = await f.tick();
    assert.equal(result.action, 'dispatched');
    order.push(result.request_id);
    f.state.playback.item.uri = requests.find(r => r.id === result.request_id).uri;
    f.state.queue = [];
  }
  assert.deepEqual(order, [1, 4, 6, 2, 5, 3]);
});

test('a newcomer enters ahead of the previous athlete’s backlog', async () => {
  const requests = [song(1, 'Ana'), song(2, 'Ana'), song(3, 'Ana')];
  const f = fixture(requests);
  await f.tick();
  f.state.playback.item.uri = requests[0].uri;
  f.state.queue = [];
  requests.push(song(4, 'Bruno'));
  assert.equal((await f.tick()).request_id, 4);
});

test('never fills the native queue before the current request plays', async () => {
  const f = fixture([song(1, 'Ana'), song(2, 'Bruno')]);
  await f.tick();
  for (let i = 0; i < 10; i++) await f.tick();
  assert.deepEqual(f.state.sent, ['spotify:track:t1']);
});

test('waits near the end, leaves paused playback and another device alone', async () => {
  const f = fixture([song(1, 'Ana')]);
  f.state.playback.progress_ms = 1000;
  assert.equal((await f.tick()).action, 'waiting_for_song_end');
  f.state.playback.progress_ms = 170000;
  f.state.playback.is_playing = false;
  assert.equal((await f.tick()).action, 'waiting_for_song_end');
  f.state.playback.is_playing = true;
  f.state.playback.device.id = 'another-speaker';
  assert.equal((await f.tick()).action, 'wrong_device');
  assert.equal(f.state.sent.length, 0);
});

test('does not submit behind repeat-one or malformed playback', () => {
  assert.equal(dispatchWindowOpen(null), false);
  assert.equal(dispatchWindowOpen({ is_playing: true, item: { uri: 'x' } }), false);
  const f = fixture([]);
  f.state.playback.repeat_state = 'track';
  assert.equal(dispatchWindowOpen(f.state.playback, 'speaker'), false);
});

test('a request for the song already playing waits for the next track', async () => {
  const f = fixture([song(1, 'Ana')]);
  f.state.playback.item.uri = 'spotify:track:t1';
  assert.equal((await f.tick()).action, 'waiting_for_track_change');
  assert.equal(f.state.sent.length, 0);
});

test('recovers an ambiguous send by observation without sending twice', async () => {
  const requests = [song(1, 'Ana'), song(2, 'Bruno')];
  const f = fixture(requests);
  f.spotify.addToQueue = async uri => { f.state.sent.push(uri); throw new Error('connection lost'); };
  await assert.rejects(f.tick(), /connection lost/);
  assert.equal(requests[0].status, 'sending');
  assert.equal((await f.tick()).action, 'awaiting_delivery_observation');
  // The accepted POST becomes visible after a lost response / server restart.
  f.state.queue = [{ uri: requests[0].uri }];
  assert.equal((await f.tick()).action, 'waiting_for_playback');
  assert.equal(requests[0].status, 'sent');
  assert.equal(f.state.sent.length, 1);
});

test('an accepted song outside Spotify’s visible queue never triggers a second dispatch', async () => {
  const f = fixture([song(1, 'Ana'), song(2, 'Bruno')]);
  await f.tick();
  f.state.queue = [];
  for (let i = 0; i < 5; i++) assert.equal((await f.tick()).action, 'awaiting_delivery_observation');
  assert.equal(f.state.sent.length, 1);
});

test('a skipped request releases the next turn only after two absence observations', async () => {
  const f = fixture([song(1, 'Ana'), song(2, 'Bruno')]);
  await f.tick();
  await f.tick();
  f.state.queue = [];
  assert.equal((await f.tick()).action, 'confirming_absence');
  assert.equal((await f.tick()).request_id, 2);
});

test('database ownership prevents overlapping workers dispatching a studio', async () => {
  let released = false;
  let spotifyCalls = 0;
  const db = { query: async () => ({ rows: [{ locked: false }] }), release: () => { released = true; } };
  let calls = 0;
  const pool = { query: async () => ({ rows: ++calls === 2 ? [{ studio: 'studio-a' }] : [] }), connect: async () => db };
  await runFairQueueTick({ pool, withStudioSpotify: async () => { spotifyCalls++; } });
  assert.equal(spotifyCalls, 0);
  assert.equal(released, true);
});

test('invalid or missing identity cannot enter the athlete rotation', () => {
  assert.throws(() => validateFairRequest({ athleteId: 'name', requestId: '123' }), /valid/);
  assert.doesNotThrow(() => validateFairRequest({ athleteId: '00000000-0000-4000-8000-000000000001', requestId: '00000000-0000-4000-8000-000000000002' }));
});

test('only a definite Spotify rejection can be retried; timeouts and server errors are ambiguous', () => {
  assert.equal(wasDefinitelyRejected({ statusCode: 429 }), true);
  assert.equal(wasDefinitelyRejected({ statusCode: 401 }), true);
  assert.equal(wasDefinitelyRejected({ statusCode: 503 }), false);
  assert.equal(wasDefinitelyRejected(new Error('timeout')), false);
});
