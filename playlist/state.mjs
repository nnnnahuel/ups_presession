export async function initPlaylistTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS playlist_removed_history (
      id BIGSERIAL PRIMARY KEY,
      uri TEXT NOT NULL,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS playlist_execution_log (
      id BIGSERIAL PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_count INT NOT NULL DEFAULT 0,
      added_count INT NOT NULL DEFAULT 0,
      fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
      skipped BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'success',
      errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      details JSONB
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playlist_removed_history_removed_at
    ON playlist_removed_history (removed_at)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playlist_removed_history_uri
    ON playlist_removed_history (uri)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playlist_execution_log_executed_at
    ON playlist_execution_log (executed_at DESC)
  `);
}

export async function getCooldownUris(db, cooldownDays) {
  const result = await db.query(
    `
      SELECT DISTINCT uri
      FROM playlist_removed_history
      WHERE removed_at >= NOW() - ($1::int * INTERVAL '1 day')
    `,
    [cooldownDays]
  );

  return new Set(result.rows.map((row) => row.uri));
}

export async function recordRemovedTracks(db, items) {
  if (!items.length) {
    return;
  }

  const values = [];
  const params = [];
  let index = 1;

  for (const item of items) {
    values.push(`($${index}, $${index + 1}, $${index + 2})`);
    params.push(
      item.track.uri,
      item.track.name,
      item.track.artists[0]?.name || "Unknown"
    );
    index += 3;
  }

  await db.query(
    `
      INSERT INTO playlist_removed_history (uri, name, artist)
      VALUES ${values.join(", ")}
    `,
    params
  );
}

export async function purgeOldHistory(db, cooldownDays) {
  await db.query(
    `
      DELETE FROM playlist_removed_history
      WHERE removed_at < NOW() - ($1::int * INTERVAL '1 day')
    `,
    [cooldownDays]
  );
}

export async function logExecution(db, result) {
  await db.query(
    `
      INSERT INTO playlist_execution_log (
        removed_count,
        added_count,
        fallback_used,
        skipped,
        status,
        errors,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
    `,
    [
      result.removed || 0,
      result.added || 0,
      Boolean(result.fallbackUsed),
      Boolean(result.skipped),
      result.status || "success",
      JSON.stringify(result.errors || []),
      JSON.stringify(result.details || null),
    ]
  );
}

export async function getRecentLogs(db, limit = 30) {
  const result = await db.query(
    `
      SELECT
        id,
        executed_at,
        removed_count,
        added_count,
        fallback_used,
        skipped,
        status,
        errors,
        details
      FROM playlist_execution_log
      ORDER BY executed_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
}
