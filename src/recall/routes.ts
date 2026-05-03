/**
 * Parallel recall routes — the new-华字典 lookup paths.
 *
 * Each route is a pure async function over (Pool, RecallContext) → RouteCandidate[].
 * Routes are independent; the orchestrator runs them concurrently with
 * Promise.all and merges results downstream.
 */

import type { Pool } from "pg";
import pgvector from "pgvector/pg";
import type { RecallContext, RouteCandidate, RouteName } from "./types.js";

const DEFAULT_K = 6;

function map(rows: RouteCandidate[], route: RouteName): RouteCandidate[] {
  for (const r of rows) {
    r.hits = [route];
  }
  return rows;
}

type RouteRow = {
  chunk_id?: string;
  id?: string;
  source: string;
  source_ref: string | null;
  text: string;
};

function build(row: RouteRow, rawScore: number, normScore: number): RouteCandidate {
  const id = row.chunk_id ?? row.id ?? "";
  return {
    chunkId: id,
    source: row.source,
    sourceRef: row.source_ref,
    text: row.text,
    rawScore,
    normScore,
    hits: [],
  };
}

/* --------------------------------- semantic -------------------------------- */

export async function routeSemantic(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  if (!ctx.queryEmbedding || ctx.queryEmbedding.length === 0) {return [];}
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow & { vec_score: number }>(
    `SELECT id AS chunk_id, source, source_ref, text,
            1 - (embedding <=> $1::vector) AS vec_score
       FROM semantic.chunks
       WHERE retention_class != 'ephemeral'
         AND agent_id = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
    [pgvector.toSql(ctx.queryEmbedding), k, aid],
  );
  return map(
    rows.rows.map((r) => build(r, r.vec_score, Math.max(0, Math.min(1, r.vec_score)))),
    "semantic",
  );
}

/* --------------------------------- fulltext -------------------------------- */

export async function routeFullText(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow & { fts_score: number }>(
    `SELECT id AS chunk_id, source, source_ref, text,
            ts_rank(to_tsvector('simple', text), plainto_tsquery('simple', $1)) AS fts_score
       FROM semantic.chunks
       WHERE retention_class != 'ephemeral'
         AND agent_id = $3
         AND to_tsvector('simple', text) @@ plainto_tsquery('simple', $1)
       ORDER BY fts_score DESC
       LIMIT $2`,
    [ctx.query, k, aid],
  );
  // bm25 / ts_rank → bound to [0,1] by max+1 sigmoid-ish.
  const max = rows.rows.reduce((m, r) => Math.max(m, r.fts_score), 0);
  return map(
    rows.rows.map((r) =>
      build(r, r.fts_score, max === 0 ? 0 : r.fts_score / max),
    ),
    "fulltext",
  );
}

/* ----------------------------------- trgm ---------------------------------- */

export async function routeTrgm(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow & { sim: number }>(
    `SELECT id AS chunk_id, source, source_ref, text,
            similarity(text, $1) AS sim
       FROM semantic.chunks
       WHERE retention_class != 'ephemeral'
         AND agent_id = $3
         AND text % $1
       ORDER BY sim DESC
       LIMIT $2`,
    [ctx.query, k, aid],
  );
  return map(
    rows.rows.map((r) => build(r, r.sim, Math.max(0, Math.min(1, r.sim)))),
    "trgm",
  );
}

/* ------------------------------- concept_tag ------------------------------- */

export async function routeConceptTag(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  if (!ctx.conceptTags || ctx.conceptTags.length === 0) {return [];}
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow & { hits: number }>(
    `SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'concept_tag'
         AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC
       LIMIT $2`,
    [ctx.conceptTags, k, aid],
  );
  const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
  return map(
    rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)),
    "concept_tag",
  );
}

/* -------------------------------- category --------------------------------- */
/**
 * Categorical lookup. Fires when the caller (or the router's query
 * categorize() pass) decides the query implies a taxonomy bucket — e.g.
 * "最近的健康记忆" → category=health. Returns chunks ordered by
 * warmth_score so the recently-active items lead.
 */
export async function routeCategory(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  if (!ctx.categories || ctx.categories.length === 0) {return [];}
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow & { hits: number }>(
    `SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'category'
         AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC, c.warmth_score DESC
       LIMIT $2`,
    [ctx.categories, k, aid],
  );
  const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
  return map(
    rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)),
    "category",
  );
}

/* ------------------------------- entity_ref -------------------------------- */

export async function routeEntityRef(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  if (!ctx.entityIds || ctx.entityIds.length === 0) {return [];}
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow & { hits: number }>(
    `SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'entity_ref'
         AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC
       LIMIT $2`,
    [ctx.entityIds, k, aid],
  );
  const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
  return map(
    rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)),
    "entity_ref",
  );
}

/* ------------------------------- time_bucket ------------------------------- */

export async function routeTimeBucket(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  if (!ctx.timeBucket) {return [];}
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const rows = await pool.query<RouteRow>(
    `SELECT c.id AS chunk_id, c.source, c.source_ref, c.text
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'time_bucket' AND ci.value = $1
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       ORDER BY c.created_at DESC
       LIMIT $2`,
    [ctx.timeBucket, k, aid],
  );
  // All matched buckets are equally good; flat 0.7.
  return map(
    rows.rows.map((r) => build(r, 1, 0.7)),
    "time_bucket",
  );
}

/* ---------------------------------- anchor --------------------------------- */

export async function routeAnchor(
  pool: Pool,
  ctx: RecallContext,
): Promise<RouteCandidate[]> {
  const a = ctx.anchors;
  if (!a) {return [];}
  const conditions: string[] = [];
  const params: string[] = [];
  let p = 1;
  const push = (kind: string, value: string | undefined): void => {
    if (!value) {return;}
    conditions.push(`(ci.kind = '${kind}' AND ci.value = $${p})`);
    params.push(value);
    p += 1;
  };
  push("anchor_cwd", a.cwd);
  push("anchor_branch", a.branch);
  push("anchor_pr", a.pr);
  push("anchor_file", a.file);
  push("anchor_session", a.session);
  if (conditions.length === 0) {return [];}
  const k = ctx.perRouteK ?? DEFAULT_K;
  const aid = ctx.agentId ?? "main";
  const limitParam = p;       // first slot for LIMIT
  const agentParam = p + 1;   // second slot for agent_id
  const sql = `
    SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
           count(*)::int AS hits
      FROM semantic.chunk_indexes ci
      JOIN semantic.chunks c ON c.id = ci.chunk_id
      WHERE (${conditions.join(" OR ")})
        AND c.retention_class != 'ephemeral'
        AND c.agent_id = $${agentParam}
      GROUP BY c.id, c.source, c.source_ref, c.text
      ORDER BY hits DESC
      LIMIT $${limitParam}
  `;
  const rows = await pool.query<RouteRow & { hits: number }>(
    sql,
    [...params, k, aid],
  );
  const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
  return map(
    rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)),
    "anchor",
  );
}

/* ---------------------------------- merge ---------------------------------- */

export type MergeWeights = Partial<Record<RouteName, number>>;

const DEFAULT_WEIGHTS: Required<MergeWeights> = {
  semantic: 1.0,
  fulltext: 0.7,
  trgm: 0.5,
  concept_tag: 0.8,
  entity_ref: 1.0,
  time_bucket: 0.6,
  anchor: 1.2,
  // Category is the most coarse-grained signal — it groups thousands of
  // chunks under the same value. Keep its weight low (well below
  // concept_tag at 0.8 and trgm at 0.5) so a fresh chunk matched by
  // concept+semantic still beats older category-only matches via
  // multi-route compound scoring. Category is a tie-breaker, not a driver.
  category: 0.3,
};

export type MergedCandidate = RouteCandidate & {
  combinedScore: number;
};

export function mergeRoutes(
  results: ReadonlyArray<{ route: RouteName; candidates: RouteCandidate[] }>,
  weights: MergeWeights = DEFAULT_WEIGHTS,
): MergedCandidate[] {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const byId = new Map<string, MergedCandidate>();
  for (const { route, candidates } of results) {
    const wt = w[route] ?? 0.5;
    for (const c of candidates) {
      const existing = byId.get(c.chunkId);
      if (existing) {
        existing.combinedScore += wt * c.normScore;
        if (!existing.hits.includes(route)) {existing.hits.push(route);}
      } else {
        byId.set(c.chunkId, {
          ...c,
          hits: [route],
          combinedScore: wt * c.normScore,
        });
      }
    }
  }
  return [...byId.values()].toSorted((a, b) => b.combinedScore - a.combinedScore);
}

/* ----------------------------------- MMR ----------------------------------- */

/**
 * Maximal Marginal Relevance: greedy diversification on already-merged
 * candidates. Phase 4 uses a text Jaccard proxy for similarity to avoid
 * a second round of embedding calls; Phase 5 swaps in real cosine on the
 * already-computed embeddings when we cache them in the candidate.
 */
export function mmrRerank(
  items: MergedCandidate[],
  k: number,
  lambda = 0.7,
): MergedCandidate[] {
  if (items.length <= k) {return items;}
  const selected: MergedCandidate[] = [];
  const pool = [...items];
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const cand = pool[i];
      const relevance = cand.combinedScore;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(cand.text, s.text);
        if (sim > maxSim) {maxSim = sim;}
      }
      const score = lambda * relevance - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/\s+|[,，.。!?;:、]/u).filter((t) => t.length >= 2),
  );
}
function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) {return 0;}
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) {
      inter += 1;
    }
  }
  return inter / (A.size + B.size - inter);
}
