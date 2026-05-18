-- ============================================================================
-- Per-agent memory namespace.
--
-- An operator may run multiple agent identities under one Postgres database (cheaper
-- than spinning up a separate DB per agent). To keep memory truly
-- isolated — so a public/shared agent can't recall the owner's private
-- chats — every chunk now carries an `agent_id` and recall paths filter on
-- it. Default 'main' for backward compat; new agents (e.g. 'club') get
-- their own column value at ingest time.
--
-- Recall router applies WHERE c.agent_id = $X on every route's SQL. The
-- chunk_indexes table stays unaware of agent_id (it always joins back to
-- chunks, which is where the filter lives).
-- ============================================================================

ALTER TABLE semantic.chunks
  ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'main';

-- Most recall paths filter (agent_id, retention_class != 'ephemeral').
CREATE INDEX IF NOT EXISTS chunks_agent
  ON semantic.chunks (agent_id)
  WHERE retention_class != 'ephemeral';

-- Cold gist + audit tables also get agent_id so the dashboard can split
-- views per agent.
ALTER TABLE cold.gists
  ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'main';

ALTER TABLE audit.ingest_decisions
  ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'main';

ALTER TABLE audit.recall_decisions
  ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS ingest_agent_ts
  ON audit.ingest_decisions (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS recall_agent_ts
  ON audit.recall_decisions (agent_id, ts DESC);
