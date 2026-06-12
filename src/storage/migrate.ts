/**
 * Migration runner for memory-postgres.
 *
 * Reads SQL files from src/storage/schema/*.sql in lexical order, hashes each,
 * and applies any not yet recorded in audit.schema_migrations.
 *
 * Lazy concerns handled here (not in plain SQL):
 *   - HNSW index creation is deferred until embedding dimensions are known
 *     (see ensureHnswIndex). The first embedding probe writes
 *     audit.plugin_meta key='embedding.dims'; the next migrate() call brings
 *     up the HNSW index.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const SCHEMA_DIR = fileURLToPath(new URL("./schema/", import.meta.url));

export type MigrationResult = {
  applied: string[];
  skipped: string[];
  hnswDeferred: boolean;
};

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(SCHEMA_DIR);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .toSorted((a, b) => a.localeCompare(b, "en"));
}

function hashSql(sql: string): Buffer {
  return createHash("sha256").update(sql, "utf8").digest();
}

export async function migrate(pool: Pool): Promise<MigrationResult> {
  const files = await listMigrationFiles();
  const applied: string[] = [];
  const skipped: string[] = [];

  // Bootstrap migration table itself (subset of 00-init.sql) before checking it.
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS audit;
    CREATE TABLE IF NOT EXISTS audit.schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    BYTEA NOT NULL
    );
  `);

  for (const filename of files) {
    const fullPath = path.join(SCHEMA_DIR, filename);
    const sql = await readFile(fullPath, "utf8");
    const checksum = hashSql(sql);

    const existing = await pool.query<{ checksum: Buffer }>(
      "SELECT checksum FROM audit.schema_migrations WHERE filename = $1",
      [filename],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const prev = existing.rows[0].checksum;
      if (Buffer.compare(prev, checksum) === 0) {
        skipped.push(filename);
        continue;
      }
      throw new Error(
        `[memory-postgres] migration drift: ${filename} checksum changed since last apply. ` +
          `Add a new file rather than editing applied SQL.`,
      );
    }

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(
        "INSERT INTO audit.schema_migrations (filename, checksum) VALUES ($1, $2)",
        [filename, checksum],
      );
      await pool.query("COMMIT");
      applied.push(filename);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw new Error(
        `[memory-postgres] migration failed on ${filename}: ${(error as Error).message}`, { cause: error },
      );
    }
  }

  // Enable pgvectorscale if its files are installed (the custom image). On a
  // plain pgvector image this is a guarded no-op. Lets ensureHnswIndex pick
  // DiskANN, which — unlike HNSW — indexes >2000-dim vectors.
  await pool.query("CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE").catch(() => undefined);

  // The vector index is dim-locked, so we defer until the embedding probe
  // writes the dimension to audit.plugin_meta. Returns whether it's still owed.
  const hnswDeferred = !(await ensureHnswIndex(pool));
  return { applied, skipped, hnswDeferred };
}

/**
 * Create the ANN vector index on semantic.chunks once we know the embedding
 * dimension. Prefers pgvectorscale's DiskANN when the `vectorscale` extension
 * is present — its SBQ-compressed layout indexes high-dim vectors (e.g. 4096-d
 * Qwen3-Embedding-8B), whereas pgvector's HNSW is capped at 2000 dims by the
 * 8 KB index-tuple page limit. Falls back to HNSW (≤2000). Returns true when an
 * index now exists; false if the dim is still unknown, or it's >2000 and only
 * HNSW is available (recall then runs as an exact scan until DiskANN is added).
 */
export async function ensureHnswIndex(pool: Pool): Promise<boolean> {
  const meta = await pool.query<{ value: { dims?: number } }>(
    "SELECT value FROM audit.plugin_meta WHERE key = 'embedding.dims'",
  );
  const dims = meta.rows[0]?.value?.dims;
  if (typeof dims !== "number" || dims <= 0) {return false;}

  // Either index method already present → done.
  const existing = await pool.query(
    `SELECT 1 FROM pg_indexes
       WHERE schemaname = 'semantic' AND tablename = 'chunks'
         AND indexname IN ('chunks_hnsw', 'chunks_diskann')`,
  );
  if (existing.rowCount && existing.rowCount > 0) {return true;}

  const vs = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vectorscale'");
  const useDiskann = (vs.rowCount ?? 0) > 0;

  if (!useDiskann && dims > 2000) {
    // HNSW can't index this dim and DiskANN isn't installed; leave it unindexed
    // (recall falls back to exact scan). Install pgvectorscale to enable it.
    return false;
  }

  // Both methods need a fixed-dimension column. We ship `embedding` as VECTOR
  // (any dim) so the schema file can land before dims are known; here we
  // promote it to VECTOR(N) and build the index. Existing rows survive the cast.
  const method = useDiskann ? "diskann" : "hnsw";
  const indexName = useDiskann ? "chunks_diskann" : "chunks_hnsw";
  await pool.query(`
    ALTER TABLE semantic.chunks
      ALTER COLUMN embedding TYPE VECTOR(${dims}) USING embedding::VECTOR(${dims});
    CREATE INDEX IF NOT EXISTS ${indexName}
      ON semantic.chunks USING ${method} (embedding vector_cosine_ops);
  `);
  return true;
}

export async function recordEmbeddingDims(pool: Pool, dims: number, model: string): Promise<void> {
  await pool.query(
    `INSERT INTO audit.plugin_meta (key, value, updated_at)
       VALUES ('embedding.dims', jsonb_build_object('dims', $1::int, 'model', $2::text), now())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now()`,
    [dims, model],
  );
}
