/**
 * Parallel recall routes — the new-华字典 lookup paths.
 *
 * Each route is a pure async function over (Pool, RecallContext) → RouteCandidate[].
 * Routes are independent; the orchestrator runs them concurrently with
 * Promise.all and merges results downstream.
 */
import pgvector from "pgvector/pg";
const DEFAULT_K = 6;
function map(rows, route) {
    for (const r of rows) {
        r.hits = [route];
    }
    return rows;
}
function build(row, rawScore, normScore) {
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
export async function routeSemantic(pool, ctx) {
    if (!ctx.queryEmbedding || ctx.queryEmbedding.length === 0) {
        return [];
    }
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT id AS chunk_id, source, source_ref, text,
            1 - (embedding <=> $1::vector) AS vec_score
       FROM semantic.chunks
       WHERE retention_class != 'ephemeral'
         AND agent_id = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $2`, [pgvector.toSql(ctx.queryEmbedding), k, aid]);
    return map(rows.rows.map((r) => build(r, r.vec_score, Math.max(0, Math.min(1, r.vec_score)))), "semantic");
}
/* --------------------------------- fulltext -------------------------------- */
export async function routeFullText(pool, ctx) {
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT id AS chunk_id, source, source_ref, text,
            ts_rank(to_tsvector('simple', text), plainto_tsquery('simple', $1)) AS fts_score
       FROM semantic.chunks
       WHERE retention_class != 'ephemeral'
         AND agent_id = $3
         AND to_tsvector('simple', text) @@ plainto_tsquery('simple', $1)
       ORDER BY fts_score DESC
       LIMIT $2`, [ctx.query, k, aid]);
    // bm25 / ts_rank → bound to [0,1] by max+1 sigmoid-ish.
    const max = rows.rows.reduce((m, r) => Math.max(m, r.fts_score), 0);
    return map(rows.rows.map((r) => build(r, r.fts_score, max === 0 ? 0 : r.fts_score / max)), "fulltext");
}
/* ----------------------------------- trgm ---------------------------------- */
export async function routeTrgm(pool, ctx) {
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT id AS chunk_id, source, source_ref, text,
            similarity(text, $1) AS sim
       FROM semantic.chunks
       WHERE retention_class != 'ephemeral'
         AND agent_id = $3
         AND text % $1
       ORDER BY sim DESC
       LIMIT $2`, [ctx.query, k, aid]);
    return map(rows.rows.map((r) => build(r, r.sim, Math.max(0, Math.min(1, r.sim)))), "trgm");
}
/* ------------------------------- concept_tag ------------------------------- */
export async function routeConceptTag(pool, ctx) {
    if (!ctx.conceptTags || ctx.conceptTags.length === 0) {
        return [];
    }
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'concept_tag'
         AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC
       LIMIT $2`, [ctx.conceptTags, k, aid]);
    const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
    return map(rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)), "concept_tag");
}
/* -------------------------------- category --------------------------------- */
/**
 * Categorical lookup. Fires when the caller (or the router's query
 * categorize() pass) decides the query implies a taxonomy bucket — e.g.
 * "最近的健康记忆" → category=health. Returns chunks ordered by
 * warmth_score so the recently-active items lead.
 */
