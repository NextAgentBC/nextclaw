/**
 * Spreading activator (Hebbian-style): after a recall hit, raise the
 * warmth_score on neighbours that share entity_ref / concept_tag with the
 * hit chunks. Async, fire-and-forget, never blocks the recall response.
 */

import type { Pool } from "pg";

export async function spreadActivation(
  pool: Pool,
  hitChunkIds: string[],
  bump = 0.1,
  neighbourCap = 20,
): Promise<number> {
  if (hitChunkIds.length === 0) {return 0;}
  // Find chunks sharing ≥ 2 (kind, value) pairs with a hit chunk; bump warmth.
  const result = await pool.query<{ updated: string }>(
    `WITH neighbours AS (
       SELECT DISTINCT ci2.chunk_id
         FROM semantic.chunk_indexes ci1
         JOIN semantic.chunk_indexes ci2
           ON ci1.kind = ci2.kind AND ci1.value = ci2.value
         WHERE ci1.chunk_id = ANY($1::uuid[])
           AND ci2.chunk_id <> ALL($1::uuid[])
         GROUP BY ci2.chunk_id
         HAVING count(*) >= 2
         LIMIT $3
     )
     UPDATE semantic.chunks
        SET warmth_score = warmth_score + $2
      WHERE id IN (SELECT chunk_id FROM neighbours)
      RETURNING id::text AS updated`,
    [hitChunkIds, bump, neighbourCap],
  );
  return result.rowCount ?? 0;
}

/**
 * Index weight feedback: hits on (kind, value) pairs bump their weight + hit_count
 * so the merge step naturally favours indexes that have proven useful.
 */
export async function bumpIndexWeights(
  pool: Pool,
  hitChunkIds: string[],
  delta = 0.1,
): Promise<number> {
  if (hitChunkIds.length === 0) {return 0;}
  const result = await pool.query(
    `UPDATE semantic.chunk_indexes
        SET weight = weight + $2,
            hit_count = hit_count + 1
      WHERE chunk_id = ANY($1::uuid[])`,
    [hitChunkIds, delta],
  );
  return result.rowCount ?? 0;
}
