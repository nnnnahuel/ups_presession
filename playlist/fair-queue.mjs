// Keep requests here until their turn; Spotify's native queue cannot be reordered.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validateFairRequest({ athleteId, requestId }) {
  if (!UUID.test(athleteId || "") || !UUID.test(requestId || "")) {
    const error = new Error("A valid athlete_id and request_id are required.");
    error.statusCode = 400;
    error.errorCode = "invalid_song_request_identity";
    throw error;
  }
}

export async function initFairQueue(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS athlete_music_requests (
    id BIGSERIAL PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    athlete_id TEXT NOT NULL,
    studio TEXT NOT NULL CHECK (studio IN ('studio-a', 'studio-b')),
    uri TEXT NOT NULL,
    track JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting'
      CHECK (status IN ('waiting', 'sending', 'sent', 'played', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    dispatched_at TIMESTAMPTZ,
    retry_after TIMESTAMPTZ,
    observed_in_queue BOOLEAN NOT NULL DEFAULT FALSE,
    absent_observations INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS athlete_music_studio_status
    ON athlete_music_requests (studio, status, created_at)`);
}

export async function acceptFairRequest(db, { athleteId, requestId, studio, track }) {
  validateFairRequest({ athleteId, requestId });
  // A Django record may be reused after a failed attempt for a different track.
  const key = `${requestId}:${track.uri}`;
  const { rows } = await db.query(`INSERT INTO athlete_music_requests
    (request_key, athlete_id, studio, uri, track, expires_at)
    VALUES ($1, $2, $3, $4, $5,
      (date_trunc('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')
        + interval '1 day') AT TIME ZONE 'America/Argentina/Buenos_Aires')
    ON CONFLICT (request_key) DO UPDATE SET request_key = EXCLUDED.request_key
    RETURNING id, athlete_id, studio, status`, [key, athleteId, studio, track.uri, track]);
  const row = rows[0];
  if (row.athlete_id !== athleteId || row.studio !== studio || row.status === 'expired') {
    const error = new Error("Song request identity conflict or expired request.");
    error.statusCode = 409;
    error.errorCode = "song_request_conflict";
    throw error;
  }
  return { id: row.id, status: row.status };
}

// The least recently served athlete gets a turn. FIFO only breaks ties and
// preserves each athlete's own song order; submitting many songs buys no priority.
export function chooseNextRequest(waiting, lastServed) {
  return [...waiting].sort((a, b) => {
    const left = lastServed.get(a.athlete_id) ?? -Infinity;
    const right = lastServed.get(b.athlete_id) ?? -Infinity;
    if (left !== right) return left < right ? -1 : 1;
    return new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id);
  })[0] ?? null;
}

export function dispatchWindowOpen(playback, deviceId) {
  if (!playback?.is_playing || !playback.item?.uri || playback.repeat_state === 'track') return false;
  if (deviceId && playback.device?.id !== deviceId) return false;
  const duration = playback.item.duration_ms;
  const progress = playback.progress_ms;
  return Number.isFinite(duration) && Number.isFinite(progress)
    && duration > 0 && progress >= 0;
}

export function wasDefinitelyRejected(error) {
  return [400, 401, 403, 404, 429].includes(error.statusCode);
}

// Store is injected so scheduling, crash recovery and Spotify failures can be
// tested without playing music. Caller holds a per-studio database session lock.
export async function advanceFairQueue({ store, spotify, deviceId }) {
  const outstanding = await store.outstanding();
  const playback = await spotify.getPlaybackState();
  if (deviceId && playback?.device?.id !== deviceId) return { action: 'wrong_device' };
  if (outstanding) {
    const queue = await spotify.getQueue();
    if (playback?.item?.uri === outstanding.uri || queue.currently_playing?.uri === outstanding.uri) {
      await store.played(outstanding.id);
    } else if (queue.queue?.some((track) => track.uri === outstanding.uri)) {
      await store.observed(outstanding.id);
      return { action: 'waiting_for_playback' };
    } else if (outstanding.observed_in_queue) {
      // Two observations avoid treating a transient Spotify response as a skip.
      if (outstanding.absent_observations < 1) {
        await store.absent(outstanding.id);
        return { action: 'confirming_absence' };
      }
      await store.played(outstanding.id);
    } else {
      // It can be beyond Spotify's visible queue, or a POST may have timed out.
      // Never resend an ambiguous POST or flood Spotify after a process restart.
      return { action: 'awaiting_delivery_observation', request_id: outstanding.id };
    }
  }
  // Keep exactly one request ready. Waiting for the last seconds can miss a
  // crossfade, skip or delayed poll and leave the ordinary playlist playing.
  if (!dispatchWindowOpen(playback, deviceId)) return { action: 'waiting_for_active_playback' };
  const next = await store.next();
  if (!next) return { action: 'empty' };
  // Do not mistake the existing playback of the same URI for our new request.
  if (next.uri === playback.item.uri) return { action: 'waiting_for_track_change' };
  // Persist BEFORE calling Spotify. A crash or lost acknowledgement cannot retry
  // the same external side effect blindly.
  await store.sending(next.id);
  try {
    await spotify.addToQueue(next.uri, deviceId || null);
    await store.sent(next.id);
    return { action: 'dispatched', request_id: next.id };
  } catch (error) {
    await store.failedSend(next.id, error);
    throw error;
  }
}

export function postgresQueueStore(db, studio) {
  return {
    async outstanding() {
      const { rows } = await db.query(`SELECT * FROM athlete_music_requests
        WHERE studio = $1 AND status IN ('sending', 'sent') ORDER BY id LIMIT 1`, [studio]);
      return rows[0] ?? null;
    },
    async next() {
      const { rows: waiting } = await db.query(`SELECT * FROM athlete_music_requests
        WHERE studio = $1 AND status = 'waiting' AND expires_at > NOW() ORDER BY id`, [studio]);
      const { rows: served } = await db.query(`SELECT athlete_id, MAX(dispatched_at) AS served_at
        FROM athlete_music_requests WHERE studio = $1 AND dispatched_at >=
        date_trunc('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')
          AT TIME ZONE 'America/Argentina/Buenos_Aires'
        GROUP BY athlete_id`, [studio]);
      const next = chooseNextRequest(waiting, new Map(served.map(row => [row.athlete_id, new Date(row.served_at).getTime()])));
      return next?.retry_after && new Date(next.retry_after) > new Date() ? null : next;
    },
    played: id => db.query(`UPDATE athlete_music_requests SET status = 'played', error = '' WHERE id = $1`, [id]),
    observed: id => db.query(`UPDATE athlete_music_requests SET status = 'sent', observed_in_queue = TRUE,
      absent_observations = 0, error = '' WHERE id = $1`, [id]),
    absent: id => db.query(`UPDATE athlete_music_requests SET absent_observations = absent_observations + 1 WHERE id = $1`, [id]),
    sending: id => db.query(`UPDATE athlete_music_requests SET status = 'sending', dispatched_at = NOW() WHERE id = $1`, [id]),
    sent: id => db.query(`UPDATE athlete_music_requests SET status = 'sent' WHERE id = $1`, [id]),
    failedSend: (id, error) => wasDefinitelyRejected(error)
      ? db.query(`UPDATE athlete_music_requests SET status = 'waiting', dispatched_at = NULL,
          retry_after = NOW() + $3 * interval '1 millisecond', error = $2 WHERE id = $1`,
        [id, String(error.message).slice(0, 1000), Math.max(60000, error.retryAfterMs || 0)])
      : db.query(`UPDATE athlete_music_requests SET error = $2 WHERE id = $1`, [id, String(error.message).slice(0, 1000)]),
  };
}

export async function runFairQueueTick({ pool, withStudioSpotify, logger = console }) {
  if (!pool) return;
  await pool.query(`UPDATE athlete_music_requests SET status = 'expired'
    WHERE status IN ('waiting', 'sending', 'sent') AND expires_at <= NOW()`);
  const { rows } = await pool.query(`SELECT DISTINCT studio FROM athlete_music_requests
    WHERE status IN ('waiting', 'sending', 'sent')`);
  await Promise.all(rows.map(async ({ studio }) => {
    const db = await pool.connect();
    const lock = `ups-athlete-music:${studio}`;
    let locked = false;
    try {
      const result = await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lock]);
      locked = result.rows[0].locked;
      if (!locked) return;
      await withStudioSpotify(studio, async (spotify, config) => {
        const result = await advanceFairQueue({ store: postgresQueueStore(db, studio), spotify, deviceId: config.deviceId });
        if (result.action === 'dispatched') logger.log('[fair-music]', studio, result);
      });
    } catch (error) {
      logger.error('[fair-music]', studio, error.message);
    } finally {
      try {
        if (locked) await db.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]);
      } finally {
        db.release();
      }
    }
  }));
}
