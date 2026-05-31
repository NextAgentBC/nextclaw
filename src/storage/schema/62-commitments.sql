-- Action-sensitive memory: directives the agent might ACT on, tagged so a
-- stale or low-authority remark can't trigger a real-world side effect without
-- a check. Populated deterministically by extractCommitments (extractors.ts),
-- persisted by reconcile(), surfaced on recall (memory_search / memory_get).
--
-- agent_id is present here (unlike the other structured.* tables) because
-- acting on another agent's commitment is exactly the leak we must prevent.
-- chunk_id is a direct link so recall can fetch a chunk's commitments in one
-- cheap lookup (ON DELETE CASCADE so a hard-forget cleans them up).

CREATE TABLE IF NOT EXISTS structured.commitments (
  id                    UUID PRIMARY KEY,
  agent_id              TEXT NOT NULL DEFAULT 'main',
  chunk_id              UUID REFERENCES semantic.chunks(id) ON DELETE CASCADE,
  directive             TEXT NOT NULL,
  kind                  TEXT NOT NULL,            -- task|authorization|appointment|reminder|other
  safe_to_act           BOOLEAN NOT NULL DEFAULT false,
  requires_confirmation BOOLEAN NOT NULL DEFAULT true,
  authority             TEXT,                     -- user_direct|overheard|inferred|system
  valid_from            TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  supersedes            UUID REFERENCES structured.commitments(id),
  confidence            REAL NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commitments_active
  ON structured.commitments (agent_id, kind)
  WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS commitments_chunk
  ON structured.commitments (chunk_id);
