-- Cache layer: T1 hot chunks + computation caches.
-- All UNLOGGED — ephemeral, restartable, no WAL overhead. Phase 4 wires.

-- T1 hot chunks: per-user warm set promoted from T2.
CREATE UNLOGGED TABLE IF NOT EXISTS cache.hot_chunks (
  user_scope    TEXT NOT NULL,
  chunk_id      UUID NOT NULL,
  promoted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  warmth_score  REAL NOT NULL,
  PRIMARY KEY (user_scope, chunk_id)
);
CREATE INDEX IF NOT EXISTS hot_chunks_warmth ON cache.hot_chunks (user_scope, warmth_score DESC);
CREATE INDEX IF NOT EXISTS hot_chunks_expiry ON cache.hot_chunks (expires_at);

-- Embedding cache: text_hash -> vector. Lets writeChunk/search skip re-embedding.
CREATE UNLOGGED TABLE IF NOT EXISTS cache.embeddings (
  text_hash  BYTEA PRIMARY KEY,
  model      TEXT NOT NULL,
  embedding  VECTOR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Intent classifier cache (Phase 4).
CREATE UNLOGGED TABLE IF NOT EXISTS cache.intent (
  query_hash BYTEA PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Recall result cache (Phase 4): query+scope_anchors -> top-k.
CREATE UNLOGGED TABLE IF NOT EXISTS cache.recall (
  query_hash  BYTEA NOT NULL,
  scope_key   TEXT NOT NULL,
  top_k       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  invalidated BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (query_hash, scope_key)
);

-- Entity alias resolution cache (alias_normalized -> entity_id).
CREATE UNLOGGED TABLE IF NOT EXISTS cache.entity_alias (
  alias_normalized TEXT PRIMARY KEY,
  entity_id        UUID NOT NULL,
  confidence       REAL NOT NULL,
  refreshed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
