-- semantic.chunks.updated_at — marks agent-driven curation time, set by the
-- edit operations (updateChunk / forgetChunk). The edit path referenced this
-- column but it was never defined, so memory_update / memory_forget threw
-- `column "updated_at" does not exist` at runtime. Nullable (null = never
-- edited); ADD COLUMN IF NOT EXISTS is a fast metadata-only change and stays
-- idempotent across existing deployments.
ALTER TABLE semantic.chunks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
