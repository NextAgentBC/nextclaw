-- ============================================================================
-- cache.qa — semantic Q&A cache (GPTCache-style)
--
-- Tutoring + customer-service workloads are >50% duplicate questions
-- across the lifetime of a class / product line. Without this layer
-- every "怎么算 1/3 + 1/4" goes through a full LLM call (~30-60s,
-- $0.X). With it, the second+ identical-or-similar question costs
-- ~50ms and 0 tokens.
--
-- Two access paths:
--   1. Exact-match  — sha256(question_text)         <5 ms
--   2. Semantic     — HNSW on question_embedding   ~50 ms
--
-- Viewer-scoped via the SAME three-tier filter used for chat-memory
-- (see src/recall/viewer-scope.ts). cache entries with scope_chat_id /
-- visibility=private get hidden from viewers who don't match.
--
-- Cacheability is decided per-write (default false; explicit opt-in
-- via the `cacheable` column). The Moderator (Phase C) or a CSV-seed
-- can mark entries cacheable; the agent's own write tool defaults
-- to NOT cacheable so personalisation leaks are off-by-default.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cache.qa (
  id                 UUID PRIMARY KEY,
  agent_id           TEXT NOT NULL DEFAULT 'main',

  -- the question (verbatim + embedding for exact + semantic hits)
  question_text      TEXT  NOT NULL,
  question_hash      BYTEA NOT NULL,
  question_embedding VECTOR NOT NULL,
  embedding_model    TEXT  NOT NULL,

  -- the cached answer
  answer_text        TEXT NOT NULL,
  answer_format      TEXT NOT NULL DEFAULT 'plain',  -- 'plain' | 'markdown' | 'latex'

  -- scope — joins to the existing viewer-scope rules
  scope_chat_id      TEXT,         -- NULL = global; non-NULL = per-group / per-DM
  scope_sender_id    TEXT,         -- NULL = anyone; non-NULL = only that user (private)
  scope_visibility   TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'private' | 'chat-only'
  cacheable          BOOLEAN NOT NULL DEFAULT TRUE,   -- 'false' tombstones an old entry
  topic_tag          TEXT,         -- 'math.fractions', 'policy.returns', ...

  -- source attribution
  worker_role_id     UUID,         -- which role wrote it (FK in Phase D)
  source             TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'csv-seed' | 'manual'
  source_doc_id      TEXT,         -- e.g. 'returns-policy' when seeded from a doc

  -- quality
  upvotes            INT NOT NULL DEFAULT 0,
  downvotes          INT NOT NULL DEFAULT 0,
  use_count          INT NOT NULL DEFAULT 0,
  last_used_at       TIMESTAMPTZ,

  -- lifecycle
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,  -- default +90d, set at insert
  invalidated        BOOLEAN NOT NULL DEFAULT FALSE,
  invalidated_reason TEXT
);

-- Exact-match index (fast path).
CREATE INDEX IF NOT EXISTS cache_qa_hash
  ON cache.qa (agent_id, question_hash)
  WHERE NOT invalidated AND cacheable;

-- Scope-narrowed lookup for viewer-aware filtering at SQL layer.
CREATE INDEX IF NOT EXISTS cache_qa_scope
  ON cache.qa (agent_id, scope_chat_id, scope_sender_id)
  WHERE NOT invalidated AND cacheable;

-- Quality leaderboard for dashboard.
CREATE INDEX IF NOT EXISTS cache_qa_quality
  ON cache.qa ((upvotes - downvotes) DESC, use_count DESC)
  WHERE NOT invalidated AND cacheable;

-- HNSW on embedding. Dim is locked at first insert (same as semantic.chunks).
-- The migrate runner can add this lazily once an embedding has been written.
-- We don't define it here so the migrate step matches the existing
-- ensureHnswIndex pattern for semantic.chunks.
