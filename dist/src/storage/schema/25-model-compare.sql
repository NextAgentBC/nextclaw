-- ============================================================================
-- Model comparison shadow runs.
--
-- For every gpt-5.5 turn observed in the agent trajectory file, the shadow
-- comparator worker replays the same prompt against a challenger model
-- (qwen3.6-35B-A3B by default) and records both sides here. Side-by-side
-- data drives the dashboard's "Model Comparison" panel and gives the operator a
-- decision basis on whether to switch the primary model.
--
-- Shadow runs do NOT block the live Discord reply — they're best-effort,
-- async, and a failed shadow row is not a system error.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit.model_comparisons (
  id              UUID PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- gpt-5.5 turn identity (one row per (run_id, challenger))
  trajectory_run_id  TEXT NOT NULL,
  agent_session_id   TEXT NOT NULL,
  user_message       TEXT,                  -- last user msg from the prompt
  prompt_hash        BYTEA NOT NULL,        -- sha256 of the message list

  -- baseline (gpt-5.5 / openai-codex)
  base_model      TEXT NOT NULL,
  base_latency_ms INT,                      -- model.completed - prompt.submitted
  base_in_tokens  INT,                      -- usage.input
  base_out_tokens INT,                      -- usage.output
  base_cache_read INT,                      -- usage.cacheRead
  base_output     TEXT,                     -- assistantTexts joined
  base_tool_count INT,                      -- toolMetas.length
  base_cold_start BOOL DEFAULT false,       -- inferred from prior turn gap

  -- challenger (e.g. Qwen3.6, vLLM, local-llm, ...)
  ch_model        TEXT NOT NULL,
  ch_endpoint     TEXT NOT NULL,            -- chat endpoint URL
  ch_latency_ms   INT,
  ch_in_tokens    INT,
  ch_out_tokens   INT,
  ch_output       TEXT,
  ch_error        TEXT,                     -- non-null = shadow failed

  -- summary metrics
  speed_ratio     REAL,                     -- base_latency / ch_latency (>1 → challenger faster)
  out_len_ratio   REAL                      -- length(base_output) / length(ch_output)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_compare_dedup
  ON audit.model_comparisons (trajectory_run_id, ch_model);
CREATE INDEX IF NOT EXISTS model_compare_ts
  ON audit.model_comparisons (ts DESC);
CREATE INDEX IF NOT EXISTS model_compare_session
  ON audit.model_comparisons (agent_session_id, ts DESC);
