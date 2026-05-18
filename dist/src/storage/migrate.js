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
const SCHEMA_DIR = fileURLToPath(new URL("./schema/", import.meta.url));
async function listMigrationFiles() {
    const entries = await readdir(SCHEMA_DIR);
    return entries
        .filter((name) => name.endsWith(".sql"))
        .toSorted((a, b) => a.localeCompare(b, "en"));
}
function hashSql(sql) {
    return createHash("sha256").update(sql, "utf8").digest();
}
export async function migrate(pool) {
    const files = await listMigrationFiles();
    const applied = [];
    const skipped = [];
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
        const existing = await pool.query("SELECT checksum FROM audit.schema_migrations WHERE filename = $1", [filename]);
        if (existing.rowCount && existing.rowCount > 0) {
            const prev = existing.rows[0].checksum;
            if (Buffer.compare(prev, checksum) === 0) {
                skipped.push(filename);
                continue;
            }
            throw new Error(`[memory-postgres] migration drift: ${filename} checksum changed since last apply. ` +
                `Add a new file rather than editing applied SQL.`);
        }
        await pool.query("BEGIN");
        try {
            await pool.query(sql);
            await pool.query("INSERT INTO audit.schema_migrations (filename, checksum) VALUES ($1, $2)", [filename, checksum]);
            await pool.query("COMMIT");
            applied.push(filename);
        }
        catch (error) {
            await pool.query("ROLLBACK");
            throw new Error(`[memory-postgres] migration failed on ${filename}: ${error.message}`, { cause: error });
        }
    }
    // HNSW index is dim-locked, so we defer until embedding probe writes the
    // dimension to audit.plugin_meta. Returns whether we still need to do it.
    const hnswDeferred = !(await ensureHnswIndex(pool));
    return { applied, skipped, hnswDeferred };
}
/**
 * Create the HNSW vector index on semantic.chunks once we know the embedding
 * dimension. Returns true when the index now exists, false if dim is still
 * unknown (caller should retry after embedding probe).
 */
export async function ensureHnswIndex(pool) {
    const meta = await pool.query("SELECT value FROM audit.plugin_meta WHERE key = 'embedding.dims'");
    const dims = meta.rows[0]?.value?.dims;
    if (typeof dims !== "number" || dims <= 0) {
        return false;
    }
    // Check if index already exists.
    const existing = await pool.query(`SELECT 1 FROM pg_indexes
       WHERE schemaname = 'semantic'
         AND tablename  = 'chunks'
         AND indexname  = 'chunks_hnsw'`);
    if (existing.rowCount && existing.rowCount > 0) {
        return true;
    }
    // pgvector HNSW requires the column to be declared with a fixed dimension.
    // We migrated `embedding` as VECTOR (any dim) so the schema file can ship
    // before dims are known; here we promote it to VECTOR(N) once we have N
    // and add the HNSW index. Existing rows are preserved through a USING cast.
    await pool.query(`
    ALTER TABLE semantic.chunks
      ALTER COLUMN embedding TYPE VECTOR(${dims}) USING embedding::VECTOR(${dims});
    CREATE INDEX IF NOT EXISTS chunks_hnsw
      ON semantic.chunks USING hnsw (embedding vector_cosine_ops);
  `);
    return true;
}
export async function recordEmbeddingDims(pool, dims, model) {
    await pool.query(`INSERT INTO audit.plugin_meta (key, value, updated_at)
       VALUES ('embedding.dims', jsonb_build_object('dims', $1::int, 'model', $2::text), now())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now()`, [dims, model]);
}
