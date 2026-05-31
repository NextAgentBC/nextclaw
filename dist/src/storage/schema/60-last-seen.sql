-- Separate "re-ingested / seen again" from "genuinely recalled".
--
-- The ingest dedup path used to bump last_recalled_at on every duplicate
-- re-ingest (the transcript-watcher re-runs every ~10s), polluting the recall
-- signal the cold-gist compactor relies on (src/workers/compactor.ts ages
-- chunks by last_recalled_at). Frequently re-seen chunks looked perpetually
-- "recalled" and could never age into the cold tier.
--
-- Going forward, dedup bumps last_seen_at + dup_count; last_recalled_at and
-- recall_count stay reserved for real recall hits (router.promoteToHotCache).

ALTER TABLE semantic.chunks
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dup_count    INT NOT NULL DEFAULT 0;

-- Seed the new column from whatever timestamp we already had.
UPDATE semantic.chunks
   SET last_seen_at = COALESCE(last_recalled_at, created_at)
 WHERE last_seen_at IS NULL;

-- Undo historical pollution: a chunk that was never genuinely recalled
-- (recall_count = 0) had its last_recalled_at set purely by the old dedup
-- path. Clear it so the compactor can age these chunks on real recency.
UPDATE semantic.chunks
   SET last_recalled_at = NULL
 WHERE recall_count = 0;
