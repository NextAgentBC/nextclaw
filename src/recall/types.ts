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
  | "category";

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
  /** Time anchor (today, last week, ...). */
  timeBucket?: string;
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
