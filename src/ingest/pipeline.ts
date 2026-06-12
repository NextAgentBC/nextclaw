/**
 * Ingest pipeline orchestrator (Stage 0 → 6).
 *
 * Phase 3 wiring:
 *   - Stage 0 deterministic signals via extractAll() (already in Phase 2)
 *   - Stage 1 trash filter
 *   - Stage 2 sidecar parse + merge
 *   - Stage 3 cache lookup (embedding cache)
 *   - Stage 4 LLM residual — left as a hook (extractorResidual?:Fn) since
 *     Phase 3 doesn't bind a model directly; pipeline tolerates absence.
 *   - Stage 5 multi-key index writes (semantic.chunk_indexes)
 *   - Stage 6 reconcile + provenance + audit + scoring
 *
 * Scoring: every accepted/rejected/merged/quarantined chunk writes one
 * audit.ingest_decisions row with score + ingest_path + token usage.
 */

import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import pgvector from "pgvector/pg";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import type { EmbeddingClient } from "../embedding/client.js";
import {
  computeIngestScore,
  type IngestDecision,
  type IngestPath,
} from "../scoring.js";
import { extractAll } from "../structured/extractors.js";
import { reconcile } from "../structured/reconcile.js";
import type { ExtractorResult } from "../structured/types.js";
import { categorize, applyCategoryPolicy, type CategoryHit } from "../structured/categorizer.js";
import {
  hashTextForCache,
  MemoryEmbeddingCache,
  type EmbeddingCache,
  type EmbeddingCacheEntry,
} from "../cache/embeddings.js";
import {
  mergeExtractorResults,
  parseSidecar,
  type SidecarParseResult,
} from "./sidecar.js";
import { trashFilter, type TrashReason } from "./trash.js";

export type IngestInput = {
  text: string;
  source: string;                     // 'session'|'manual'|'dream'|'tool_call'|...
  sourceRef?: string;
  kind?: string;
  /** Owning agent id — drives memory namespace isolation. Default 'main'. */
  agentId?: string;
  agentSessionId?: string;
  retentionClass?: "ephemeral" | "standard" | "pinned";
  importance?: number;
  /** Deterministic signals carried from upstream (tool calls, anchors). */
  signals?: Record<string, unknown>;
  /**
   * Anchors to attach as multi-key chunk_indexes rows. e.g. cwd, branch,
   * pr number, file path. Stage 5 in the plan.
   */
  anchors?: Partial<{
    cwd: string;
    branch: string;
    pr: string;
    file: string;
    channel: string;
    chat_id: string;
    sender_id: string;
    sender_label: string;
    scope: string;
    visibility: string;
  }>;
  /** Optional sidecar text (the agent's <mem>...</mem> block). */
  sidecarText?: string;
  dreamRunId?: string | null;
  now?: Date;
};

export type IngestDeps = {
  cfg: ResolvedMemoryPostgresConfig;
  pool: Pool;
  embedding: EmbeddingClient;
  cache?: EmbeddingCache;
  /** Optional Stage 4 hook; called only when stages 0-3 didn't yield strong signals. */
  llmResidual?: (text: string, signals: Record<string, unknown>) => Promise<{
    result: ExtractorResult;
    tokensUsed: number;
  }>;
};

export type IngestOutcome = {
  decision: IngestDecision | "rejected";
  rejectReason?: TrashReason | "duplicate" | "low_salience" | "sidecar_bad_json";
  ingestPath: IngestPath;
  chunkId?: string;
  routes: string[];
  llmTokensUsed: number;
  latencyMs: number;
  score: number;
  reconcileDedupCount?: number;
  sidecar?: { found: boolean; ok: boolean };
};

const DEFAULT_KIND = "fact";

/* ----------------------------- residual gating ---------------------------- */
// Stage 4 LLM residual fires when deterministic extraction is weak by COMBINED
// CONFIDENCE (this subsumes the old empty-only gate). Two guards bound the cost
// of deep extraction. Tunable; promote to config if the residual gets wired.
const RESIDUAL_CONFIDENCE_THRESHOLD = 0.7;
const RESIDUAL_MAX_CHARS = 4000;
const RESIDUAL_DAILY_TOKEN_BUDGET = 50_000;

