/**
 * Chunk invalidation fan-out — a memory edit must clear every cache tier so a
 * forgotten / rewritten chunk can't keep surfacing.
 *
 * Guards three fixes:
 *   - WorkingSet.evict() is actually called now (was dead code → T0 leaked).
 *   - QA answers derived from the chunk are invalidated (was never busted →
 *     same question, stale answer, for up to the 90-day TTL).
 *   - forgetChunk/updateChunk no longer error on the missing `updated_at`
 *     column (migration 63 adds it).
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool, closeAllPools } from "../src/storage/pool.js";
import { migrate } from "../src/storage/migrate.js";
import { workingSetFor, clearAllWorkingSets } from "../src/recall/working-set.js";
import { storeCachedAnswer } from "../src/cache/qa.js";
import { forgetChunk, type EditDeps } from "../src/edit/operations.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;
const poolCfg = { url: PG_URL ?? "postgres://x", poolMax: 4, statementTimeoutMs: 15_000 };

describeLive("chunk invalidation fan-out (live PG)", () => {
  beforeAll(async () => {
    const pool = await getPool(poolCfg);
    await pool.query(`DROP SCHEMA IF EXISTS semantic CASCADE; DROP SCHEMA IF EXISTS structured CASCADE;
      DROP SCHEMA IF EXISTS cache CASCADE; DROP SCHEMA IF EXISTS cold CASCADE; DROP SCHEMA IF EXISTS audit CASCADE;`);
    await migrate(pool);
  }, 60_000);

  afterAll(async () => {
    clearAllWorkingSets();
    await closeAllPools();
  });

  it("forgetChunk evicts T0, drops hot_chunks, and invalidates derived QA answers", async () => {
    const pool = await getPool(poolCfg);
    const chunkId = randomUUID();
    await pool.query(
      `INSERT INTO semantic.chunks
         (id, source, kind, text, text_hash, embedding, embedding_model, agent_id, retention_class, importance)
       VALUES ($1,'manual','fact','favorite extension is pgvector',$2,'[0.1,0.2,0.3]'::vector,'stub-embed:16','main','standard',0.5)`,
      [chunkId, "hash_" + chunkId],
    );

    const ws = workingSetFor(undefined, 50, "main", "default");
    ws.add({ chunkId, source: "manual", sourceRef: null, text: "favorite extension is pgvector",
      rawScore: 0.5, normScore: 0.5, hits: ["semantic"], combinedScore: 0.5 });
    await pool.query(`INSERT INTO cache.hot_chunks (user_scope, chunk_id, expires_at, warmth_score)
      VALUES ('default',$1, now()+interval '1 day', 1.0)`, [chunkId]);
    const qaId = await storeCachedAnswer(pool, {
      agentId: "main", questionText: "favorite extension?",
      questionEmbedding: [0.1, 0.2, 0.3, 0.4], embeddingModel: "stub-embed:16",
      answerText: "pgvector", sourceDocId: chunkId,
    });

    expect(ws.snapshot().some((e) => e.chunkId === chunkId)).toBe(true);

    const r = await forgetChunk({ pool } as unknown as EditDeps, { chunkId, agentId: "main", reason: "test" });
    expect(r.ok).toBe(true);

    // T0: evicted from the in-process working set.
    expect(ws.snapshot().some((e) => e.chunkId === chunkId)).toBe(false);
    // T1: hot_chunks dropped.
    const hot = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM cache.hot_chunks WHERE chunk_id=$1`, [chunkId]);
    expect(hot.rows[0].n).toBe(0);
    // QA: derived answer invalidated.
    const qa = await pool.query<{ invalidated: boolean }>(`SELECT invalidated FROM cache.qa WHERE id=$1`, [qaId]);
    expect(qa.rows[0].invalidated).toBe(true);
  });
});
