-- One open proposal per (scope, proposal_type).
--
-- The daily analyzer re-runs and re-emitted identical proposals every pass, so
-- audit.tuning_proposals accumulated duplicate pending rows (observed in the
-- field: 15x score_regression, 8x cache.recall.ttl). Collapse the existing
-- duplicates (keep the most recent per scope+type), then enforce uniqueness so
-- re-runs refresh the open proposal instead of duplicating it (writeProposal
-- now upserts via ON CONFLICT — see src/workers/tuning.ts).

DELETE FROM audit.tuning_proposals
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            row_number() OVER (
              PARTITION BY scope, proposal_type
              ORDER BY ts DESC, id DESC
            ) AS rn
       FROM audit.tuning_proposals
       WHERE status = 'pending'
   ) ranked
   WHERE ranked.rn > 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS tuning_one_open_per_scope
  ON audit.tuning_proposals (scope, proposal_type)
  WHERE status = 'pending';
