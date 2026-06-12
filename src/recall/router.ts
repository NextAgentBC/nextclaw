/**
 * Recall router: tier-walk T1 → T2.
 *
 * Phase 4 wires:
 *   - T1 anchor lookup (cache.hot_chunks + chunk_indexes anchor_*) — 0 LLM
 *   - T2 multi-route parallel + MMR merge
 *   - cache.recall result memoisation (5min TTL)
 *   - Audit row + score on every recall (hit_tier shows where it landed)
 *
 * T0 (in-process working memory) is layered on top in Phase 5.
 * T3 (cold gist) lands in Phase 6.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { computeRecallScore, type RecallTier } from "../scoring.js";
import {
  bumpIndexWeights,
  spreadActivation,
} from "../workers/spreading-activator.js";
import {
  mergeRoutes,
  mmrRerank,
  routeAnchor,
  routeCategory,
  routeConceptTag,
  routeEntityRef,
  routeFullText,
  routeGraphWalk,
  routeSemantic,
  routeTimeBucket,
  routeTrgm,
  type MergedCandidate,
  type MergeWeights,
} from "./routes.js";
import { categorize } from "../structured/categorizer.js";
import { inferTimeBucketsFromQuery } from "./temporal.js";
import type { RecallContext, RouteName } from "./types.js";
import { filterVisibleChunkIds, type ViewerScope } from "./viewer-scope.js";
import { primeWorkingSetWithProfiles, workingSetFor } from "./working-set.js";

/* ----------------------- query-side anchor inference ---------------------- */
/**
 * Best-effort deterministic extraction of anchor signals from a free-form
 * query string. Caller's explicit anchors win — these are merged in only when
 * the slot is empty, so the agent can override.
 *
 * - PR/issue references: "PR #1234", "PR 1234", "#999"
 * - File paths: any token with a slash and an extension, e.g. src/foo.ts
 * - Branch hints: "memory-postgres 分支", "branch xyz" etc. is too noisy to do
 *   reliably here; we leave that to the caller.
 */
function inferAnchorsFromQuery(
  query: string,
  given: RecallInput["anchors"],
): RecallInput["anchors"] {
  const out: NonNullable<RecallInput["anchors"]> = { ...(given ?? {}) };
  if (!out.pr) {
    // PR/issue refs: "PR #1234", "PR 1234", "#1234". Allow hex-ish tags too.
    const prMatch = /(?:PR\s*#?\s*|#)([\dA-Za-z][\dA-Za-z-]{0,15})\b/i.exec(query);
    if (prMatch) {out.pr = prMatch[1];}
  }
  if (!out.file) {
    const fileMatch = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w{1,8})/i.exec(query);
    if (fileMatch) {out.file = fileMatch[1];}
  }
  return out;
}

/**
 * Mirror of ingest-side deriveConceptTags(): pulls hyphenated identifiers,
 * camelCase parts, and CJK proper nouns from the query string. Lets the
 * concept_tag route fire even when the caller didn't pre-extract tags.
 *
 * Conservative: cap to the top 8 by length (longer = more specific) so we
 * don't fan out structured lookups for every common short word.
 */
const CT_STOP = new Set([
  "the","and","with","from","that","this","into","onto","over","under",
  "have","has","had","was","were","will","would","could","should","than",
]);
function inferConceptTagsFromQuery(query: string): string[] {
  const seen = new Set<string>();
  const add = (t: string) => {
    const lower = t.toLowerCase();
    if (lower.length < 3 || lower.length > 32) {return;}
    if (CT_STOP.has(lower)) {return;}
    seen.add(lower);
  };
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z][A-Za-z0-9]+)+/g)) {
    add(m[0]);
    for (const p of m[0].split("-")) {add(p);}
  }
  for (const m of query.matchAll(/\b[A-Za-z][a-z]+(?:[A-Z][a-z]+)+\b/g)) {
    const w = m[0];
    add(w);
    for (const p of w.split(/(?=[A-Z])/)) {add(p);}
  }
  for (const m of query.matchAll(/[一-鿿]{2,6}/g)) {add(m[0]);}
  for (const m of query.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/g)) {add(m[0]);}
  return [...seen]
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
}

