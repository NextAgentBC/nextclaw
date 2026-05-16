/**
 * Shared types for the parallel recall router.
 *
 * Each route returns RouteCandidate[]; the merge step normalises scores into
 * [0,1] and feeds MMR rerank. Phase 4 ships 6 routes; metric + preference
 * routes follow in Phase 5/6 once their specialised query shapes settle.
 */

export type RouteName =
  | "semantic"
  | "fulltext"
  | "trgm"
  | "concept_tag"
  | "entity_ref"
  | "time_bucket"
  | "anchor"
  | "category"
  // 1-hop graph walk over structured.relations starting from query-resolved
  // entities. Borrows the GraphRAG idea: when "Yao Song" shows up in the
  // query, surface chunks that mention people / projects / files he's
  // related to, even if those chunks never literally said "Yao Song".
  | "graph_walk";

export type RouteCandidate = {
  chunkId: string;
  source: string;
  sourceRef: string | null;
  text: string;
  /** Raw route-specific score; not yet normalised. */
  rawScore: number;
  /** Per-route normalised [0,1] score. Filled by the route function itself. */
  normScore: number;
  /** Routes that matched this chunk (filled by merge step). */
  hits: RouteName[];
};

export type RecallContext = {
  query: string;
  /** Single time anchor (YYYY-MM-DD). Caller-explicit. */
  timeBucket?: string;
  /**
   * Multiple time buckets — typically populated by the router's temporal
   * inference (e.g. "上周" → 7 bucket strings). When set, `routeTimeBucket`
   * unions across all of them. When `timeBucket` is also set, the buckets
   * are merged.
   */
  timeBuckets?: string[];
  /** Pre-resolved anchor values (cwd, branch, pr_number, file_path, session_id). */
  anchors?: {
    cwd?: string;
    branch?: string;
    pr?: string;
    file?: string;
    session?: string;
  };
  /** Entity ids previously resolved from query mentions. */
  entityIds?: string[];
  /** Concept tags previously extracted from query (Phase 4 keeps simple keywords). */
  conceptTags?: string[];
  /** Taxonomy categories the query implicates (health/medical/tech/...). */
  categories?: string[];
  /** k for each route's top-k. */
  perRouteK?: number;
  /** Optional precomputed query embedding to skip the embed call. */
  queryEmbedding?: number[];
  /** Owning agent id — every SQL route filters `chunks.agent_id = $X`. */
  agentId?: string;
};
