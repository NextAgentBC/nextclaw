-- Runs once on first container start (Postgres docker-entrypoint-initdb.d convention).
-- Installs the extensions the memory-postgres plugin requires.

CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector for HNSW + cosine
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy / typo / 同音字 matching
CREATE EXTENSION IF NOT EXISTS btree_gin;    -- composite GIN over scalar + text