export async function routeCategory(pool, ctx) {
    if (!ctx.categories || ctx.categories.length === 0) {
        return [];
    }
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'category'
         AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC, c.warmth_score DESC
       LIMIT $2`, [ctx.categories, k, aid]);
    const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
    return map(rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)), "category");
}
/* ------------------------------- entity_ref -------------------------------- */
export async function routeEntityRef(pool, ctx) {
    if (!ctx.entityIds || ctx.entityIds.length === 0) {
        return [];
    }
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'entity_ref'
         AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC
       LIMIT $2`, [ctx.entityIds, k, aid]);
    const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
    return map(rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)), "entity_ref");
}
/* ------------------------------- time_bucket ------------------------------- */
export async function routeTimeBucket(pool, ctx) {
    // Union explicit single bucket + inferred range buckets.
    const bucketSet = new Set();
    if (ctx.timeBucket) {
        bucketSet.add(ctx.timeBucket);
    }
    for (const b of ctx.timeBuckets ?? []) {
        bucketSet.add(b);
    }
    if (bucketSet.size === 0) {
        return [];
    }
    const buckets = [...bucketSet];
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const rows = await pool.query(`SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(*)::int AS hits
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
       WHERE ci.kind = 'time_bucket' AND ci.value = ANY($1::text[])
         AND c.retention_class != 'ephemeral'
         AND c.agent_id = $3
       GROUP BY c.id, c.source, c.source_ref, c.text
       ORDER BY hits DESC, max(c.created_at) DESC
       LIMIT $2`, [buckets, k, aid]);
    const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
    // Score: more bucket hits = higher (chunk mentioned across multiple days of
    // a "last week" query is more relevant than a chunk only mentioned once).
    // Floor at 0.6 so even single-hit time matches still register meaningfully.
    return map(rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : 0.6 + 0.4 * (r.hits / max))), "time_bucket");
}
/* ---------------------------------- anchor --------------------------------- */
export async function routeAnchor(pool, ctx) {
    const a = ctx.anchors;
    if (!a) {
        return [];
    }
    const conditions = [];
    const params = [];
    let p = 1;
    const push = (kind, value) => {
        if (!value) {
            return;
        }
        conditions.push(`(ci.kind = '${kind}' AND ci.value = $${p})`);
        params.push(value);
        p += 1;
    };
    push("anchor_cwd", a.cwd);
    push("anchor_branch", a.branch);
    push("anchor_pr", a.pr);
    push("anchor_file", a.file);
    push("anchor_session", a.session);
    if (conditions.length === 0) {
        return [];
    }
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const limitParam = p; // first slot for LIMIT
    const agentParam = p + 1; // second slot for agent_id
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
    const rows = await pool.query(sql, [...params, k, aid]);
    const max = rows.rows.reduce((m, r) => Math.max(m, r.hits), 0);
    return map(rows.rows.map((r) => build(r, r.hits, max === 0 ? 0 : r.hits / max)), "anchor");
}
/* -------------------------------- graph_walk ------------------------------- */
/**
 * 1-hop graph traversal over `structured.relations`, seeded from entities the
 * query implicates. Surfaces chunks that don't textually mention the query
 * subject but mention something the subject is related to.
 *
 * Two seed sources, OR'd together:
 *   1. Explicit `ctx.entityIds` (caller pre-resolved)
 *   2. Auto-resolved: entities whose `canonical_name` or `aliases` match any
 *      `ctx.conceptTags` (deterministic — pg_trgm % similarity AND alias =).
 *
 * For each seed entity, find its neighbors via `subject_id` / `object_id`
 * relations. Then find chunks indexed under those neighbor ids in
 * `chunk_indexes (kind='entity_ref')`. Score by neighbor confidence and
 * number of distinct neighbor hits per chunk.
 *
 * Returns empty when there are no seeds and no matching entities — cheap
 * to call unconditionally, so the router always fans it out.
 */
