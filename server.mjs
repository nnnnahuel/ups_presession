import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT || 3000);

const hasDatabase = Boolean(process.env.DATABASE_URL);

const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? {
              rejectUnauthorized: false,
            }
          : false,
    })
  : null;

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL
    )
  `);
}

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  if (!pool) {
    res.status(200).json({ ok: true, database: false });
    return;
  }

  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, database: true });
  } catch (error) {
    res.status(500).json({ ok: false, database: true, error: String(error) });
  }
});

app.get("/api/sessions", async (_req, res) => {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
    return;
  }

  try {
    const result = await pool.query(
      `
      SELECT payload
      FROM sessions
      ORDER BY created_at DESC
      LIMIT 100
      `
    );

    res.json(result.rows.map((row) => row.payload));
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_LIST_SESSIONS", detail: String(error) });
  }
});

app.post("/api/sessions", async (req, res) => {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_NOT_CONFIGURED" });
    return;
  }

  const session = req.body;

  if (!session || typeof session !== "object" || !session.id) {
    res.status(400).json({ error: "INVALID_SESSION_PAYLOAD" });
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO sessions (id, created_at, payload)
      VALUES ($1, COALESCE(($2)::timestamptz, NOW()), $3::jsonb)
      ON CONFLICT (id) DO UPDATE
      SET created_at = EXCLUDED.created_at,
          payload = EXCLUDED.payload
      `,
      [session.id, session.createdAt ?? null, JSON.stringify(session)]
    );

    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "FAILED_TO_SAVE_SESSION", detail: String(error) });
  }
});

app.use(
  express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        return;
      }

      if (/\.(js|css|png|jpg|jpeg|svg|webp|ico)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

app.get(/.*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.join(distDir, "index.html"));
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server", error);
    process.exit(1);
  });
