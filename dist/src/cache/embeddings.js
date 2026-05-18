/**
 * Embedding cache backend (PG UNLOGGED).
 *
 * Phase 3 lookup: `text_hash → vector` so re-ingesting / re-querying the same
 * text doesn't re-call qwen3. Phase 4 will add intent/recall caches with the
 * same shape.
 *
 * The interface (`EmbeddingCache`) lets a future Phase swap to Redis without
 * touching ingest/recall code.
 */
import { createHash } from "node:crypto";
import pgvector from "pgvector/pg";
export function hashTextForCache(text) {
    return createHash("sha256").update(text, "utf8").digest();
}
export class PgEmbeddingCache {
    pool;
    backend = "pg-unlogged";
    constructor(pool) {
        this.pool = pool;
    }
    async get(textHash, model) {
        const rows = await this.pool.query(`SELECT embedding, model FROM cache.embeddings
         WHERE text_hash = $1 AND model = $2
         LIMIT 1`, [textHash, model]);
        if (rows.rowCount === 0) {
            return null;
        }
        const row = rows.rows[0];
        // pgvector type parser returns number[] when registered (pool.ts does so on
        // first connection acquisition). If not (cold pool), it's a string we
        // fall back to parsing.
        const vec = Array.isArray(row.embedding)
            ? row.embedding
            : JSON.parse(row.embedding);
        return { embedding: vec, model: row.model };
    }
    async set(textHash, entry) {
        await this.pool.query(`INSERT INTO cache.embeddings (text_hash, model, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (text_hash) DO UPDATE
           SET embedding = EXCLUDED.embedding,
               model     = EXCLUDED.model,
               created_at = now()`, [textHash, entry.model, pgvector.toSql(entry.embedding)]);
    }
}
/**
 * In-memory cache for tests + cold-start scenarios. Bounded LRU at ~1000 entries.
 */
export class MemoryEmbeddingCache {
    backend = "memory";
    entries = new Map();
    maxSize;
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
    }
    static keyFor(textHash, model) {
        return `${model}|${textHash.toString("hex")}`;
    }
    async get(textHash, model) {
        const key = MemoryEmbeddingCache.keyFor(textHash, model);
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        // LRU: re-insert to mark fresh.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }
    async set(textHash, entry) {
        const key = MemoryEmbeddingCache.keyFor(textHash, entry.model);
        this.entries.delete(key);
        this.entries.set(key, entry);
        if (this.entries.size > this.maxSize) {
            const firstKey = this.entries.keys().next().value;
            if (firstKey !== undefined) {
                this.entries.delete(firstKey);
            }
        }
    }
    /** Test affordance — current size. */
    size() {
        return this.entries.size;
    }
}
