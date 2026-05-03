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
import type { Pool } from "pg";

export type CacheBackend = "pg-unlogged" | "memory" | "redis";

export type EmbeddingCacheEntry = {
  embedding: number[];
  model: string;
};

export interface EmbeddingCache {
  readonly backend: CacheBackend;
  get(textHash: Buffer, model: string): Promise<EmbeddingCacheEntry | null>;
  set(textHash: Buffer, entry: EmbeddingCacheEntry): Promise<void>;
}

export function hashTextForCache(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

export class PgEmbeddingCache implements EmbeddingCache {
  readonly backend: CacheBackend = "pg-unlogged";
  constructor(private readonly pool: Pool) {}

  async get(textHash: Buffer, model: string): Promise<EmbeddingCacheEntry | null> {
    const rows = await this.pool.query<{ embedding: number[] | string; model: string }>(
      `SELECT embedding, model FROM cache.embeddings
         WHERE text_hash = $1 AND model = $2
         LIMIT 1`,
      [textHash, model],
    );
    if (rows.rowCount === 0) {return null;}
    const row = rows.rows[0];
    // pgvector type parser returns number[] when registered (pool.ts does so on
    // first connection acquisition). If not (cold pool), it's a string we
    // fall back to parsing.
    const vec = Array.isArray(row.embedding)
      ? row.embedding
      : (JSON.parse(row.embedding) as number[]);
    return { embedding: vec, model: row.model };
  }

  async set(textHash: Buffer, entry: EmbeddingCacheEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO cache.embeddings (text_hash, model, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (text_hash) DO UPDATE
           SET embedding = EXCLUDED.embedding,
               model     = EXCLUDED.model,
               created_at = now()`,
      [textHash, entry.model, pgvector.toSql(entry.embedding)],
    );
  }
}

/**
 * In-memory cache for tests + cold-start scenarios. Bounded LRU at ~1000 entries.
 */
export class MemoryEmbeddingCache implements EmbeddingCache {
  readonly backend: CacheBackend = "memory";
  private readonly entries = new Map<string, EmbeddingCacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  private static keyFor(textHash: Buffer, model: string): string {
    return `${model}|${textHash.toString("hex")}`;
  }

  async get(textHash: Buffer, model: string): Promise<EmbeddingCacheEntry | null> {
    const key = MemoryEmbeddingCache.keyFor(textHash, model);
    const entry = this.entries.get(key);
    if (!entry) {return null;}
    // LRU: re-insert to mark fresh.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  async set(textHash: Buffer, entry: EmbeddingCacheEntry): Promise<void> {
    const key = MemoryEmbeddingCache.keyFor(textHash, entry.model);
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) {this.entries.delete(firstKey);}
    }
  }

  /** Test affordance — current size. */
  size(): number {
    return this.entries.size;
  }
}