export type RecallInput = {
  query: string;
  /** Caps top-k after merge + MMR. */
  maxResults?: number;
  /** Filter merged candidates by min combinedScore. */
  minScore?: number;
  /** Optional anchor signals (cwd, branch, ...). */
  anchors?: RecallContext["anchors"];
  /** Optional pre-resolved entity ids for entity_ref route. */
  entityIds?: string[];
  /** Optional concept tags from the user's query for concept_tag route. */
  conceptTags?: string[];
  /** Specific time bucket (YYYY-MM-DD) to filter on. */
  timeBucket?: string;
  /** Per-route override weights. */
  weights?: MergeWeights;
  agentSessionId?: string;
  /**
   * Owning agent id. Hard memory namespace boundary: every SQL route filters
   * `chunks.agent_id = $X` so a public/shared agent cannot pull
   * the owner's private chunks even if it tries. Default 'main' for back-compat.
   */
  agentId?: string;
  /**
   * Viewer scope. When set, the merged result set is passed through
   * `filterVisibleChunkIds` to enforce the three-tier (per-user-global /
   * per-chat-shared / per-(chat,user)) memory privacy model. See
   * `src/recall/viewer-scope.ts` for the rules.
   *
   * - For DM recalls: pass `viewer.userId` only.
   * - For group recalls: pass both `viewer.userId` AND `viewer.chatId`.
   * - For system / migration callers without a human viewer: omit entirely.
   */
  viewer?: ViewerScope;
};

export type RecallOutput = {
  results: MergedCandidate[];
  hitTier: RecallTier;
  fromCache: boolean;
  routesRun: RouteName[];
  candidates: number;
  llmTokensUsed: number;
  embedCalls: number;
  latencyMs: number;
  score: number;
  /** True when the only matches came from anchor/structured routes (zero-cost). */
  zeroCostHit: boolean;
};

const DEFAULT_K = 12;
const T2_PER_ROUTE_K = 6;
/** Score multiplier for chunks whose fact was superseded by a later chunk. */
const SUPERSEDED_PENALTY = 0.2;

export type RecallDeps = {
  cfg: ResolvedMemoryPostgresConfig;
  pool: Pool;
  embedding: EmbeddingClient;
};

const STRUCTURED_ROUTES: RouteName[] = [
  "anchor",
  "entity_ref",
  "concept_tag",
  "time_bucket",
  "category",
  "graph_walk",
];

/* --------------------------------- helpers --------------------------------- */

function hashQuery(query: string, scope: string): { qHash: Buffer; scopeKey: string } {
  return {
    qHash: createHash("sha256").update(query, "utf8").digest(),
    scopeKey: scope,
  };
}

function scopeKeyFor(input: RecallInput): string {
  const a = input.anchors ?? {};
  return [
    // Agent id is part of the cache scope so two agents asking the same
    // question against different memory namespaces never share results.
    `agent:${input.agentId ?? "main"}`,
    // Viewer scope is also part of the cache key — different viewers in
    // the same agent must see different filtered results (privacy), so
    // they should NOT share a cache entry even when their query string
    // matches verbatim. Cuts hit-rate slightly; required for correctness.
    `viewer:${input.viewer?.userId ?? ""}:${input.viewer?.chatId ?? ""}`,
    a.cwd ?? "",
    a.branch ?? "",
    a.pr ?? "",
    a.file ?? "",
    a.session ?? "",
    input.timeBucket ?? "",
  ].join("|");
}

/* ---------------------------- cache.recall I/O ---------------------------- */

async function readRecallCache(
  pool: Pool,
  qHash: Buffer,
  scopeKey: string,
): Promise<{ topK: MergedCandidate[]; routes: RouteName[] } | null> {
  const rows = await pool.query<{ top_k: { results: MergedCandidate[]; routes: RouteName[] } }>(
    `SELECT top_k FROM cache.recall
       WHERE query_hash = $1 AND scope_key = $2
         AND invalidated = false AND expires_at > now()
       LIMIT 1`,
    [qHash, scopeKey],
  );
  if (rows.rowCount === 0) {return null;}
  const payload = rows.rows[0].top_k;
  return { topK: payload.results, routes: payload.routes };
}

async function writeRecallCache(
  pool: Pool,
  qHash: Buffer,
  scopeKey: string,
  ttlSec: number,
  topK: MergedCandidate[],
  routes: RouteName[],
): Promise<void> {
  await pool.query(
    `INSERT INTO cache.recall (query_hash, scope_key, top_k, expires_at)
       VALUES ($1, $2, $3::jsonb, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (query_hash, scope_key) DO UPDATE
         SET top_k = EXCLUDED.top_k,
             expires_at = EXCLUDED.expires_at,
             invalidated = false,
             created_at = now()`,
    [qHash, scopeKey, JSON.stringify({ results: topK, routes }), ttlSec],
  );
}

/* ------------------------------- T1 promote ------------------------------- */

