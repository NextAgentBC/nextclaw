-- Self-tuning proposals (Phase 8 schema; Phase 1 lays the table so analyzer can be wired later).

CREATE TABLE IF NOT EXISTS audit.tuning_proposals (
  id              UUID PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  cadence         TEXT NOT NULL,                    -- daily|weekly|monthly
  scope           TEXT NOT NULL,                    -- trash_regex|salience_threshold|tier_capacity|...
  proposal_type   TEXT NOT NULL,                    -- add|remove|adjust|replace
  current_value   JSONB,
  proposed_value  JSONB NOT NULL,
  evidence        JSONB NOT NULL,
  risk_class      TEXT NOT NULL,                    -- safe_auto|review_required|high_risk
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|auto_applied|approved|rejected|reverted
  applied_at      TIMESTAMPTZ,
  reverted_at     TIMESTAMPTZ,
  reason          TEXT,
  config_path     TEXT,                             -- openclaw.json json-pointer
  rollback_value  JSONB
);
CREATE INDEX IF NOT EXISTS tuning_pending
  ON audit.tuning_proposals (cadence, status, ts DESC);
CREATE INDEX IF NOT EXISTS tuning_scope
  ON audit.tuning_proposals (scope, status, ts DESC);

-- 24h auto-revert guard: track key metrics around an auto-applied change.
CREATE TABLE IF NOT EXISTS audit.tuning_guards (
  proposal_id     UUID PRIMARY KEY REFERENCES audit.tuning_proposals(id),
  applied_at      TIMESTAMPTZ NOT NULL,
  baseline_score  REAL NOT NULL,
  baseline_window TSTZRANGE NOT NULL,
  observed_score  REAL,
  observed_window TSTZRANGE,
  decision        TEXT,                             -- ok|reverted|inconclusive
  decided_at      TIMESTAMPTZ
);
