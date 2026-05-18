-- ============================================================================
-- Edit-operation audit columns.
--
-- v0.2 adds memory_update / memory_forget as agent-callable tools. Both
-- need to leave a clean audit trail (which chunk got rewritten or forgotten,
-- by which agent, why) so the dashboard can show memory curation activity
-- and the tuning loop can spot patterns ("agent forgets a lot of finance
-- chunks within 5 minutes of writing them — maybe wrong category").
--
-- Could be wedged into the existing `reject_reason` + `written_ids` fields,
-- but reusing those for a different lifecycle phase confuses every existing
-- view. Cleaner to add typed columns and keep the original ingest semantics
-- intact.
-- ============================================================================

ALTER TABLE audit.ingest_decisions
  ADD COLUMN IF NOT EXISTS chunk_id UUID,
  ADD COLUMN IF NOT EXISTS reason   TEXT,
  ADD COLUMN IF NOT EXISTS agent_session_id TEXT,
  ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;

-- text_hash and text_excerpt were NOT NULL since v0.1; edits don't always
-- carry a fresh text. Allow empty for edit-decisions.
ALTER TABLE audit.ingest_decisions
  ALTER COLUMN text_hash DROP NOT NULL,
  ALTER COLUMN text_excerpt DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ingest_chunk_id
  ON audit.ingest_decisions (chunk_id, ts DESC)
  WHERE chunk_id IS NOT NULL;
