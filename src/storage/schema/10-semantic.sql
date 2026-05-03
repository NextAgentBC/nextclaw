-- Semantic layer: chunks (with HNSW + tsvector + trigram) and multi-key indexes.
-- Embedding column uses VECTOR (no fixed dim); dims tracked in audit.plugin_meta key='embedding.dims'.

CREATE TABLE IF NOT EXISTS semantic.chunks (
  id                UUID PRIMARY KEY,
  source            TEXT NOT NULL,
  source_ref        TEXT,
  kind              TEXT NOT NULL,
  text              TEXT NOT NULL,
  text_hash         BYTEA NOT NULL,
  embedding         VECTOR NOT NULL,
  embedding_model   TEXT NOT NULL,
  agent_session_id  TEXT,
  retention_class   TEXT NOT NULL DEFAULT 'standard',
  importance        REAL NOT NULL DEFAULT 0.5,
  recall_count      INT  NOT NULL DEFAULT 0,
  warmth_score      REAL NOT NULL DEFAULT 0.0,
  last_recalled_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by     UUID REFERENCES semantic.chunks(id)
);

-- HNSW + tsvector + trigram serve the "新华字典" lookup paths (语义/笔画/同音字).
-- HNSW operator class is created lazily once the dimension is known (see migrate.ts).
CREATE INDEX IF NOT EXISTS chunks_fts
  ON semantic.chunks USING gin (to_tsvector('simple', text));
CREATE INDEX IF NOT EXISTS chunks_trgm
  ON semantic.chunks USING gist (text gist_trgm_ops);
CREATE INDEX IF NOT EXISTS chunks_warmth
  ON semantic.chunks (warmth_score DESC)
  WHERE retention_class != 'ephemeral';
CREATE UNIQUE INDEX IF NOT EXISTS chunks_dedup
  ON semantic.chunks (text_hash, source);

-- Multi-key index table: every chunk gets multiple (kind, value) entries.
-- kind values:
--   'concept_tag' | 'entity_ref' | 'time_bucket' | 'metric_name' | 'preference_key' | 'event_type'
--   'anchor_cwd' | 'anchor_branch' | 'anchor_pr' | 'anchor_file' | 'anchor_session' | 'anchor_date'
CREATE TABLE IF NOT EXISTS semantic.chunk_indexes (
  chunk_id   UUID NOT NULL REFERENCES semantic.chunks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  hit_count  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (chunk_id, kind, value)
);
CREATE INDEX IF NOT EXISTS chunk_indexes_lookup
  ON semantic.chunk_indexes (kind, value);
CREATE INDEX IF NOT EXISTS chunk_indexes_value_trgm
  ON semantic.chunk_indexes USING gist (value gist_trgm_ops);