export async function routeGraphWalk(pool, ctx) {
    const k = ctx.perRouteK ?? DEFAULT_K;
    const aid = ctx.agentId ?? "main";
    const seedTags = ctx.conceptTags ?? [];
    const explicitSeeds = ctx.entityIds ?? [];
    // Step 1: resolve seed entity ids — explicit + concept-tag fuzzy match.
    // We do this in-route (one extra query) instead of pre-computing in the
    // router, because it's strictly opt-in for graph_walk and skipping it
    // when both seed sources are empty avoids any DB hit.
    if (explicitSeeds.length === 0 && seedTags.length === 0) {
        return [];
    }
    let seeds = [...explicitSeeds];
    if (seedTags.length > 0) {
        const resolved = await pool.query(`SELECT id FROM structured.entities
         WHERE deleted_at IS NULL
           AND (
             canonical_name = ANY($1::text[])
             OR aliases && $1::text[]
             OR EXISTS (
               SELECT 1 FROM unnest($1::text[]) AS tag
               WHERE canonical_name % tag
             )
           )
         LIMIT 16`, [seedTags]);
        for (const r of resolved.rows) {
            if (!seeds.includes(r.id)) {
                seeds.push(r.id);
            }
        }
    }
    if (seeds.length === 0) {
        return [];
    }
    // Step 2: walk up to 2 hops via relations, score chunks by how easily
    // they're reachable. Recursive CTE finds all neighbors at depth 1 and 2;
    // we down-weight depth-2 contributions (a 1-hop relation is a stronger
    // signal than a 2-hop chain). Closed relations (`ended_at < now`) older
    // than 180d don't participate.
    //
    // This is the multi-hop extension HippoRAG / GraphRAG papers argue is
    // the real graph win — answers questions like "what is the project Bob
    // mentioned in his message that Alice replied to" where the chain
    // crosses through two relation edges. 1-hop alone misses these.
    const DEPTH2_DAMPENING = 0.5; // 2-hop neighbors count as half a 1-hop neighbor
    const rows = await pool.query(`WITH RECURSIVE hops(neighbor_id, depth, confidence) AS (
       -- depth 1: direct neighbors of any seed
       SELECT DISTINCT
              CASE WHEN r.subject_id = ANY($1::uuid[]) THEN r.object_id
                   ELSE r.subject_id END,
              1,
              r.confidence
         FROM structured.relations r
        WHERE (r.subject_id = ANY($1::uuid[]) OR r.object_id = ANY($1::uuid[]))
          AND (r.ended_at IS NULL OR r.ended_at > now() - interval '180 days')
       UNION ALL
       -- depth 2: neighbors of depth-1 nodes; exclude seeds (no walking back)
       SELECT DISTINCT
              CASE WHEN r.subject_id = h.neighbor_id THEN r.object_id
                   ELSE r.subject_id END,
              2,
              r.confidence * h.confidence  -- compound confidence along the path
         FROM hops h
         JOIN structured.relations r
           ON (r.subject_id = h.neighbor_id OR r.object_id = h.neighbor_id)
        WHERE h.depth = 1
          AND (r.ended_at IS NULL OR r.ended_at > now() - interval '180 days')
     ),
     reachable AS (
       -- Deduplicate to (neighbor_id, min_depth, best_conf) so the same
       -- entity reached via both 1-hop and 2-hop gets credited at depth 1.
       SELECT neighbor_id, min(depth) AS min_depth, max(confidence) AS confidence
         FROM hops
        WHERE neighbor_id IS NOT NULL
          AND neighbor_id <> ALL($1::uuid[])
        GROUP BY neighbor_id
     )
     SELECT c.id AS chunk_id, c.source, c.source_ref, c.text,
            count(DISTINCT n.neighbor_id)::int AS neighbors,
            min(n.min_depth)::int AS min_depth,
            avg(
              CASE WHEN n.min_depth = 1 THEN n.confidence
                   ELSE n.confidence * $4::float
              END
            )::float AS avg_conf
       FROM reachable n
       JOIN semantic.chunk_indexes ci
         ON ci.kind = 'entity_ref' AND ci.value = n.neighbor_id::text
       JOIN semantic.chunks c ON c.id = ci.chunk_id
      WHERE c.retention_class != 'ephemeral'
        AND c.agent_id = $3
      GROUP BY c.id, c.source, c.source_ref, c.text
      ORDER BY min_depth ASC, neighbors DESC, avg_conf DESC
      LIMIT $2`, [seeds, k, aid, DEPTH2_DAMPENING]);
    if (rows.rows.length === 0) {
        return [];
    }
    const maxN = rows.rows.reduce((m, r) => Math.max(m, r.neighbors), 0);
    return map(rows.rows.map((r) => build(r, r.neighbors, 
    // Composite: neighbor count (0..1) × avg confidence × depth bonus.
    // A chunk reached via 3 distinct 1-hop neighbors at 0.9 conf beats
    // one reached via 1 neighbor at 1.0; a 1-hop chunk beats a 2-hop
    // chunk with same neighbor count (depth already baked into avg_conf
    // via DEPTH2_DAMPENING, but we also use it as a stable sort key
    // above to preserve tie-break behavior).
    maxN === 0 ? 0 : (r.neighbors / maxN) * Math.min(1, Math.max(0, r.avg_conf)))), "graph_walk");
}
const DEFAULT_WEIGHTS = {
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
    // Graph walk: borrowed strength from neighbor entities. Slightly below
    // direct entity_ref (1.0) because a 1-hop inference is weaker than a
    // textual mention, but above concept_tag because the relation is
    // explicit in the structured store, not just a substring match.
    graph_walk: 0.9,
};
export function mergeRoutes(results, weights = DEFAULT_WEIGHTS) {
    const w = { ...DEFAULT_WEIGHTS, ...weights };
    const byId = new Map();
    for (const { route, candidates } of results) {
        const wt = w[route] ?? 0.5;
        for (const c of candidates) {
            const existing = byId.get(c.chunkId);
            if (existing) {
                existing.combinedScore += wt * c.normScore;
                if (!existing.hits.includes(route)) {
                    existing.hits.push(route);
                }
            }
            else {
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
export function mmrRerank(items, k, lambda = 0.7) {
    if (items.length <= k) {
        return items;
    }
    const selected = [];
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
                if (sim > maxSim) {
                    maxSim = sim;
                }
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
function tokens(s) {
    return new Set(s.toLowerCase().split(/\s+|[,，.。!?;:、]/u).filter((t) => t.length >= 2));
}
function jaccard(a, b) {
    const A = tokens(a);
    const B = tokens(b);
    if (A.size === 0 || B.size === 0) {
        return 0;
    }
    let inter = 0;
    for (const x of A) {
        if (B.has(x)) {
            inter += 1;
        }
    }
    return inter / (A.size + B.size - inter);
}
