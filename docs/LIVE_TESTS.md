# Live tests

Most files under `test/` are gated by `OPENCLAW_LIVE_TEST=1` because
they require a running Postgres + embedding endpoint and we don't want
CI failures in environments without those.

## Prerequisites

```bash
cd dev/ && docker compose up -d            # Postgres on 127.0.0.1:55432
ollama serve & ollama pull nomic-embed-text   # Embedding endpoint
```

## Running

From the OpenClaw repo root (or from within the extension dir if you
have its own test runner):

```bash
export OPENCLAW_LIVE_TEST=1
export NEXTCLAW_DB_URL='postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw'
export NEXTCLAW_EMBED_URL='http://127.0.0.1:11434'
export NEXTCLAW_EMBED_MODEL='nomic-embed-text'

# All live tests
pnpm test extensions/memory-postgres/test/

# Or a specific file
pnpm test extensions/memory-postgres/test/recall.live.test.ts
```

Without `OPENCLAW_LIVE_TEST=1`, all `*.live.test.ts` files skip
silently.

## What each live test covers

| File | What it asserts |
|---|---|
| `e2e.live.test.ts` | Full ingest → recall round-trip; `agent_id` isolation; multi-key index derivation |
| `pipeline.live.test.ts` | Stage 0–6 ingest pipeline behaviour: trash filter, dedup, sidecar, multi-key writes |
| `recall.live.test.ts` | All 8 routes fire correctly; MMR rerank diversity; cache.recall TTL |
| `structured.live.test.ts` | Extractor reconcile (entities, events, metrics, preferences) |
| `compactor.live.test.ts` | 90-day cold gist consolidation |
| `tuning.live.test.ts` | Self-tuning analyzer fires on scheduled cadences |
| `dashboard.live.test.ts` | HTTP endpoints return expected shapes; SSE delivers audit events |
| `qwen3.live.test.ts` | Embedding endpoint reachability + response shape |

## Test isolation

Each test creates a unique `source` prefix and seeds chunks under it.
Cleanup runs in `afterEach` via `DELETE FROM semantic.chunks WHERE
source LIKE '<prefix>:%'` plus cascading `cache.*` and `audit.*` rows.

If a test fails mid-way and leaves state, run:

```bash
docker exec -e PGPASSWORD=nextclaw nextclaw-pg psql -U nextclaw -d nextclaw -c "
DELETE FROM semantic.chunks WHERE source LIKE 'test-%';
DELETE FROM cache.recall;
DELETE FROM cache.intent;
"
```

## Adding a new live test

1. Name it `*.live.test.ts` so it auto-skips without the env flag
2. Use a unique `source` prefix per test (`secrets.token_hex(4)` style)
3. Clean up in `afterEach`
4. Don't share state between test files; each file owns its data

## CI considerations

The standard CI pipeline does **not** run these — they require
infrastructure that's expensive to spin up per run. Run them locally
before opening a PR that touches:

- `src/storage/schema/*.sql` (any schema change)
- `src/recall/router.ts` or `src/recall/routes.ts`
- `src/ingest/pipeline.ts`
- The `transcript-watcher` / `git-watcher` / `shadow-comparator`
  workers
- Anything in `src/dashboard/server.ts` that affects API endpoints
