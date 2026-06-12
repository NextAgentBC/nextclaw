export async function recordCitationFollowup(pool, agentId, chunkId, windowMs) {
    if (windowMs <= 0) {
        return;
    }
    await pool.query(`UPDATE audit.recall_decisions SET relevance_estimate = 1.0
       WHERE id = (
         SELECT id FROM audit.recall_decisions
          WHERE agent_id = $1
            AND relevance_estimate IS NULL
            AND ts > now() - make_interval(secs => $2)
            AND $3 = ANY(returned_chunk_ids)
          ORDER BY ts DESC
          LIMIT 1
       )`, [agentId, windowMs / 1000, chunkId]);
}
