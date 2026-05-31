/**
 * Read-side helper for action-sensitive memory. Given a set of recalled
 * chunks, return the active commitments attached to them — scoped to a single
 * agent (hard isolation: a caller never sees another agent's directives).
 *
 * Rows are ordered so the most restrictive (requires_confirmation) commitment
 * per chunk sorts first, letting callers take the first per chunk as the
 * dominant flag to surface.
 */
export async function getActiveCommitmentsByChunk(pool, chunkIds, agentId) {
    if (chunkIds.length === 0) {
        return [];
    }
    const rows = await pool.query(`SELECT chunk_id, kind, safe_to_act, requires_confirmation, authority, directive
       FROM structured.commitments
      WHERE chunk_id = ANY($1::uuid[]) AND agent_id = $2 AND invalidated_at IS NULL
      ORDER BY requires_confirmation DESC, created_at DESC`, [chunkIds, agentId]);
    return rows.rows.map((r) => ({
        chunkId: r.chunk_id,
        kind: r.kind,
        safeToAct: r.safe_to_act,
        requiresConfirmation: r.requires_confirmation,
        authority: r.authority,
        directive: r.directive,
    }));
}
