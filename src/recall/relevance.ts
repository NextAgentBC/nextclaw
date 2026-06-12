/**
 * P0#2 — close the recall relevance loop.
 *
 * `audit.recall_decisions.relevance_estimate` starts NULL ("pending"); the
 * weekly tuning loop should learn from real follow-up signals instead of a
 * hardcoded guess. The cleanest positive signal: the agent follows a recall
 * citation — it calls memory_get on a chunk a recent recall returned. That
 * recall surfaced something the agent then chose to read in full → relevant.
 *
 * We credit the single most-recent still-pending recall (same agent, within
 * the follow-up window) that actually returned this chunk.
 */
import type { Pool } from "pg";

export async function recordCitationFollowup(
  pool: Pool,
  agentId: string,
  chunkId: string,
  windowMs: number,
): Promise<void> {
  if (windowMs <= 0) {return;}
  await pool.query(
    `UPDATE audit.recall_decisions SET relevance_estimate = 1.0
       WHERE id = (
         SELECT id FROM audit.recall_decisions
          WHERE agent_id = $1
            AND relevance_estimate IS NULL
            AND ts > now() - make_interval(secs => $2)
            AND $3 = ANY(returned_chunk_ids)
          ORDER BY ts DESC
          LIMIT 1
       )`,
    [agentId, windowMs / 1000, chunkId],
  );
}
