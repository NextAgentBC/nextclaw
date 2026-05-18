-- Structured layer: entities, relations, events, preferences, metrics, provenance.
-- All structured rows link back to a semantic.chunks row via structured.provenance,
-- enabling drill-down ("why do you think this?") and audit.

CREATE TABLE IF NOT EXISTS structured.entities (
  id            UUID PRIMARY KEY,
  type          TEXT NOT NULL,                   -- person|project|repo|file|tool|concept|...
  canonical_name TEXT NOT NULL,
  aliases       TEXT[] NOT NULL DEFAULT '{}',
  attrs         JSONB NOT NULL DEFAULT '{}',
  confidence    REAL NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  deleted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_canonical
  ON structured.entities (type, canonical_name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS entities_aliases_gin
  ON structured.entities USING gin (aliases);
CREATE INDEX IF NOT EXISTS entities_name_trgm
  ON structured.entities USING gist (canonical_name gist_trgm_ops);

CREATE TABLE IF NOT EXISTS structured.relations (
  id          UUID PRIMARY KEY,
  subject_id  UUID NOT NULL REFERENCES structured.entities(id),
  predicate   TEXT NOT NULL,                     -- works_on|maintains|prefers|...
  object_id   UUID REFERENCES structured.entities(id),
  object_text TEXT,
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  confidence  REAL NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relations_subject  ON structured.relations (subject_id, predicate);
CREATE INDEX IF NOT EXISTS relations_object   ON structured.relations (object_id);

CREATE TABLE IF NOT EXISTS structured.events (
  id         UUID PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL,
  end_ts     TIMESTAMPTZ,
  type       TEXT NOT NULL,
  actor_id   UUID REFERENCES structured.entities(id),
  target_id  UUID REFERENCES structured.entities(id),
  details    JSONB NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_ts        ON structured.events (ts DESC);
CREATE INDEX IF NOT EXISTS events_type_ts   ON structured.events (type, ts DESC);
CREATE INDEX IF NOT EXISTS events_actor     ON structured.events (actor_id, ts DESC);

-- Immutable supersede chain for preferences/decisions/rules.
CREATE TABLE IF NOT EXISTS structured.preferences (
  id              UUID PRIMARY KEY,
  scope           TEXT NOT NULL,                 -- global|project:<id>|agent:<id>
  key             TEXT NOT NULL,
  value           JSONB NOT NULL,
  rule_text       TEXT,
  evidence_count  INT  NOT NULL DEFAULT 1,
  confidence      REAL NOT NULL,
  supersedes      UUID REFERENCES structured.preferences(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS prefs_active
  ON structured.preferences (scope, key)
  WHERE invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS structured.metrics (
  id         UUID PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL,
  metric     TEXT NOT NULL,
  value      NUMERIC NOT NULL,
  unit       TEXT,
  dim        JSONB NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metrics_lookup ON structured.metrics (metric, ts DESC);

CREATE TABLE IF NOT EXISTS structured.provenance (
  id                UUID PRIMARY KEY,
  item_kind         TEXT NOT NULL,               -- entity|relation|event|preference|metric
  item_id           UUID NOT NULL,
  chunk_id          UUID REFERENCES semantic.chunks(id),
  dream_run_id      UUID REFERENCES audit.dream_runs(id),
  raw_excerpt       TEXT NOT NULL,
  extractor         TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provenance_item  ON structured.provenance (item_kind, item_id);
CREATE INDEX IF NOT EXISTS provenance_chunk ON structured.provenance (chunk_id);
