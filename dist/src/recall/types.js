/**
 * Shared types for the parallel recall router.
 *
 * Each route returns RouteCandidate[]; the merge step normalises scores into
 * [0,1] and feeds MMR rerank. Phase 4 ships 6 routes; metric + preference
 * routes follow in Phase 5/6 once their specialised query shapes settle.
 */
export {};
