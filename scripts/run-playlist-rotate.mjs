import { Pool } from "pg";

import { runPlaylistRotation } from "../playlist/rotate.mjs";
import { initPlaylistTables } from "../playlist/state.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? {
          rejectUnauthorized: false,
        }
      : false,
});

try {
  await initPlaylistTables(pool);
  const result = await runPlaylistRotation({
    pool,
    dryRun: process.env.DRY_RUN === "true",
  });

  console.log(JSON.stringify(result, null, 2));
  await pool.end();
} catch (error) {
  console.error(error);
  await pool.end();
  process.exit(1);
}
