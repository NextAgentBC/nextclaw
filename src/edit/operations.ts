/**
 * Agent-driven memory edits: update / forget.
 *
 * These are the post-RAG-shaped tools — the agent doesn't just append to a
 * pile of chunks, it actively curates. Two operations:
 *
 *   - `updateChunk`  rewrites text / shifts importance / pins / changes
 *                    retention class on an existing chunk owned by the same
 *                    agent. Re-embeds. Writes an audit row tagged with
 *                    `ingest_path='edit_update'` so dashboard / scoring see
 *                    the lineage.
 *
 *   - `forgetChunk`  flips `retention_class` to `'trash'` (or `'tombstone'`
 *                    if hardDelete) and removes from hot caches. Soft by
 *                    default — the compactor sweeps trash on its cycle.
 *
 * Hard isolation guarantee: every operation checks `WHERE c.agent_id = $X`
 * so an `agent:club` call can never edit an `agent:main` chunk.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import pgvector from "pgvector/pg";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import type { EmbeddingClient } from "../embedding/client.js";

export type EditDeps = {
  cfg: ResolvedMemoryPostgresConfig;
  pool: Pool;
  embedding: EmbeddingClient;
};

export type UpdateChunkParams = {
  chunkId: string;
  agentId: string;
  /** New text body. When set, chunk is re-embedded. */
  text?: string;
  /** Override importance (0..1). */
  importance?: number;
  /** Switch retention class. */
  retentionClass?: "ephemeral" | "standard" | "pinned" | "trash" | "tombstone";
  /** Free-form reason recorded in audit for forensics. */
  reason?: string;
};

export type UpdateChunkOutcome =
  | { ok: true; chunkId: string; reEmbedded: boolean }
  | { ok: false; reason: "not-found" | "wrong-agent" | "no-changes" | string };

export async function updateChunk(
  deps: EditDeps,
  params: UpdateChunkParams,
): Promise<UpdateChunkOutcome> {
  const existing = await deps.pool.query<{ agent_id: string; text: string }>(
    `SELECT agent_id, text FROM semantic.chunks WHERE id = $1`,
    [params.chunkId],
  );
  if (existing.rowCount === 0) {return { ok: false, reason: "not-found" };}
  if (existing.rows[0].agent_id !== params.agentId) {
    return { ok: false, reason: "wrong-agent" };
  }

  const setClauses: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  let p = 1;
  let reEmbedded = false;

  if (typeof params.text === "string" && params.text.length >= 1 && params.text !== existing.rows[0].text) {
    setClauses.push(`text = $${p}`); values.push(params.text); p += 1;
    // Re-embed. The cache key is text_hash + model so a fresh hash skips it
    // automatically; we just call embed() and write the new vector directly.
    const truncated = params.text.slice(0, deps.cfg.embedding.maxEmbedChars);
    const result = await deps.embedding.embed({ inputs: [truncated] });
    const vec = result.embeddings[0] ?? [];
    setClauses.push(`embedding = $${p}::vector`); values.push(pgvector.toSql(vec)); p += 1;
    reEmbedded = true;
  }
  if (typeof params.importance === "number" && Number.isFinite(params.importance)) {
    const imp = Math.max(0, Math.min(1, params.importance));
    setClauses.push(`importance = $${p}`); values.push(imp); p += 1;
  }
  if (params.retentionClass) {
    setClauses.push(`retention_class = $${p}`); values.push(params.retentionClass); p += 1;
  }

  if (setClauses.length === 1 /* only updated_at */) {
    return { ok: false, reason: "no-changes" };
  }

  // Append id + agent_id filter to the WHERE clause.
  const idParam = p; const agentParam = p + 1;
  await deps.pool.query(
    `UPDATE semantic.chunks SET ${setClauses.join(", ")}
       WHERE id = $${idParam} AND agent_id = $${agentParam}`,
    [...values, params.chunkId, params.agentId],
  );

  // Audit row. Reuse the ingest_decisions table because that's where the
  // dashboard's "memory lifecycle" view aggregates from; `ingest_path` of
  // `edit_update` clearly marks the lineage.
  await deps.pool
    .query(
      `INSERT INTO audit.ingest_decisions
         (id, source, agent_session_id, agent_id, decision, ingest_path,
          score, text_hash, chunk_id, reason, scored_at)
       VALUES ($1, 'edit', null, $2, 'updated', 'edit_update',
               100, '', $3, $4, now())`,
      [randomUUID(), params.agentId, params.chunkId, params.reason ?? null],
    )
    .catch(() => { /* audit-write failures must not break the edit */ });

  // Invalidate cache.recall entries that might have surfaced this chunk
  // with stale text. Cheap broad invalidation; cache.recall is UNLOGGED.
  await deps.pool
    .query(`UPDATE cache.recall SET invalidated = true WHERE invalidated = false`)
    .catch(() => undefined);
  // Drop hot_chunks for this chunk so T1 doesn't keep the old warmth.
  await deps.pool
    .query(`DELETE FROM cache.hot_chunks WHERE chunk_id = $1`, [params.chunkId])
    .catch(() => undefined);

  return { ok: true, chunkId: params.chunkId, reEmbedded };
}

