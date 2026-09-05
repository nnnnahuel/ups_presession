// In-platform verification against PostgreSQL TEMP tables only. No music calls.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { acceptFairRequest, postgresQueueStore } from '../playlist/fair-queue.mjs';

const url = new URL(process.env.DATABASE_URL);
assert.ok(url.hostname.endsWith('.railway.internal'), 'Run through Railway SSH on the private database connection.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = n => ({ uri: `spotify:track:test${n}`, name: 'Isolated verification' });
try {
  await db.query('BEGIN');
  await db.query('CREATE TEMP SEQUENCE fair_test_id');
  await db.query(`CREATE TEMP TABLE athlete_music_requests
    (LIKE public.athlete_music_requests INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  await db.query(`ALTER TABLE pg_temp.athlete_music_requests ALTER COLUMN id SET DEFAULT nextval('pg_temp.fair_test_id')`);
  assert.equal((await db.query("SELECT table_schema FROM information_schema.tables WHERE table_name = 'athlete_music_requests' AND table_schema LIKE 'pg_temp%'")).rows.length, 1);
  const first = await acceptFairRequest(db, { athleteId: uuid(1), requestId: uuid(11), studio: 'studio-a', track: track(1) });
  const duplicate = await acceptFairRequest(db, { athleteId: uuid(1), requestId: uuid(11), studio: 'studio-a', track: track(1) });
  assert.equal(first.id, duplicate.id);
  await acceptFairRequest(db, { athleteId: uuid(1), requestId: uuid(12), studio: 'studio-a', track: track(2) });
  const bruno = await acceptFairRequest(db, { athleteId: uuid(2), requestId: uuid(13), studio: 'studio-a', track: track(3) });
  const studioB = await acceptFairRequest(db, { athleteId: uuid(3), requestId: uuid(14), studio: 'studio-b', track: track(4) });
  const store = postgresQueueStore(db, 'studio-a');
  assert.equal((await store.next()).id, first.id);
  await store.sending(first.id);
  await store.sent(first.id);
  assert.equal((await store.outstanding()).id, first.id);
  await store.observed(first.id);
  await store.absent(first.id);
  assert.equal((await store.outstanding()).absent_observations, 1);
  await store.played(first.id);
  assert.equal((await store.next()).id, bruno.id);
  assert.equal((await postgresQueueStore(db, 'studio-b').next()).id, studioB.id);
  await store.sending(bruno.id);
  await store.failedSend(bruno.id, { statusCode: 429, message: 'rate limited', retryAfterMs: 120000 });
  assert.equal(await store.outstanding(), null);
  assert.equal(await store.next(), null);
  await db.query(`UPDATE athlete_music_requests SET retry_after = NOW() - interval '1 second' WHERE id = $1`, [bruno.id]);
  assert.equal((await store.next()).id, bruno.id);
  await store.sending(bruno.id);
  await store.failedSend(bruno.id, new Error('ambiguous timeout'));
  assert.equal((await store.outstanding()).status, 'sending');
  await db.query(`UPDATE athlete_music_requests SET expires_at = NOW() - interval '1 second' WHERE status = 'waiting'`);
  assert.equal(await store.next(), null);
  await assert.rejects(acceptFairRequest(db, { athleteId: uuid(99), requestId: uuid(11), studio: 'studio-a', track: track(1) }), /conflict/);
  console.log(JSON.stringify({ ok: true, checks: 15, scope: 'temporary tables only; no Spotify calls; no persisted requests' }));
} finally {
  await db.query('ROLLBACK');
  db.release();
  await pool.end();
}
