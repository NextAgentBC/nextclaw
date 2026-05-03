# nextclaw

> Postgres + pgvector long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw).
> 4-tier recall · multi-key Xinhua-dictionary indexing · deterministic-first ingest · hard per-agent isolation · real-time dashboard.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: 0.1.0](https://img.shields.io/badge/status-0.1.0-orange)

```
   ┌────────────────────────────────────────────────────────────┐
   │  OpenClaw agent (DM, Discord, Slack, WhatsApp, ...)         │
   └─────────────┬──────────────────────────┬───────────────────┘
                 │ memory_search             │ memory_store
                 ▼                           ▼
   ┌────────────────────────────────────────────────────────────┐
   │ nextclaw                                                   │
   │                                                            │
   │  Recall tier-walk:  T0 → T1 → T2 → T3                      │
   │  Ingest pipeline:   Stage 0 → 1 → 2 → 3 → 4 → 5 → 6        │
   │  8-route hybrid:    semantic / fulltext / trgm /           │
   │                     concept_tag / entity_ref /             │
   │                     time_bucket / anchor / category        │
   │                                                            │
   │  Per-agent isolation:  WHERE c.agent_id = $X (every route) │
   └─────────────┬──────────────────────────┬───────────────────┘
                 │                          │
                 ▼                          ▼
   ┌─────────────────────┐       ┌───────────────────────────┐
   │  Postgres + pgvector│       │  Embedding endpoint        │
   │  semantic + struct  │       │  (Ollama / OpenAI-compat / │
   │  + audit + cache    │       │   vLLM / TEI / ...)        │
   │  + cold + LISTEN/   │       │                            │
   │  NOTIFY → dashboard │       │                            │
   └─────────────────────┘       └───────────────────────────┘
```

---

## What it does

- **Drop-in replacement** for OpenClaw's bundled SQLite memory plugin (`memory-core`)
- **4-tier recall** so 75%+ of repeat queries return in <5ms with **0 LLM tokens** and **0 embedding calls**
- **Multi-key indexing** ("Xinhua dictionary"): every chunk reachable from many orthogonal angles — semantic / fulltext / trigram / concept tags / entity refs / time buckets / anchors / categories
- **Deterministic-first ingest**: no LLM in the hot path; LLM exists only as a residual stage when deterministic extraction yields nothing
- **Hard per-agent memory namespace isolation**: run a private agent and a public Discord agent on the same database — they physically can't see each other's memory (SQL-layer enforcement, not application-layer)
- **Real-time dashboard** (bilingual CN/EN) with category breakdown, redaction for health/medical, bot-turn telemetry, side-by-side model comparison
- **Self-tuning loop** (daily / weekly / monthly proposals)
- **Universal HTTP ingest gateway** — any cron / skill / external script can write memory through the same Stage 0–6 pipeline

## Quick start

```bash
# 1. Install OpenClaw
git clone https://github.com/openclaw/openclaw.git ~/openclaw
cd ~/openclaw && pnpm install && pnpm build

# 2. Bring up Postgres + pgvector
git clone https://github.com/NextAgentBC/nextclaw.git ~/openclaw/extensions/memory-postgres
cd ~/openclaw/extensions/memory-postgres/dev
docker compose up -d

# 3. Bring up an embedding endpoint (one option among many)
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull nomic-embed-text

# 4. Build the plugin
cd ~/openclaw && pnpm install && pnpm build

# 5. Configure ~/.openclaw/openclaw.json (see docs/INSTALL.md ⑤)
# 6. Generate dashboard token and start
export NEXTCLAW_DASH_TOKEN=$(openssl rand -hex 24)
pnpm openclaw gateway start

# 7. Smoke test
curl -sS -X POST http://127.0.0.1:8765/api/ingest \
  -H "Authorization: Bearer $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"My favorite Postgres extension is pgvector.","source":"smoke","agentId":"main"}'
```

For the **0 → 1 walkthrough** with troubleshooting, persona files, and
a Discord bot setup, see **[docs/INSTALL.md](docs/INSTALL.md)**.

## Documentation

| Doc | What it covers |
|---|---|
| **[docs/INSTALL.md](docs/INSTALL.md)** | Fresh-machine 0 → 1 walkthrough · Discord bot · multi-agent isolation · troubleshooting |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Storage layout · 4-tier recall · 8-route hybrid · Stage 0–6 ingest · isolation guarantees · scoring · self-tuning · workers |
| **[docs/CONFIG.md](docs/CONFIG.md)** | Every config field, default, tuning advice |
| **[docs/LIVE_TESTS.md](docs/LIVE_TESTS.md)** | How to run live tests against a real PG + embedding endpoint |

## Compatibility

- **OpenClaw** `>= 2026.4.25`
- **Node** `>= 22`
- **Postgres** `>= 16` with **pgvector** `>= 0.7.0` (HNSW)
- **Embedding**: any OpenAI- or Ollama-compat endpoint. Tested with `nomic-embed-text` (768d), `qwen3-embedding:0.6b` (1024d), `qwen3-embedding:4b` (4096d). Dimension is detected on first embed and locked into the HNSW index.

## Performance reference

Numbers from a single-machine deployment, ~280 chunks, single Discord conversation flow:

| Operation | Path | LLM tokens | Embed calls | Latency |
|---|---|---|---|---|
| Recall — repeated query within 5min | T1 | 0 | 0 | ~ 1 ms |
| Recall — anchor (e.g. PR # in query) | T2 anchor | 0 | 0 | ~ 8 ms |
| Recall — generic question | T2 hybrid | 0 | 1 | ~ 250 ms |
| Ingest — short text (<200 char), warm embed | deterministic | 0 | 0 (cache hit) | ~ 50 ms |
| Ingest — long text (~2000 char) | deterministic | 0 | 1 | ~ 600 ms |

In a typical workload, ingest spends **0 LLM tokens** end-to-end. Recall LLM tokens are 0 except when the optional intent classifier is enabled.

## Privacy by default

- `health` and `medical` chunks auto-pinned (`importance ≥ 0.7`, `retention_class='pinned'`) at ingest time, deterministically — based on a CN+EN keyword dictionary, not LLM judgment
- Their `text_excerpt` is redacted in the dashboard's `/api/recent` response
- Per-agent isolation means a public-facing agent **cannot** retrieve them even via adversarial prompting

## Status

`v0.1.0` — initial public release. Core architecture is settled; APIs may evolve in `0.x` based on feedback. Live tests pass against the reference setup. See [CHANGELOG.md](CHANGELOG.md).

## License

[Apache 2.0](LICENSE) · [NOTICE](NOTICE) acknowledges OpenClaw upstream.