export type ForgetChunkParams = {
  chunkId: string;
  agentId: string;
  /** When true, hard-tombstone instead of soft-trash. Compactor still
   *  needs the row for source_chunk_ids back-references, so the row stays
   *  (just becomes invisible to recall) — true tombstone deletes the row
   *  but breaks cold-gist back-references. Default false. */
  hardDelete?: boolean;
  reason?: string;
};

export type ForgetChunkOutcome =
  | { ok: true; chunkId: string; mode: "trash" | "tombstone"; deletedRow: boolean }
  | { ok: false; reason: "not-found" | "wrong-agent" };

export async function forgetChunk(
  deps: EditDeps,
  params: ForgetChunkParams,
): Promise<ForgetChunkOutcome> {
  const existing = await deps.pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM semantic.chunks WHERE id = $1`,
    [params.chunkId],
  );
  if (existing.rowCount === 0) {return { ok: false, reason: "not-found" };}
  if (existing.rows[0].agent_id !== params.agentId) {
    return { ok: false, reason: "wrong-agent" };
  }

  const mode = params.hardDelete ? "tombstone" : "trash";

  if (params.hardDelete) {
    await deps.pool.query(`DELETE FROM semantic.chunks WHERE id = $1 AND agent_id = $2`, [
      params.chunkId, params.agentId,
    ]);
    await deps.pool.query(`DELETE FROM semantic.chunk_indexes WHERE chunk_id = $1`, [params.chunkId])
      .catch(() => undefined);
    await deps.pool.query(`DELETE FROM cache.hot_chunks WHERE chunk_id = $1`, [params.chunkId])
      .catch(() => undefined);
  } else {
    await deps.pool.query(
      `UPDATE semantic.chunks
          SET retention_class = 'trash',
              updated_at = now()
        WHERE id = $1 AND agent_id = $2`,
      [params.chunkId, params.agentId],
    );
    await deps.pool.query(`DELETE FROM cache.hot_chunks WHERE chunk_id = $1`, [params.chunkId])
      .catch(() => undefined);
  }
  // Bust cache.recall broadly — cheap, UNLOGGED.
  await deps.pool
    .query(`UPDATE cache.recall SET invalidated = true WHERE invalidated = false`)
    .catch(() => undefined);

  await deps.pool
    .query(
      `INSERT INTO audit.ingest_decisions
         (id, source, agent_session_id, agent_id, decision, ingest_path,
          score, text_hash, chunk_id, reason, scored_at)
       VALUES ($1, 'edit', null, $2, $3, 'edit_forget',
               100, '', $4, $5, now())`,
      [randomUUID(), params.agentId, mode === "tombstone" ? "tombstoned" : "trashed",
       params.chunkId, params.reason ?? null],
    )
    .catch(() => undefined);

  return { ok: true, chunkId: params.chunkId, mode, deletedRow: params.hardDelete === true };
}
