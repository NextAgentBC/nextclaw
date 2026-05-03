# nextclaw 0.1.0 — initial public release

> Postgres + pgvector long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw).
> 4-tier recall · multi-key Xinhua-dictionary indexing · deterministic-first ingest · hard per-agent isolation · real-time dashboard.

## Highlights

- **4-tier recall** (T0 in-process / T1 PG UNLOGGED / T2 main / T3 cold gist) — most queries return in <5ms with 0 LLM tokens
- **8 parallel routes** (semantic / fulltext / trgm / concept_tag / entity_ref / time_bucket / anchor / category) merged via MMR — Xinhua-dictionary mode, every chunk reachable from many angles
- **Deterministic-first ingest** (Stages 0–6) — LLM only enters as a residual when prior stages produce nothing; in a typical workload, **0 LLM tokens spent on ingest**
- **Hard per-agent memory isolation** — `agent_id` column threaded through every recall route, T0 working set, and cache scope. Validated with 6 adversarial probes: 0 chunks leaked
- **Self-tuning loop** — daily / weekly / monthly proposals into `audit.tuning_proposals`; auto-apply only on `safe_auto`
- **Real-time dashboard** — bilingual (CN/EN) panels for ingest decisions, recall tier hits, category distribution, bot turn latency, model comparison, with health/medical excerpts auto-redacted
- **Privacy by default** — `health` and `medical` chunks auto-pinned (importance ≥ 0.7) and redacted in the dashboard

## Workers shipped

- `transcript-watcher` — ingests every conversation turn deterministically, no agent involvement required
- `git-watcher` — polls a local repo and ingests new commits since `last_sha`
- `shadow-comparator` — replays each turn against a challenger chat endpoint (e.g. Qwen 3.6) for side-by-side latency / token / output comparison
- `compactor` — 90-day rolling cold-gist consolidation
- `spreading-activator` — Hebbian neighbor warmth bump on recall
- `tuning` — scheduled proposal analyzer (cron-style)

## API endpoints

`/api/stats` · `/api/recent` · `/api/stream` (SSE) · `/api/ingest` · `/api/recall` · `/api/bot-stats` · `/api/model-compare`

## Install

```bash
cd dev/ && docker compose up -d        # Postgres + pgvector on 127.0.0.1:55432
cd /path/to/openclaw/extensions
git clone https://github.com/NextAgentBC/nextclaw.git memory-postgres
cd /path/to/openclaw && pnpm install && pnpm build
```

Then point `plugins.slots.memory` at `memory-postgres` in your `~/.openclaw/openclaw.json`. See [README](https://github.com/NextAgentBC/nextclaw#readme) for the full config example, multi-agent setup, and dashboard token flow.

## Compatibility

- OpenClaw `>= 2026.4.25`
- Node `>= 22`
- Postgres `>= 16` with pgvector `>= 0.7.0`
- Embedding: any OpenAI- or Ollama-compat endpoint (Qwen3-embedding 4096-d and nomic-embed-text 768-d both tested)

## License

[Apache 2.0](https://github.com/NextAgentBC/nextclaw/blob/main/LICENSE) · acknowledges OpenClaw upstream in [NOTICE](https://github.com/NextAgentBC/nextclaw/blob/main/NOTICE)
