-- Cold archive (Phase 6): summarized gists from compactor.
-- Each gist links back to source_chunk_ids so audit / drill-down keep working.

CREATE TABLE IF NOT EXISTS cold.gists (
  id               UUID PRIMARY KEY,
  span_start       TIMESTAMPTZ NOT NULL,
  span_end         TIMESTAMPTZ NOT NULL,
  topic            TEXT NOT NULL,
  summary_text     TEXT NOT NULL,
  embedding        VECTOR NOT NULL,
  source_chunk_ids UUID[] NOT NULL,
  importance       REAL NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gists_span ON cold.gists (span_start);
-- HNSW deferred until embedding dim known; ensureHnswIndex will lock dimension.
