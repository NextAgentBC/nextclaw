-- Audit & scoring tables. Every ingest and recall event lands here with a 0-100 score.
-- LISTEN/NOTIFY trigger fires on INSERT so the dashboard can stream events in real time.

CREATE TABLE IF NOT EXISTS audit.dream_runs (
  id              UUID PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  phase           TEXT NOT NULL,
  items_in        INT  NOT NULL DEFAULT 0,
  items_out       INT  NOT NULL DEFAULT 0,
  items_filtered  INT  NOT NULL DEFAULT 0,
  model           TEXT,
  cost_tokens     INT
);
CREATE INDEX IF NOT EXISTS dream_runs_ts ON audit.dream_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS audit.ingest_decisions (
  id               UUID PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  source           TEXT NOT NULL,
  text_hash        BYTEA NOT NULL,
  text_excerpt     TEXT NOT NULL,                            -- truncated 200 chars
  decision         TEXT NOT NULL,                            -- accepted|rejected|merged|quarantined
  reject_reason    TEXT,                                     -- duplicate|too_short|noise_regex|low_salience|boilerplate|...
  routes           TEXT[] NOT NULL DEFAULT '{}',
  ingest_path      TEXT NOT NULL,                            -- deterministic|sidecar|cache|llm_residual
  salience         REAL,
  llm_tokens_used  INT  NOT NULL DEFAULT 0,
  latency_ms       INT,
  score            REAL,                                     -- 0-100, computed at insert
  dream_run_id     UUID REFERENCES audit.dream_runs(id),
  written_ids      JSONB
);
CREATE INDEX IF NOT EXISTS ingest_ts        ON audit.ingest_decisions (ts DESC);
CREATE INDEX IF NOT EXISTS ingest_decision  ON audit.ingest_decisions (decision, ts DESC);
CREATE INDEX IF NOT EXISTS ingest_path      ON audit.ingest_decisions (ingest_path, ts DESC);
CREATE INDEX IF NOT EXISTS ingest_score     ON audit.ingest_decisions (score) WHERE score IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingest_dream_run ON audit.ingest_decisions (dream_run_id);

CREATE TABLE IF NOT EXISTS audit.recall_decisions (
  id                  UUID PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_text          TEXT NOT NULL,
  hit_tier            TEXT NOT NULL,                         -- t0|t1|t2_anchor|t2_hybrid|t2_full|t3
  intent              JSONB,
  candidates          INT  NOT NULL,
  returned            INT  NOT NULL,
  agent_session_id    TEXT,
  llm_tokens_used     INT  NOT NULL DEFAULT 0,
  embed_calls         INT  NOT NULL DEFAULT 0,
  latency_ms          INT,
  score               REAL,                                  -- partial at insert; refined on follow-up
  relevance_estimate  REAL,                                  -- async-filled from agent follow-up signal
  scored_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS recall_ts                ON audit.recall_decisions (ts DESC);
CREATE INDEX IF NOT EXISTS recall_tier              ON audit.recall_decisions (hit_tier, ts DESC);
CREATE INDEX IF NOT EXISTS recall_score             ON audit.recall_decisions (score) WHERE score IS NOT NULL;
CREATE INDEX IF NOT EXISTS recall_pending_relevance ON audit.recall_decisions (ts) WHERE relevance_estimate IS NULL;

-- Real-time fan-out for dashboard via PG LISTEN audit_events.
CREATE OR REPLACE FUNCTION audit.notify_event() RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
BEGIN
  payload := jsonb_build_object(
    'table', TG_TABLE_NAME,
    'op',    TG_OP,
    'id',    NEW.id,
    'ts',    NEW.ts
  );
  IF TG_TABLE_NAME = 'ingest_decisions' THEN
    payload := payload || jsonb_build_object(
      'decision',     NEW.decision,
      'ingest_path',  NEW.ingest_path,
      'score',        NEW.score
    );
  ELSIF TG_TABLE_NAME = 'recall_decisions' THEN
    payload := payload || jsonb_build_object(
      'hit_tier',     NEW.hit_tier,
      'returned',     NEW.returned,
      'score',        NEW.score
    );
  END IF;
  PERFORM pg_notify('audit_events', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ingest_decisions_notify ON audit.ingest_decisions;
CREATE TRIGGER ingest_decisions_notify
  AFTER INSERT ON audit.ingest_decisions
  FOR EACH ROW EXECUTE FUNCTION audit.notify_event();

DROP TRIGGER IF EXISTS recall_decisions_notify ON audit.recall_decisions;
CREATE TRIGGER recall_decisions_notify
  AFTER INSERT ON audit.recall_decisions
  FOR EACH ROW EXECUTE FUNCTION audit.notify_event();

-- Hourly score / volume rollup; cheap to query for dashboard.
CREATE OR REPLACE VIEW audit.scores_hourly AS
  SELECT date_trunc('hour', ts) AS hour,
         'ingest'::TEXT AS op,
         ingest_path AS path,
         AVG(score)::REAL  AS avg_score,
         AVG(llm_tokens_used)::REAL AS avg_tokens,
         AVG(latency_ms)::REAL      AS avg_latency_ms,
         COUNT(*)            AS n
  FROM audit.ingest_decisions
  WHERE score IS NOT NULL
  GROUP BY 1, 3
UNION ALL
  SELECT date_trunc('hour', ts) AS hour,
         'recall'::TEXT AS op,
         hit_tier AS path,
         AVG(score)::REAL  AS avg_score,
         AVG(llm_tokens_used)::REAL AS avg_tokens,
         AVG(latency_ms)::REAL      AS avg_latency_ms,
         COUNT(*)            AS n
  FROM audit.recall_decisions
  WHERE score IS NOT NULL
  GROUP BY 1, 3;
