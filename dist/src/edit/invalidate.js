/**
 * Unified chunk invalidation — the single fan-out run after any memory edit
 * (update / forget; future supersede hangs off the same entry point). Keeps the
 * four cache tiers from serving a fact that just changed:
 *
 *   T0  in-process working sets  → evict the chunk from every session
 *   T1  cache.hot_chunks         → drop the chunk's hot entry
 *   T2  cache.recall             → broad bust (UNLOGGED, cheap)
 *   QA  cache.qa                 → invalidate answers derived from the chunk
 *
 * Before this, update/forget busted recall + hot_chunks but left T0 stale (its
 * evict() had no caller) and never touched the QA cache — the most dangerous
 * gap: same question, stale answer, for up to the cache's 90-day TTL.
 *
 * Every step is fail-soft: an invalidation hiccup must not break the edit that
 * triggered it (the data write already committed).
 */
import { evictFromAllWorkingSets } from "../recall/working-set.js";
import { invalidateCachedAnswersByDoc } from "../cache/qa.js";
export async function invalidateChunk(pool, chunkId, reason) {
    // T0 — in-process, synchronous.
    evictFromAllWorkingSets(chunkId);
    // T1 — drop the chunk's hot-cache entry.
    await pool
        .query(`DELETE FROM cache.hot_chunks WHERE chunk_id = $1`, [chunkId])
        .catch(() => undefined);
    // T2 — broad bust of the query-result cache (UNLOGGED, ephemeral).
    await pool
        .query(`UPDATE cache.recall SET invalidated = true WHERE invalidated = false`)
        .catch(() => undefined);
    // QA — answers derived from this chunk.
    await invalidateCachedAnswersByDoc(pool, chunkId, reason).catch(() => undefined);
}