/* ------------------------- concept_tag derivation ------------------------- */
/**
 * Stage 0 deterministic concept_tag derivation. No LLM, no embeddings.
 * Picks up to MAX_TAGS salient lowercased tokens from the text:
 *   - hyphenated identifiers (`memory-postgres`, `transcript-watcher`)
 *   - camelCase split into parts (`firstRunBackfillBytes` → first/run/backfill/bytes)
 *   - CJK proper nouns (run of CJK chars, length 2-6)
 *   - alphanumeric tokens length ≥ 4 that survive a stop-word filter
 *
 * Stop-words: short/common/conversational. Tokenized text already in fulltext
 * via tsvector — concept_tag is for *cross-chunk co-occurrence routing*, so
 * we want salient nouns, not generic verbs.
 */
const CONCEPT_TAG_MAX = 10;
const STOP_WORDS_EN = new Set([
  "the","and","with","from","that","this","into","onto","over","under",
  "have","has","had","was","were","been","being","does","did","will","would",
  "could","should","than","then","also","just","more","most","very","really",
  "what","when","where","which","while","there","their","them","they",
  "your","yours","mine","ours","about","into","such","some","any","all",
]);

function deriveConceptTags(text: string): string[] {
  const seen = new Map<string, number>();
  const bump = (tag: string) => {
    const t = tag.toLowerCase();
    if (t.length < 2 || t.length > 32) {return;}
    if (STOP_WORDS_EN.has(t)) {return;}
    seen.set(t, (seen.get(t) ?? 0) + 1);
  };

  // Hyphenated identifiers: keep whole + parts.
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z][A-Za-z0-9]+)+/g)) {
    bump(m[0]);
    for (const part of m[0].split("-")) {bump(part);}
  }
  // camelCase / PascalCase identifiers: split runs of UPPER+lower into parts.
  for (const m of text.matchAll(/\b[A-Za-z][a-z]+(?:[A-Z][a-z]+)+\b/g)) {
    const word = m[0];
    bump(word);
    for (const part of word.split(/(?=[A-Z])/)) {bump(part);}
  }
  // CJK proper nouns: 2-6 contiguous CJK chars.
  for (const m of text.matchAll(/[一-鿿]{2,6}/g)) {bump(m[0]);}
  // Plain alphanumeric tokens length ≥ 4.
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/g)) {bump(m[0]);}

  // Score by frequency, then length (longer = more specific). Cap to MAX.
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, CONCEPT_TAG_MAX)
    .map(([tag]) => tag);
}

export const _conceptTagInternal = { deriveConceptTags };

/** Average confidence across all extracted candidates; 0 when nothing fired. */
function combinedConfidence(r: ExtractorResult): number {
  const confs = [
    ...r.entities.map((e) => e.confidence),
    ...r.events.map((e) => e.confidence),
    ...r.preferences.map((p) => p.confidence),
    ...r.metrics.map((m) => m.confidence),
    ...r.relations.map((x) => x.confidence),
  ];
  if (confs.length === 0) {return 0;}
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}

export const _residualInternal = { combinedConfidence };

/** Residual LLM tokens already spent today (UTC day) — the daily-budget guard. */
async function residualTokensSpentToday(pool: Pool): Promise<number> {
  const r = await pool.query<{ sum: string | null }>(
    `SELECT coalesce(sum(llm_tokens_used), 0)::text AS sum
       FROM audit.ingest_decisions
      WHERE ingest_path = 'llm_residual'
        AND scored_at >= date_trunc('day', now())`,
  );
  return Number(r.rows[0]?.sum ?? 0);
}

/* ----------------------------- multi-key idx ------------------------------ */

