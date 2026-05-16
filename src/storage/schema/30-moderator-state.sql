-- ============================================================================
-- Moderator state — Phase C
--
-- The Moderator is a persistent, "always-alert" agent per (agent_id,
-- scope_key) where scope_key is the Telegram chat id (or "dm:<user>")
-- it's responsible for. It receives every inbound message, decides
-- (ignore / answer-direct / decompose / write-only / clarify / escalate),
-- spawns worker codex runs, manages a roster of worker roles, and writes
-- back to the chat.
--
-- State is kept in a single JSONB column rather than 8 sub-tables because
--   (a) the shape will evolve quickly during prompt iteration;
--   (b) one indexed row per scope makes load/save O(1);
--   (c) JSONB is queryable enough for dashboard panels without joins.
--
-- The audit trail of decisions is separate (moderator.decisions) so we
-- have an append-only log of every routing choice for replay + tuning.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS moderator;

-- one row per (agent_id, scope_key) — scope_key is the persistent
-- conversation identifier ("tg:chat:<chat_id>" or "tg:dm:<user_id>")
CREATE TABLE IF NOT EXISTS moderator.state (
  agent_id        TEXT NOT NULL DEFAULT 'main',
  scope_key       TEXT NOT NULL,                         -- e.g. tg:chat:-100..., tg:dm:8064984663
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 'live' = active; 'paused' = takeover by human; 'archived' = inactive scope
  status          TEXT NOT NULL DEFAULT 'live',
  -- bookkeeping
  message_count   BIGINT NOT NULL DEFAULT 0,
  decision_count  BIGINT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_review_at  TIMESTAMPTZ,
  paused_by       TEXT,                                  -- user id who issued /takeover
  paused_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, scope_key)
);

CREATE INDEX IF NOT EXISTS moderator_state_status
  ON moderator.state (status, last_message_at DESC)
  WHERE status = 'live';

CREATE INDEX IF NOT EXISTS moderator_state_last_msg
  ON moderator.state (last_message_at DESC NULLS LAST);

-- append-only log of every Moderator decision (one row per LLM call)
-- for tuning + replay + dashboard "what's the bot thinking" view.
CREATE TABLE IF NOT EXISTS moderator.decisions (
  id               UUID PRIMARY KEY,
  agent_id         TEXT NOT NULL DEFAULT 'main',
  scope_key        TEXT NOT NULL,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- what triggered the decision
  trigger_kind     TEXT NOT NULL,            -- 'message' | 'cron' | 'worker-result'
  trigger_user_id  TEXT,                     -- sender of the message (NULL for cron)
  trigger_text     TEXT,                     -- truncated for storage; full in audit if needed

  -- what the LLM decided
  action           TEXT NOT NULL,            -- ignore | answer-direct | answer-decompose | write-only | clarify | escalate
  rationale        TEXT,                     -- one-liner why
  decision_json    JSONB NOT NULL,           -- the full parsed decision

  -- LLM bookkeeping
  model            TEXT,                     -- e.g. openai/gpt-5.5
  input_tokens     INT,
  output_tokens    INT,
  latency_ms       INT,

  -- outcome
  workers_spawned  INT NOT NULL DEFAULT 0,
  errors           TEXT[]
);

CREATE INDEX IF NOT EXISTS moderator_decisions_scope_ts
  ON moderator.decisions (scope_key, ts DESC);
CREATE INDEX IF NOT EXISTS moderator_decisions_action
  ON moderator.decisions (action, ts DESC);

-- Worker roles registered by the Moderator (or seeded by the operator).
-- "long-lived role, short-lived invocation" — the role row is the stable
-- specialist definition; each invocation is a transient codex run.
CREATE TABLE IF NOT EXISTS moderator.worker_roles (
  id               UUID PRIMARY KEY,
  agent_id         TEXT NOT NULL DEFAULT 'main',
  role_key         TEXT NOT NULL,            -- stable id: 'math_tutor_grade5', 'returns_specialist'
  display_name     TEXT,
  system_prompt    TEXT NOT NULL,
  tools            TEXT[] NOT NULL DEFAULT '{}',   -- which agent tools this role gets
  memory_scope     JSONB NOT NULL DEFAULT '{}',    -- { kind_filter, topic_filter, ... } for memory_search
  model            TEXT NOT NULL DEFAULT 'openai/gpt-5.5',
  -- lifecycle
  created_by_scope TEXT,                     -- which scope created this role (null = seeded)
  ttl_idle_minutes INT NOT NULL DEFAULT 30,
  invocation_count BIGINT NOT NULL DEFAULT 0,
  last_invoked_at  TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, role_key)
);

CREATE INDEX IF NOT EXISTS moderator_roles_agent
  ON moderator.worker_roles (agent_id, active);
