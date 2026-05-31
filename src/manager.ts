/**
 * MemorySearchManager backed by Postgres + pgvector.
 *
 * Phase 1 scope:
 *   - search(): hybrid (vector + tsvector) over semantic.chunks
 *   - readFile(): not applicable (PG-only); returns a stub path entry
 *   - status(): runtime introspection
 *   - probe*(): reachability checks for embedding + pgvector
 *   - close(): pool teardown
 *
 * Multi-key index writes (chunk_indexes anchor_*, concept_tag, ...) and the
 * tier-walk recall path land in later phases. This module already writes
 * audit.recall_decisions on every search so the dashboard has data from day 1.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import pgvector from "pgvector/pg";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { ResolvedMemoryPostgresConfig } from "./config.js";
import { EmbeddingClient } from "./embedding/client.js";
import { recall as recallTierWalk } from "./recall/router.js";
import { recordEmbeddingDims } from "./storage/migrate.js";
import type { PgPool } from "./storage/pool.js";

const RECALL_DEFAULT_K = 12;

export type ManagerDeps = {
  cfg: ResolvedMemoryPostgresConfig;
  pool: PgPool;
  embedding: EmbeddingClient;
};

export class PostgresMemoryManager implements MemorySearchManager {
  private cachedProbe: MemoryEmbeddingProbeResult | null = null;
  private dims: number | undefined;

  constructor(private readonly deps: ManagerDeps) {}

  /* ------------------------------- search ----------------------------------- */

  /**
   * Phase 4: search delegates to the tier-walk recall router. The router
   * handles cache lookup, structured-route fast paths, semantic fan-out, MMR
   * rerank, and audit + scoring writes. The manager's job is only adapter
   * shape: take MemorySearchManager inputs and return MemorySearchResult[].
   */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      onDebug?: (debug: unknown) => void;
    },
  ): Promise<MemorySearchResult[]> {
    const k = Math.max(1, opts?.maxResults ?? RECALL_DEFAULT_K);
    const result = await recallTierWalk(this.deps, {
      query,
      maxResults: k,
      minScore: opts?.minScore,
      agentSessionId: opts?.sessionKey,
    });
    return result.results.map<MemorySearchResult>((c) => {
      const semHit = c.hits.includes("semantic") ? c.normScore : undefined;
      const ftsHit = c.hits.includes("fulltext") ? c.normScore : undefined;
      return {
        path: c.sourceRef ?? `pg://${c.source}/${c.chunkId}`,
        startLine: 0,
        endLine: 0,
        score: c.combinedScore,
        vectorScore: semHit,
        textScore: ftsHit,
        snippet: c.text.slice(0, 1000),
        source: "memory",
        citation: `pg://${c.source}/${c.chunkId}`,
      };
    });
  }

  async readFile(_params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult> {
    // PG-only manager: no on-disk file surface in Phase 1.
    return {
      relPath: _params.relPath,
      lines: [],
      truncated: false,
      totalLines: 0,
      startLine: 0,
      endLine: 0,
    } as unknown as MemoryReadResult;
  }

  status(): MemoryProviderStatus {
    const embeddingProbe: MemoryEmbeddingProbeResult = this.cachedProbe ?? { ok: false };
    return {
      ready:  embeddingProbe.ok,
      embeddingProbe,
      vector: { ok:  embeddingProbe.ok },
      backend: { kind: "postgres", model: this.deps.cfg.embedding.model },
    } as unknown as MemoryProviderStatus;
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    return this.cachedProbe;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const result = await this.deps.embedding.probe();
    if (result.ok) {
      this.cachedProbe = {
        ok: true,
        checked: true,
        cached: false,
        checkedAtMs: Date.now(),
      };
      await this.maybeRecordDims(result.dims);
    } else {
      this.cachedProbe = {
        ok: false,
        error: result.error,
        checked: true,
        cached: false,
        checkedAtMs: Date.now(),
      };
    }
    return this.cachedProbe;
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const result = await this.deps.pool.query<{ ok: boolean }>(
        "SELECT (count(*) > 0) AS ok FROM pg_extension WHERE extname = 'vector'",
      );
      return  result.rows[0]?.ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Pool lifecycle owned by the runtime module — manager only releases
    // its references and audit-write Promises.
  }

  /* ------------------------------- internals -------------------------------- */

  private async maybeRecordDims(dims: number): Promise<void> {
    if (this.dims === dims) {return;}
    this.dims = dims;
    try {
      await recordEmbeddingDims(this.deps.pool, dims, this.deps.cfg.embedding.model);
    } catch (err) {
      console.warn("[memory-postgres] failed to record embedding.dims:", (err as Error).message);
    }
  }
}

/* ------------------------------- chunk write -------------------------------- */

export type ChunkWriteInput = {
  text: string;
  source: string;
  sourceRef?: string;
  kind?: string;
  agentSessionId?: string;
  retentionClass?: "ephemeral" | "standard" | "pinned";
  importance?: number;
};

export function hashTextBytes(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/**
 * Insert a chunk and the minimum default chunk_indexes rows. This is the Phase 1
 * write path used by tests and by the manager-runtime smoke calls. Phase 3
 * adds the full ingest pipeline (Stage 0–6).
 */
export async function writeChunk(
  pool: PgPool,
  embedding: EmbeddingClient,
  input: ChunkWriteInput,
): Promise<{ id: string; written: boolean }> {
  const id = randomUUID();
  const textHash = hashTextBytes(input.text);
  const dup = await pool.query<{ id: string }>(
    "SELECT id FROM semantic.chunks WHERE text_hash = $1 AND source = $2",
    [textHash, input.source],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    // Dedup hit: this is a re-ingest, not a recall. Bump last_seen_at / dup_count
    // and leave last_recalled_at + recall_count untouched — the cold-gist
    // compactor ages chunks by last_recalled_at, so conflating the two would
    // keep re-seen chunks perpetually "warm" and they'd never compact.
    // See src/storage/schema/60-last-seen.sql.
    await pool.query(
      "UPDATE semantic.chunks SET last_seen_at = now(), dup_count = dup_count + 1 WHERE id = $1",
      [dup.rows[0].id],
    );
    return { id: dup.rows[0].id, written: false };
  }
  const embed = await embedding.embed({ inputs: [input.text] });
  const vec = embed.embeddings[0];
  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO semantic.chunks
         (id, source, source_ref, kind, text, text_hash,
          embedding, embedding_model, agent_session_id, retention_class, importance)
        VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11)`,
      [
        id,
        input.source,
        input.sourceRef ?? null,
        input.kind ?? "fact",
        input.text,
        textHash,
        pgvector.toSql(vec),
        embed.model,
        input.agentSessionId ?? null,
        input.retentionClass ?? "standard",
        input.importance ?? 0.5,
      ],
    );
    // Always-attach indexes: time bucket + session anchor (Phase 1 minimum).
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO semantic.chunk_indexes (chunk_id, kind, value)
         VALUES ($1, 'time_bucket', $2)
         ON CONFLICT DO NOTHING`,
      [id, today],
    );
    if (input.agentSessionId) {
      await pool.query(
        `INSERT INTO semantic.chunk_indexes (chunk_id, kind, value)
           VALUES ($1, 'anchor_session', $2)
           ON CONFLICT DO NOTHING`,
        [id, input.agentSessionId],
      );
    }
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
  return { id, written: true };
}
