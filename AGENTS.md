# nextclaw — contributor guide

**English** · [简体中文](AGENTS.zh-CN.md)

Postgres + pgvector backed memory plugin for OpenClaw. Fills `plugins.slots.memory`.

## Scope

- Replaces `memory-core` (the bundled SQLite backend) when slotted in
- 4-tier memory: T0 in-process / T1 PG UNLOGGED hot cache / T2 main / T3 cold gist
- Multi-key indexing ("Xinhua dictionary"): every chunk indexed on concept tags, entity refs, anchors (cwd/branch/PR/file), time buckets, metric/preference keys, and 6+1 taxonomy categories
- Ingest pipeline: deterministic + sidecar JSON + cache, LLM only as residual
- Recall: tier-walk T0→T1→T2→T3, parallel routes (no skip when high-precision anchors are absent)
- Memory operation scoring (ingest_score / recall_score) on every event
- Self-tuning loop (daily / weekly / monthly proposals)
- Dashboard via PG LISTEN/NOTIFY
- Hard per-agent memory namespace isolation (`agent_id` column threaded through every recall path)
- Action-sensitive commitments: directives the agent might act on are tagged (`safe_to_act` / `requires_confirmation` / `authority` / validity) and surfaced with a ⚠ on recall, so a stray remark can't trigger an action

## Layout

| Path | Owns |
|---|---|
| `src/storage/` | pg.Pool, schema DDL, migrations |
| `src/embedding/` | OpenAI-compat embedding client + chat client (for shadow comparator) |
| `src/ingest/` | Stage 0–6 pipeline + sidecar prompt-builder |
| `src/recall/` | Tier-walk + parallel route impls + intent + merge |
| `src/workers/` | context-primer, spreading-activator, compactor, feedback, scoring, tuning, git-watcher, transcript-watcher, shadow-comparator |
| `src/cache/` | CacheBackend abstraction + PG UNLOGGED impl |
| `src/structured/` | entity / event / metric / preference / commitment extractors + reconcile + categorizer (+ `commitments.ts` recall-side reader) |
| `src/sdk/` | StructuredMemoryAPI public exports |
| `src/dashboard/` | HTTP server + SPA assets + bot-stats |
| `src/cli/` | tail (router-explain, audit, stats, etc. live in dashboard) |
| `skills/` | OpenClaw ops skills shipped with the plugin (currently `openclaw-selfcare` — safe self-upgrade of openclaw + this plugin) |

## Rules

- All SQL goes through `pg.Pool` from `src/storage/pool.ts`. Never embed connection strings.
- Schema changes belong in `src/storage/schema/*.sql` + `src/storage/migrate.ts`. Never mutate via ad-hoc DDL.
- Every audit row carries a `score` (ingest) or `score + relevance_estimate` (recall).
- Score computation lives in `src/scoring.ts`. Do not inline the formula in route code.
- Prefer deterministic signals (Stage 0) before sidecar before LLM. New features must fit this hierarchy.
- Embedding adapter swaps must work; never hardcode model id outside config.
- Cache backend swaps must work; never bypass the `CacheBackend` interface.
- Dashboard endpoints serve **localhost-only** by default. Anything beyond `127.0.0.1` requires explicit token via `dashboard.tokenEnv`.
- Tuning auto-apply only acts on `safe_auto` proposals; everything else writes to `audit.tuning_proposals` with `status='pending'`.

## Testing

- Unit: per-module under `src/**/*.test.ts`
- Live: `test/*.live.test.ts` need `OPENCLAW_LIVE_TEST=1` and a reachable Postgres + embedding endpoint
- Run unit: `pnpm test`

## Dependencies

- `pg` (node-postgres) — supports LISTEN/NOTIFY which the dashboard needs
- `pgvector` — pgvector type binding for `pg`
- `undici` — HTTP client for the IPv4-first dispatcher to `api.telegram.org` (`src/moderator/telegram-api.ts`). Declared directly, not relied on transitively, so an OpenClaw dependency-tree change can't make it vanish.

## Cross-extension contracts

- Self-embeds: an internal `EmbeddingClient` (manager-runtime → OpenAI-compat / Ollama endpoint) does its own embedding. nextclaw is an embedding **consumer**, not a host provider — it does **not** register a `MemoryEmbeddingProviderAdapter` and declares no `contracts.embeddingProviders`
- Implements `MemorySearchManager` from `openclaw/plugin-sdk/memory-core-host-engine-storage`
- Exposes `StructuredMemoryAPI` barrel for plugins that want SQL-shaped access
