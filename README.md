# nextclaw

> Postgres + pgvector long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw).
> 4-tier recall · multi-key Xinhua-dictionary indexing · deterministic-first ingest · self-tuning · hard per-agent isolation · real-time dashboard.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: 0.1.0 — initial release](https://img.shields.io/badge/status-0.1.0-orange)

---

## Why

OpenClaw ships with a SQLite-backed memory plugin (`memory-core`). It works, but a single-file SQLite store hits walls fast: limited concurrency, awkward to share between agents, no first-class vector index, no fan-out across multiple recall routes, no per-event audit trail, no built-in dashboard. Once memory is your **long-term substrate** rather than a per-session log, you want a real database under it.

**nextclaw** replaces `memory-core` with a Postgres + pgvector backend designed around how human memory actually retrieves things — fast for warm content, lazy for cold content, multi-angle for ambiguous queries, and self-consolidating over time. It slots into OpenClaw via the same `plugins.slots.memory` seam, so every other OpenClaw feature (Discord / Telegram / WhatsApp / Slack channels, agent prompt builder, dreaming, etc.) just works on top.

## Core ideas

### 4-tier recall (cheap → expensive, walked top-down)

| Tier | Storage | Latency | LLM tokens | Embed RTT | When it fires |
|---|---|---|---|---|---|
| T0 | In-process LRU per `(agent_id, session_id)` | < 0.1 ms | 0 | 0 | Recently-touched chunks in the live session |
| T1 | `cache.recall` (PG UNLOGGED) keyed on query+scope | ~ 1 ms | 0 | 0 | Same query repeats within a 5-minute window |
| T2 anchor | `chunk_indexes (kind=anchor_*)` joined to chunks | ~ 5-15 ms | 0 | 0 | Caller passed (or query implied) `pr` / `file` / `branch` |
| T2 hybrid | All 8 routes in parallel + MMR merge | ~ 200-300 ms | 0 | 1 | Generic queries where no high-precision anchor exists |
| T3 | `cold.gists` (compacted summaries) | ~ 200 ms | varies | 1 | T2 returned nothing useful and the question is historical |

### Xinhua-dictionary multi-key indexing

Every chunk is indexed on as many orthogonal keys as we can derive deterministically:

- semantic vector (HNSW)
- fulltext (tsvector / GIN)
- trigram (`pg_trgm` / GIST)
- concept tags (camelCase / hyphenated / CJK noun phrases — derived from the chunk text, no LLM)
- entity references (resolved against `structured.entities`)
- time buckets (`YYYY-MM-DD`)
- anchors (`cwd` / `branch` / `pr` / `file` / `session`)
- categories (`health` / `medical` / `tech` / `life` / `work` / `finance` / `other` — deterministic CN+EN dictionary, multi-label)
- metric names + preference keys (when sidecar/structured extraction fired)

When you ask a question, the recall router fans out **in parallel**, no skipping. Multi-key hits compound via MMR rerank, so a chunk that matches semantically AND on concept-tag AND on time-bucket beats a chunk that matches one route weakly. This is the "look up the same character via multiple paths" idea borrowed from how Chinese dictionaries solve recall: pinyin / radical / stroke count / corner code / four-corner / phonetic / by neighbor character.

### Deterministic-first ingest

Stage 0 (deterministic regex / tool-call metadata / sidecar JSON) and Stage 3 (embedding cache) cover the bulk of writes. The LLM only enters as a Stage 4 residual when prior stages produced nothing. In a typical workload, **0 LLM tokens are spent on ingest**.

```
Stage 1  trash filter (bilingual CN/EN boilerplate)
   ↓ pass
Stage 0  deterministic extractors (entities / events / metrics / prefs / relations / concept tags / categories)
Stage 2  sidecar JSON parse (when present, with auto-disable on N consecutive bad JSON)
   ↓ merge
Stage 3  embedding cache
Stage 4  LLM residual (only if Stage 0+2+3 all empty)
Stage 5  parallel multi-key index writes
Stage 6  reconcile + provenance + audit + scoring
```

### Hard per-agent memory namespace isolation

Every chunk carries an `agent_id`. All 8 recall routes filter `WHERE c.agent_id = $X`. T0 working sets and `cache.recall` scope keys both incorporate the agent id. Run multiple agent personas (e.g. one for your private DM, one for a public Discord server) and they share the database but never each other's memory — no app-layer trust required, the SQL filter is the boundary.

Validated with adversarial probes: a secondary agent issuing 6 different queries explicitly designed to surface the primary agent's chunks recovered **0** of them.

### Real-time observability

- Postgres `LISTEN/NOTIFY` triggers fire on every audit row insert
- Local HTTP dashboard (`127.0.0.1:8765` by default) subscribes via SSE
- Bilingual (CN/EN) panels for ingest decisions, recall tier hits, category distribution, bot turn latency, and shadow model comparison
- Health/medical excerpts auto-redacted at the dashboard layer (defense in depth on top of category-driven privacy policy)

### Self-tuning loop

A scheduled worker analyzes `audit.*` rows on three cadences:

- **Daily** (cron 04:00) — purely SQL, 0 LLM. Auto-applies `safe_auto` proposals: dead trash regex pruning, frequent-reject pattern promotion, cache TTL adjustment, index weight normalization.
- **Weekly** — A/B replay against threshold deltas, writes proposals to `audit.tuning_proposals` with status `pending` for human review.
- **Monthly** — schema-evolution proposals (new structured types emerging in the data, embedding model refresh, etc.). Always `pending`.

## Layout

```
nextclaw/
├── index.ts                    # Plugin entry — definePluginEntry({...})
├── manager-runtime.ts          # MemoryPluginRuntime export
├── api.ts                      # Public barrel
├── openclaw.plugin.json        # Plugin manifest + JSON Schema for config
├── package.json                # peerDependencies: openclaw
├── src/
│   ├── config.ts               # Resolved + raw config types
│   ├── manager.ts              # MemorySearchManager impl
│   ├── tools.ts                # memory_search / memory_store agent tools
│   ├── prompt-section.ts       # Prompt-builder hook (sidecar instruction)
│   ├── scoring.ts              # ingest_score / recall_score formulas
│   ├── doctor.ts               # Health checks
│   ├── storage/                # pg.Pool + schema/*.sql + migrate.ts
│   ├── embedding/              # OpenAI-compat embedding + chat clients
│   ├── ingest/                 # Stages 0-6 pipeline + sidecar + trash
│   ├── recall/                 # Tier-walk + 8 routes + MMR + working-set
│   ├── workers/                # transcript / git / shadow / compactor / activator / tuning
│   ├── structured/             # Extractors + categorizer + reconcile
│   ├── cache/                  # CacheBackend + PG UNLOGGED impl
│   ├── dashboard/              # HTTP server + bot-stats + SPA assets
│   ├── sdk/                    # StructuredMemoryAPI public exports
│   └── cli/                    # tail + future CLI surface
├── test/                       # Live tests (require OPENCLAW_LIVE_TEST=1)
└── dev/
    ├── docker-compose.yml      # pgvector/pgvector:pg16 on 127.0.0.1:55432
    └── init.d/00-extensions.sql
```

## Install

### 1. Bring up Postgres with pgvector

```bash
cd dev/
docker compose up -d
# Postgres is now on 127.0.0.1:55432
# Database: nextclaw  User: nextclaw  Password: nextclaw
```

The `init.d/` script creates the `vector`, `pg_trgm`, and `btree_gin` extensions on first start.

### 2. Drop into OpenClaw's `extensions/` directory

```bash
cd /path/to/openclaw/extensions
git clone https://github.com/NextAgentBC/nextclaw.git memory-postgres
cd /path/to/openclaw
pnpm install
pnpm build
```

(The plugin's directory name doesn't strictly matter — OpenClaw discovers it via `openclaw.plugin.json`. We rename to `memory-postgres` here so it slots into the existing `plugins.slots.memory` convention.)

### 3. Configure `~/.openclaw/openclaw.json`

```jsonc
{
  "plugins": {
    "slots": { "memory": "memory-postgres" },
    "entries": {
      "memory-postgres": {
        "enabled": true,
        "config": {
          "postgres": {
            "url": "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw"
          },
          "embedding": {
            "provider": "ollama",                 // "ollama" | "openai"
            "model": "qwen3-embedding:0.6b",      // any 1024+ dim model
            "baseUrl": "http://127.0.0.1:11434",
            "format": "openai",                   // wire format
            "path": "/v1/embeddings"
          },
          "dashboard": {
            "enabled": true,
            "host": "127.0.0.1",
            "port": 8765,
            "tokenEnv": "NEXTCLAW_DASH_TOKEN"
          },
          "transcriptWatchers": [{
            "id": "agent-main",
            "agentId": "main",
            "dir": "/home/<you>/.openclaw/agents/main/sessions"
          }]
        }
      }
    }
  }
}
```

Then restart your OpenClaw gateway. On first start, `migrate()` runs all DDL files in `src/storage/schema/*.sql` in lexical order; the embedding HNSW index is created lazily after the first embed call so the dimension can be pinned correctly.

### 4. Open the dashboard

```bash
export NEXTCLAW_DASH_TOKEN=$(openssl rand -hex 24)
# Restart OpenClaw, then:
open "http://127.0.0.1:8765/?token=$NEXTCLAW_DASH_TOKEN"
```

The token is captured into `sessionStorage` and forwarded as `X-Token` on subsequent fetches and SSE.

## Multi-agent (hard isolation) example

```jsonc
{
  "agents": {
    "list": [
      { "id": "main", "default": true, "workspace": "~/.openclaw/workspace" },
      { "id": "club", "workspace": "~/.openclaw/workspace-club" }
    ]
  },
  "bindings": [
    {
      "agentId": "club",
      "match": {
        "channel": "discord",
        "guildId": "<your-public-server-id>",
        "peer": { "kind": "channel", "id": "<your-public-channel-id>" }
      }
    }
  ],
  "plugins": {
    "entries": {
      "memory-postgres": {
        "config": {
          "transcriptWatchers": [
            { "id": "agent-main", "agentId": "main", "dir": "~/.openclaw/agents/main/sessions" },
            { "id": "agent-club", "agentId": "club", "dir": "~/.openclaw/agents/club/sessions" }
          ]
        }
      }
    }
  }
}
```

The `main` agent's chunks (e.g. private DM history) are **physically inaccessible** from the `club` agent's recall path — it's a SQL `WHERE` clause, not an app-layer filter.

## API endpoints (dashboard server)

All `/api/*` routes are token-gated when `dashboard.tokenEnv` is set.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/stats` | GET | 24h hourly rollup + ingest decision counts + recall tier counts + category distribution |
| `/api/recent` | GET | Latest 50 ingest + recall events (with redaction for health/medical excerpts) |
| `/api/stream` | GET (SSE) | Real-time `audit_events` from PG LISTEN/NOTIFY |
| `/api/ingest` | POST | Universal HTTP ingest gateway (skill / cron / external scripts can write memory) |
| `/api/recall` | POST | Read-only recall probe — useful for harnesses and external skills |
| `/api/bot-stats` | GET | OpenAI gpt-5.5 turn telemetry parsed from `<agent>/sessions/*.trajectory.jsonl` |
| `/api/model-compare` | GET | Side-by-side gpt-5.5 vs challenger (e.g. Qwen 3.6) latency / tokens / output |

## Universal ingest gateway

Anything that can `curl` can write to memory:

```bash
curl -sS -X POST http://127.0.0.1:8765/api/ingest \
  -H "Authorization: Bearer $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "Migrated the postgres pool size from 8 to 16 because evening peak hit ~85% utilization.",
    "source": "ops-cron",
    "agentId": "main",
    "anchors": { "cwd": "/srv/api", "pr": "1234" },
    "importance": 0.6
  }'
```

Skills, cron jobs, git hooks, GitHub Actions, monitoring agents — all of them get the same Stage 0-6 pipeline (trash filter, dedup, multi-key indexes, scoring, audit) without the calling agent having to think about it.

## Compatibility

- **OpenClaw** `>= 2026.4.25`
- **Node** `>= 22`
- **Postgres** `>= 16` (older versions work but pgvector + HNSW perf is best on 16+)
- **pgvector** `>= 0.7.0` (HNSW index)
- **Embedding model**: any OpenAI-compat or Ollama-compat endpoint. Tested with `qwen3-embedding` (4096-d) and `nomic-embed-text` (768-d). Dimension is detected on first embed and locked into the HNSW index.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project builds on the OpenClaw plugin SDK. OpenClaw is a separate project; see https://github.com/openclaw/openclaw.
