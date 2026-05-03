-- Bootstrap: extensions and schemas.
-- Run by migrate.ts before all other schema files.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE SCHEMA IF NOT EXISTS semantic;
CREATE SCHEMA IF NOT EXISTS structured;
CREATE SCHEMA IF NOT EXISTS cache;
CREATE SCHEMA IF NOT EXISTS cold;
CREATE SCHEMA IF NOT EXISTS audit;

-- Schema migration tracker (used by migrate.ts).
CREATE TABLE IF NOT EXISTS audit.schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum    BYTEA NOT NULL
);

-- Plugin metadata (single-row).
CREATE TABLE IF NOT EXISTS audit.plugin_meta (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