async function writeMultiKeyIndexes(
  pool: Pool,
  chunkId: string,
  input: IngestInput,
  result: ExtractorResult,
  categories: CategoryHit[],
  now: Date,
): Promise<string[]> {
  const inserts: Array<[string, string]> = [];
  const today = now.toISOString().slice(0, 10);
  inserts.push(["time_bucket", today]);
  if (input.agentSessionId) {inserts.push(["anchor_session", input.agentSessionId]);}
  if (input.anchors?.cwd) {inserts.push(["anchor_cwd", input.anchors.cwd]);}
  if (input.anchors?.branch) {inserts.push(["anchor_branch", input.anchors.branch]);}
  if (input.anchors?.pr) {inserts.push(["anchor_pr", input.anchors.pr]);}
  if (input.anchors?.file) {inserts.push(["anchor_file", input.anchors.file]);}
  if (input.anchors?.channel) {inserts.push(["anchor_channel", input.anchors.channel]);}
  if (input.anchors?.chat_id) {inserts.push(["anchor_chat_id", input.anchors.chat_id]);}
  if (input.anchors?.sender_id) {inserts.push(["anchor_sender_id", input.anchors.sender_id]);}
  if (input.anchors?.sender_label) {inserts.push(["anchor_sender_label", input.anchors.sender_label]);}
  if (input.anchors?.scope) {inserts.push(["anchor_scope", input.anchors.scope]);}
  if (input.anchors?.visibility) {inserts.push(["anchor_visibility", input.anchors.visibility]);}
  for (const ev of result.events) {inserts.push(["event_type", ev.type]);}
  for (const m of result.metrics)  {inserts.push(["metric_name", m.metric]);}
  for (const p of result.preferences) {
    inserts.push(["preference_key", `${p.scope}:${p.key}`]);
  }
  // Stage 0 deterministic concept_tag derivation (hyphenated/camelCase/CJK).
  // 0 LLM tokens. Sidecar/LLM-residual paths can later add more via the same
  // chunk_indexes UNIQUE constraint (kind, value) — duplicates drop on insert.
  for (const tag of deriveConceptTags(input.text)) {
    inserts.push(["concept_tag", tag]);
  }
  // Multi-label taxonomy classification (health/medical/tech/life/work/
  // finance/other). Each chunk gets ≥1 category row so "show me all <cat>"
  // queries are simple one-row fan-outs.
  for (const c of categories) {
    inserts.push(["category", c.category]);
  }
  // entity_ref handled after reconcile (we need entity ids); see below.

  const routes = new Set<string>(inserts.map(([k]) => k));
  // Parallel INSERTs — each row is independent, ON CONFLICT DO NOTHING makes
  // them idempotent even on duplicate (chunk_id, kind, value) tuples. Cuts
  // 50-100ms vs sequential await on a long-route chunk.
  await Promise.all(
    inserts.map(([kind, value]) =>
      pool.query(
        `INSERT INTO semantic.chunk_indexes (chunk_id, kind, value)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [chunkId, kind, value],
      ),
    ),
  );
  return [...routes];
}

async function writeEntityRefIndexes(
  pool: Pool,
  chunkId: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) {return;}
  await Promise.all(
    entityIds.map((id) =>
      pool.query(
        `INSERT INTO semantic.chunk_indexes (chunk_id, kind, value)
           VALUES ($1, 'entity_ref', $2) ON CONFLICT DO NOTHING`,
        [chunkId, id],
      ),
    ),
  );
}

/* -------------------------------- pipeline -------------------------------- */

export async function ingestOne(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
  const start = Date.now();
  const now = input.now ?? new Date();
  const text = input.text;
  const source = input.source;
  const dreamRunId = input.dreamRunId ?? null;
  const cache: EmbeddingCache = deps.cache ?? new MemoryEmbeddingCache();
  let llmTokensUsed = 0;

  // ---------- Stage 1 trash ----------
  const trash = trashFilter(text);
  const earlyAgentId = input.agentId ?? "main";
  if (!trash.ok) {
    return finalize(
      deps, source, text, earlyAgentId, dreamRunId, start,
      {
        decision: "rejected",
        rejectReason: trash.reason,
        ingestPath: "deterministic",
        routes: [],
        llmTokensUsed,
        latencyMs: 0,
        score: 0,
      },
    );
  }

  // ---------- Stage 0 deterministic + Stage 2 sidecar (parallel feasibility) ----
  const det = extractAll({ text, source, signals: input.signals, now });
  let sidecar: SidecarParseResult | null = null;
  let path: IngestPath = "deterministic";
  let extractor: ExtractorResult = det;
  if (input.sidecarText) {
    sidecar = parseSidecar(input.sidecarText, now);
    if (sidecar.found && sidecar.ok) {
      extractor = mergeExtractorResults(sidecar.result, det);
      path = "sidecar";
    } else if (sidecar.found && !sidecar.ok) {
      // Bad JSON — fall back to deterministic.
      path = "deterministic";
    }
  }

  // ---------- Stage 4 LLM residual ----------
  // Fire on LOW CONFIDENCE, not just emptiness: a chunk where the regex
  // extractors caught only a little, weakly, is exactly where the long tail
  // (coreference, implicit preferences, cross-turn facts) hides. Two guards
  // keep deep extraction from running away on cost — a per-chunk char cap and
  // a daily token budget. (Inert until a residual model is bound to
  // deps.llmResidual; the gate is ready for when it is.)
  const detConf = combinedConfidence(det);
  const sideConf = sidecar?.ok ? combinedConfidence(sidecar.result) : 0;
  const weak = detConf < RESIDUAL_CONFIDENCE_THRESHOLD && sideConf < RESIDUAL_CONFIDENCE_THRESHOLD;
  if (weak && deps.llmResidual && text.length <= RESIDUAL_MAX_CHARS) {
    const spentToday = await residualTokensSpentToday(deps.pool).catch(() => 0);
    if (spentToday < RESIDUAL_DAILY_TOKEN_BUDGET) {
      const r = await deps.llmResidual(text, input.signals ?? {});
      llmTokensUsed += r.tokensUsed;
      extractor = mergeExtractorResults(r.result, extractor);
      path = "llm_residual";
    }
  }

  // ---------- Stage 3 cache + write semantic.chunks ----------
  const textHash = hashTextForCache(text);

  // Dedup against existing chunks.
  const dup = await deps.pool.query<{ id: string }>(
    "SELECT id FROM semantic.chunks WHERE text_hash = $1 AND source = $2",
    [textHash, source],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    const id = dup.rows[0].id;
    // Re-ingest (dedup), not a recall — bump last_seen_at / dup_count only.
    // last_recalled_at stays reserved for genuine recall hits so the cold
    // compactor can still age these chunks. See storage/schema/60-last-seen.sql.
    await deps.pool.query(
      "UPDATE semantic.chunks SET last_seen_at = now(), dup_count = dup_count + 1 WHERE id = $1",
      [id],
    );
    return finalize(
      deps, source, text, earlyAgentId, dreamRunId, start,
      {
        decision: "merged",
        ingestPath: path,
        chunkId: id,
        routes: [],
        llmTokensUsed,
        latencyMs: 0,
        score: 0,
        sidecar: sidecar ? { found: sidecar.found, ok: sidecar.ok } : undefined,
      },
    );
  }

  // Embed (with cache). Truncate to maxEmbedChars so very long texts don't
  // pin the GPU for seconds — the full text still lives in chunks.text and
  // remains recoverable via tsvector / trgm. The first ~2 KB usually
  // contains the gist of any reply.
  const maxEmbedChars = deps.cfg.embedding.maxEmbedChars;
  const embedInput = text.length > maxEmbedChars ? text.slice(0, maxEmbedChars) : text;
  let embedding: EmbeddingCacheEntry | null = await cache.get(textHash, deps.cfg.embedding.model);
  if (!embedding) {
    const embed = await deps.embedding.embed({ inputs: [embedInput] });
    embedding = { embedding: embed.embeddings[0] ?? [], model: embed.model };
    await cache.set(textHash, embedding);
  } else {
    // Cache-hit path.
    if (path === "deterministic") {path = "cache";}
  }

  // Stage 0 deterministic taxonomy classification. health/medical content
  // gets retention='pinned' + importance≥0.7 automatically (the operator's standing
  // privacy policy is honored without LLM-in-the-loop).
  const categories = categorize(text);
  const policy = applyCategoryPolicy(categories, {
    importance: input.importance,
    retentionClass: input.retentionClass,
  });

  // Insert chunk + multi-key indexes + run reconcile, all in a single chain.
  const chunkId = randomUUID();
  const agentId = input.agentId ?? "main";
  await deps.pool.query(
    `INSERT INTO semantic.chunks
       (id, source, source_ref, kind, text, text_hash, embedding, embedding_model,
        agent_session_id, agent_id, retention_class, importance)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11, $12)`,
    [
      chunkId,
      source,
      input.sourceRef ?? null,
      input.kind ?? DEFAULT_KIND,
      text,
      textHash,
      pgvector.toSql(embedding.embedding),
      embedding.model,
      input.agentSessionId ?? null,
      agentId,
      policy.retentionClass ?? "standard",
      policy.importance ?? 0.5,
    ],
  );

  const routes = await writeMultiKeyIndexes(deps.pool, chunkId, input, extractor, categories, now);

  const reconcileOut = await reconcile(deps.pool, {
    chunkId,
    rawExcerpt: text,
    result: extractor,
    dreamRunId,
    agentId,
  });
  await writeEntityRefIndexes(deps.pool, chunkId, reconcileOut.entityIds);
  if (reconcileOut.entityIds.length > 0) {routes.push("entity_ref");}

  // Aggregate extractor confidence for ingest score.
  const allConfs = [
    ...extractor.entities.map((e) => e.confidence),
    ...extractor.events.map((e) => e.confidence),
    ...extractor.preferences.map((p) => p.confidence),
    ...extractor.metrics.map((m) => m.confidence),
    ...extractor.relations.map((r) => r.confidence),
  ];
  const avgConf = allConfs.length === 0 ? undefined
    : allConfs.reduce((a, b) => a + b, 0) / allConfs.length;

  const score = computeIngestScore(
    {
      decision: "accepted",
      path,
      llmTokensUsed,
      latencyMs: Date.now() - start,
      extractorConfidenceAvg: avgConf,
    },
    deps.cfg.scoring.ingest,
  );

  return finalize(
    deps, source, text, agentId, dreamRunId, start,
    {
      decision: "accepted",
      ingestPath: path,
      chunkId,
      routes,
      llmTokensUsed,
      latencyMs: Date.now() - start,
      score,
      reconcileDedupCount: reconcileOut.dedupCount,
      sidecar: sidecar ? { found: sidecar.found, ok: sidecar.ok } : undefined,
    },
  );
}

/* ------------------------------ audit write ------------------------------- */

async function finalize(
  deps: IngestDeps,
  source: string,
  text: string,
  agentId: string,
  dreamRunId: string | null,
  startedAt: number,
  partial: Omit<IngestOutcome, "latencyMs" | "score"> & Partial<Pick<IngestOutcome, "latencyMs" | "score">>,
): Promise<IngestOutcome> {
  const latency = partial.latencyMs ?? Date.now() - startedAt;
  // For rejected paths the score is computed using the rejected path so the
  // dashboard still has a value to plot ("how cheap was the rejection?").
  const score = partial.score ?? computeIngestScore(
    {
      decision: partial.decision === "rejected" ? "rejected" : (partial.decision as IngestDecision),
      path: partial.ingestPath,
      llmTokensUsed: partial.llmTokensUsed,
      latencyMs: latency,
    },
    deps.cfg.scoring.ingest,
  );

  const id = randomUUID();
  const textHash = createHash("sha256").update(text, "utf8").digest();
  const writtenIds = partial.chunkId ? { chunkId: partial.chunkId } : null;

  await deps.pool
    .query(
      `INSERT INTO audit.ingest_decisions
        (id, source, text_hash, text_excerpt, decision, reject_reason,
         routes, ingest_path, salience, llm_tokens_used, latency_ms,
         score, dream_run_id, written_ids, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        source,
        textHash,
        text.slice(0, 200),
        partial.decision,
        partial.rejectReason ?? null,
        partial.routes,
        partial.ingestPath,
        null,
        partial.llmTokensUsed,
        latency,
        score,
        dreamRunId,
        writtenIds,
        agentId,
      ],
    )
    .catch(() => {
      // Audit-write failures must not surface to the caller; drop quietly.
    });

  return {
    decision: partial.decision,
    rejectReason: partial.rejectReason,
    ingestPath: partial.ingestPath,
    chunkId: partial.chunkId,
    routes: partial.routes,
    llmTokensUsed: partial.llmTokensUsed,
    latencyMs: latency,
    score,
    reconcileDedupCount: partial.reconcileDedupCount,
    sidecar: partial.sidecar,
  };
}