async function promoteToHotCache(
  pool: Pool,
  cfg: ResolvedMemoryPostgresConfig,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {return;}
  const ttlDays = cfg.tiers.t1TtlDays;
  // Bump warmth_score on the chunk and upsert into cache.hot_chunks.
  await pool.query(
    `UPDATE semantic.chunks
        SET warmth_score   = warmth_score + 0.5,
            recall_count   = recall_count + 1,
            last_recalled_at = now()
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(
    `INSERT INTO cache.hot_chunks (user_scope, chunk_id, expires_at, warmth_score)
       SELECT 'default', id, now() + ($2 || ' days')::interval, warmth_score
         FROM semantic.chunks
         WHERE id = ANY($1::uuid[])
       ON CONFLICT (user_scope, chunk_id) DO UPDATE
         SET expires_at   = EXCLUDED.expires_at,
             warmth_score = EXCLUDED.warmth_score,
             promoted_at  = now()`,
    [ids, String(ttlDays)],
  );
}

/* ---------------------------------- recall --------------------------------- */

export async function recall(deps: RecallDeps, input: RecallInput): Promise<RecallOutput> {
  const start = Date.now();
  const k = Math.max(1, input.maxResults ?? DEFAULT_K);
  const minScore = input.minScore ?? 0;
  const scope = scopeKeyFor(input);
  const { qHash } = hashQuery(input.query, scope);
  const ws = workingSetFor(
    input.agentSessionId,
    deps.cfg.tiers.t0SizeLimit,
    input.agentId,
    input.viewer?.userId,
  );

  // First recall of a session: prime T0 with this agent's profile chunks
  // (MemGPT-style "core memory" — per-agent + per-entity summaries that
  // always live in context). Idempotent; <50µs after the first call.
  if (!ws.hasProfilesPrimed()) {
    await primeWorkingSetWithProfiles(
      deps.pool,
      input.agentId ?? "main",
      ws,
      deps.cfg.tiers.t0SizeLimit,
    ).catch(() => 0);
  }

  // ---------- T0 working set (in-process; sub-ms) ----------
  const t0Hits = ws.search(input.query, k);
  if (t0Hits.length >= Math.max(1, Math.ceil(k / 2))) {
    const tier: RecallTier = "t0";
    const score = computeRecallScore(
      { hitTier: tier, llmTokensUsed: 0, latencyMs: Date.now() - start, relevanceEstimate: 0.7 },
      deps.cfg.scoring.recall,
    );
    for (const c of t0Hits) {ws.touch(c.chunkId);}
    await auditRecall(deps, input, {
      hitTier: tier,
      candidates: t0Hits.length,
      returned: t0Hits.length,
      embedCalls: 0,
      llmTokensUsed: 0,
      score,
      latencyMs: Date.now() - start,
    });
    return {
      results: t0Hits,
      hitTier: tier,
      fromCache: true,
      routesRun: [],
      candidates: t0Hits.length,
      llmTokensUsed: 0,
      embedCalls: 0,
      latencyMs: Date.now() - start,
      score,
      zeroCostHit: true,
    };
  }

  // ---------- cache.recall lookup ----------
  const cached = await readRecallCache(deps.pool, qHash, scope);
  if (cached) {
    const filtered = cached.topK.filter((c) => c.combinedScore >= minScore).slice(0, k);
    const tier: RecallTier = "t1";
    const score = computeRecallScore(
      { hitTier: tier, llmTokensUsed: 0, latencyMs: Date.now() - start, relevanceEstimate: 0.6 },
      deps.cfg.scoring.recall,
    );
    await auditRecall(deps, input, {
      hitTier: tier,
      candidates: filtered.length,
      returned: filtered.length,
      embedCalls: 0,
      llmTokensUsed: 0,
      score,
      latencyMs: Date.now() - start,
    });
    return {
      results: filtered,
      hitTier: tier,
      fromCache: true,
      routesRun: cached.routes,
      candidates: filtered.length,
      llmTokensUsed: 0,
      embedCalls: 0,
      latencyMs: Date.now() - start,
      score,
      zeroCostHit: true,
    };
  }

  // ---------- Phase A: structured-only quick path (T2 anchor) ----------
  // If we have anchor/entity/time signals, run those first. If they yield
  // good hits, we may skip the embedding call entirely → 0-cost recall.
  let routesRun: RouteName[] = [];
  let embedCalls = 0;

  const inferredAnchors = inferAnchorsFromQuery(input.query, input.anchors);
  const inferredTags =
    input.conceptTags && input.conceptTags.length > 0
      ? input.conceptTags
      : inferConceptTagsFromQuery(input.query);
  // Run the same Stage 0 categorizer over the query: lets "最近的健康记忆"
  // hit category=health rows directly via the structured route, 0 LLM /
  // 0 embedding cost. Always runs — the route's low merge weight (0.3)
  // means it contributes additively rather than dominating. A fresh chunk
  // matched by concept_tag + semantic still outranks older category-only
  // matches because multi-route hits compound.
  const inferredCategories = categorize(input.query)
    .filter((h) => h.category !== "other")
    .map((h) => h.category);
  // Temporal inference: "昨天" / "上周" / "yesterday" / "last week" etc.
  // get translated into a list of YYYY-MM-DD bucket strings. routeTimeBucket
  // unions these with any explicit ctx.timeBucket. Cheap regex, no DB hit.
  const inferredTemporal = inferTimeBucketsFromQuery(input.query);

  const ctxBase: RecallContext = {
    query: input.query,
    timeBucket: input.timeBucket,
    timeBuckets: inferredTemporal?.buckets,
    anchors: inferredAnchors,
    entityIds: input.entityIds,
    conceptTags: inferredTags,
    categories: inferredCategories,
    perRouteK: T2_PER_ROUTE_K,
    agentId: input.agentId ?? "main",
    viewer: input.viewer,
  };

  const [
    anchorRows,
    entityRefRows,
    timeBucketRows,
    conceptTagRows,
    categoryRows,
    graphWalkRows,
  ] = await Promise.all([
    routeAnchor(deps.pool, ctxBase),
    routeEntityRef(deps.pool, ctxBase),
    routeTimeBucket(deps.pool, ctxBase),
    routeConceptTag(deps.pool, ctxBase),
    routeCategory(deps.pool, ctxBase),
    // 1-hop graph walk over structured.relations (auto-resolves seed
    // entities from concept tags / explicit entityIds). Returns [] cheaply
    // when neither source yields anything, so safe to fan out always.
    routeGraphWalk(deps.pool, ctxBase),
  ]);
  const structuredFlat = [
    ...anchorRows,
    ...entityRefRows,
    ...timeBucketRows,
    ...conceptTagRows,
    ...categoryRows,
    ...graphWalkRows,
  ];
  if (structuredFlat.length > 0) {
    routesRun.push(...STRUCTURED_ROUTES);
  }

  // Decide whether to also run vector + fulltext routes.
  //
  // Skip the semantic fan-out (and the embedding RTT) ONLY when the caller
  // gave us a high-precision anchor that scopes hard: pr / file / branch.
  // cwd alone is too broad (matches every chunk in a repo) — skipping
  // semantic for cwd-only queries causes new low-warmth chunks to lose to
  // older high-warmth chunks even when the new chunk is the right answer.
  //
  // If ALL we have is a broad anchor (cwd or session), still run semantic
  // so the precise content of the query gets a vote. The embedding RTT
  // is ~250ms cold / 0ms via cache — worth it for "新华字典" completeness.
  const a = inferredAnchors ?? {};
  const hasPreciseAnchor = Boolean(a.pr || a.file || a.branch);
  const shouldRunSemantic =
    !hasPreciseAnchor || structuredFlat.length < Math.ceil(k / 2);

  let semanticResults: MergedCandidate[] | null = null;
  let semanticHits = false;
  if (shouldRunSemantic) {
    // Embed query.
    const embed = await deps.embedding.embed({ inputs: [input.query], taskPrefix: "query" });
    embedCalls = 1;
    const queryEmbedding = embed.embeddings[0] ?? [];
    const ctxFull: RecallContext = { ...ctxBase, queryEmbedding };
    const [sem, fts, trgm] = await Promise.all([
      routeSemantic(deps.pool, ctxFull),
      routeFullText(deps.pool, ctxFull),
      routeTrgm(deps.pool, ctxFull),
    ]);
    semanticResults = mergeRoutes(
      [
        { route: "semantic", candidates: sem },
        { route: "fulltext", candidates: fts },
        { route: "trgm", candidates: trgm },
      ],
      input.weights,
    );
    semanticHits = sem.length > 0 || fts.length > 0 || trgm.length > 0;
    routesRun.push("semantic", "fulltext", "trgm");
  }

  // Merge structured + semantic and rerank.
  const merged = mergeRoutes(
    [
      { route: "anchor",      candidates: anchorRows },
      { route: "entity_ref",  candidates: entityRefRows },
      { route: "time_bucket", candidates: timeBucketRows },
      { route: "concept_tag", candidates: conceptTagRows },
      { route: "category",    candidates: categoryRows },
      { route: "graph_walk",  candidates: graphWalkRows },
    ],
    input.weights,
  );
  const all: MergedCandidate[] = [...merged];
  for (const c of semanticResults ?? []) {
    const existing = all.find((m) => m.chunkId === c.chunkId);
    if (existing) {
      existing.combinedScore += c.combinedScore;
      for (const h of c.hits) {
        if (!existing.hits.includes(h)) {
          existing.hits.push(h);
        }
      }
    } else {
      all.push(c);
    }
  }

  // Down-weight chunks whose underlying fact was superseded by a later chunk
  // (P1#3). They stay recallable — for audit / "what did I used to think" — but
  // lose to the current truth. One batched lookup on superseded_by.
  if (all.length > 0) {
    const sup = await deps.pool.query<{ id: string }>(
      `SELECT id FROM semantic.chunks WHERE id = ANY($1::uuid[]) AND superseded_by IS NOT NULL`,
      [all.map((c) => c.chunkId)],
    );
    if (sup.rowCount && sup.rowCount > 0) {
      const supSet = new Set(sup.rows.map((r) => r.id));
      for (const c of all) {
        if (supSet.has(c.chunkId)) {c.combinedScore *= SUPERSEDED_PENALTY;}
      }
    }
  }

  const reranked = mmrRerank(all, k);
  let filtered = reranked.filter((c) => c.combinedScore >= minScore);

  // Three-tier privacy filter: drop any chunk that's not visible to the
  // current viewer. Cheap single-RT batch lookup. For DM / system callers
  // who didn't set viewer, this is a no-op pass-through.
  if (input.viewer && (input.viewer.userId || input.viewer.chatId) && filtered.length > 0) {
    const visible = await filterVisibleChunkIds(
      deps.pool,
      input.viewer,
      filtered.map((c) => c.chunkId),
    );
    filtered = filtered.filter((c) => visible.has(c.chunkId));
  }

  // T1 hot promotion + T0 working set + spreading activation.
  const hitIds = filtered.map((c) => c.chunkId);
  await promoteToHotCache(deps.pool, deps.cfg, hitIds);
  for (const c of filtered) {ws.add(c);}
  // Fire-and-forget spread + index weight bump; never block the response.
  void spreadActivation(deps.pool, hitIds).catch(() => undefined);
  void bumpIndexWeights(deps.pool, hitIds).catch(() => undefined);

  // Persist cache.recall.
  await writeRecallCache(
    deps.pool,
    qHash,
    scope,
    deps.cfg.scoring.recall.relevanceFollowupWindowMs > 0
      ? Math.min(3600, Math.floor(deps.cfg.scoring.recall.relevanceFollowupWindowMs / 1000))
      : 300,
    filtered,
    routesRun,
  );

  // Pick the tier label that best describes where we landed.
  const zeroCostHit = !semanticHits && structuredFlat.length > 0;
  const tier: RecallTier = zeroCostHit ? "t2_anchor" : "t2_hybrid";
  const score = computeRecallScore(
    {
      hitTier: tier,
      llmTokensUsed: 0,
      latencyMs: Date.now() - start,
      relevanceEstimate: 0.5,
    },
    deps.cfg.scoring.recall,
  );

  await auditRecall(deps, input, {
    hitTier: tier,
    candidates: all.length,
    returned: filtered.length,
    embedCalls,
    llmTokensUsed: 0,
    score,
    latencyMs: Date.now() - start,
  });

  return {
    results: filtered,
    hitTier: tier,
    fromCache: false,
    routesRun,
    candidates: all.length,
    llmTokensUsed: 0,
    embedCalls,
    latencyMs: Date.now() - start,
    score,
    zeroCostHit,
  };
}

/* ------------------------------- audit write ------------------------------- */

async function auditRecall(
  deps: RecallDeps,
  input: RecallInput,
  partial: {
    hitTier: RecallTier;
    candidates: number;
    returned: number;
    embedCalls: number;
    llmTokensUsed: number;
    score: number;
    latencyMs: number;
  },
): Promise<void> {
  const id = randomUUID();
  await deps.pool
    .query(
      `INSERT INTO audit.recall_decisions
        (id, query_text, hit_tier, candidates, returned,
         agent_session_id, agent_id, llm_tokens_used, embed_calls, latency_ms,
         score, scored_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        id,
        input.query,
        partial.hitTier,
        partial.candidates,
        partial.returned,
        input.agentSessionId ?? null,
        input.agentId ?? "main",
        partial.llmTokensUsed,
        partial.embedCalls,
        partial.latencyMs,
        partial.score,
      ],
    )
    .catch(() => {
      /* audit-write failures intentionally swallowed */
    });
}
