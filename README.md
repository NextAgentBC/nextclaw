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
- **Semantic Q&A cache** (`cache.qa`): repeat questions hit at sub-millisecond (L0 LRU) → ~5ms (L1 exact hash) → ~50ms (L2 HNSW). Skips the LLM entirely on repeat questions.
- **Telegram-group Moderator** (optional, off by default): orchestrator-worker pattern à la Anthropic's "Building Effective Agents". Routes group `@-mentions` to specialist workers with tools (`memory_search`, `web_search` via Tavily), persists role designs so the registry compounds over time.
- **Real-time dashboard** (bilingual CN/EN) with category breakdown, redaction for health/medical, bot-turn telemetry, side-by-side model comparison
- **Self-tuning loop** (daily / weekly / monthly proposals)
- **Universal HTTP ingest gateway** — any cron / skill / external script can write memory through the same Stage 0–6 pipeline

## Companion skills

Standalone OpenClaw skills that compose well with nextclaw:

- **[openclaw-skill-reminder](https://github.com/NextAgentBC/openclaw-skill-reminder)** — privacy-conscious time-based reminders. The cron config file only sees opaque `reminder:<short-id>` names; the actual detail (names, addresses, appointments) lives in a mode-600 file. Used by `/dashboard` users to schedule follow-ups without leaking PII into `jobs.json`.

## Quick start (Level A — memory only, ~20 min)

For the Telegram Moderator, web_search, and reflection upgrades, see the [INSTALL.md](docs/INSTALL.md) bolt-ons. **Read [SERVICES.md](docs/SERVICES.md) first** to know which external services each capability needs.

```bash
# 1. Install OpenClaw (the host runtime — required)
git clone https://github.com/openclaw/openclaw.git ~/openclaw
cd ~/openclaw && pnpm install && pnpm build

# 2. Bring up Postgres + pgvector (docker compose included)
git clone https://github.com/NextAgentBC/nextclaw.git ~/openclaw/extensions/memory-postgres
cd ~/openclaw/extensions/memory-postgres/dev && docker compose up -d

# 3. Get a free Jina embedding key — 30 seconds, no card, 1M tokens/key.
#    https://jina.ai/embeddings/  → click "Get API key for free" → copy
export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
echo 'export JINA_API_KEY=...' >> ~/.bashrc

# 4. Build the plugin
cd ~/openclaw && pnpm install && pnpm build

# 5. Configure ~/.openclaw/openclaw.json — minimum to boot:
cat > ~/.openclaw/openclaw.json <<'EOF'
{
  "plugins": {
    "slots": { "memory": "memory-postgres" },
    "entries": {
      "memory-postgres": {
        "enabled": true,
        "config": {
          "postgres": { "url": "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw" },
          "dashboard": { "enabled": true, "tokenEnv": "NEXTCLAW_DASH_TOKEN" }
        }
      }
    }
  }
}
EOF
# (embedding block is OPTIONAL — defaults to Jina free with JINA_API_KEY)

# 6. Start
export NEXTCLAW_DASH_TOKEN=$(openssl rand -hex 24)
pnpm openclaw gateway start

# 7. Smoke test — write then recall
curl -sS -X POST http://127.0.0.1:8765/api/ingest \
  -H "Authorization: Bearer $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"My favorite Postgres extension is pgvector.","source":"smoke","agentId":"main"}'

curl -sS -X POST http://127.0.0.1:8765/api/recall \
  -H "Authorization: Bearer $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my favorite Postgres extension?","agentId":"main"}'
# → returns the chunk with hitTier: "t2_hybrid"
```

For the **full 0 → 1 walkthrough** with persona files, troubleshooting, Discord/Telegram bots, web_search, and multi-agent isolation, see **[docs/INSTALL.md](docs/INSTALL.md)**.

### Installing nextclaw with help from an AI agent

The docs are explicitly written to be read by both humans and LLM agents. If you'd like an agent to install nextclaw for you:

1. Point the agent at **[docs/SERVICES.md](docs/SERVICES.md)** to enumerate which external services you'll need
2. The agent walks through dependencies in order — Postgres → embedding → (optional) LLM → (optional) Telegram → (optional) Tavily — using each section's signup link, env-var name, and verification curl
3. Final step: assemble the configured blocks into `openclaw.json` and run the smoke test in [INSTALL.md ⑦](docs/INSTALL.md#-start-then-verify-with-a-smoke-test)

The "For AI agents" section at the bottom of SERVICES.md spells out the recommended dialogue flow.

> **Want to self-host the embedder instead of Jina?** Run Ollama locally
> and set `"embedding": { "format": "ollama" }` — the rest of the
> embedding block fills itself in from per-format defaults. See
> [docs/CONFIG.md#embedding](docs/CONFIG.md#embedding).
>
> ⚠️ **Embedding dimension is one-way.** It's auto-detected on first ingest
> and locked into the HNSW index. Switching from `jina-embeddings-v3` (1024d)
> to `qwen3-embedding:4b` (4096d) requires `TRUNCATE semantic.chunks` and
> re-ingesting everything. Pick the model you can live with for a while.

## Documentation

| Doc | What it covers |
|---|---|
| **[docs/SERVICES.md](docs/SERVICES.md)** | **Read first.** Every external service (Postgres, Jina, Gemini, Tavily, Telegram, OpenAI, credbroker) — signup links, env vars, config snippets, verification curls. Written for both AI agents and humans. |
| **[docs/INSTALL.md](docs/INSTALL.md)** | Fresh-machine 0 → 1 walkthrough · Discord bot · Telegram Moderator · web_search · multi-agent isolation · troubleshooting. Four capability levels A → D you can ladder up through. |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Storage layout · 4-tier recall · 8-route hybrid · Stage 0–6 ingest · isolation guarantees · scoring · self-tuning · workers |
| **[docs/CONFIG.md](docs/CONFIG.md)** | Every config field, default, tuning advice |
| **[docs/LIVE_TESTS.md](docs/LIVE_TESTS.md)** | How to run live tests against a real PG + embedding endpoint |

## Compatibility

- **OpenClaw** `>= 2026.4.25`
- **Node** `>= 22`
- **Postgres** `>= 16` with **pgvector** `>= 0.7.0` (HNSW)
- **Embedding**: Jina (default, free tier), any OpenAI- or Ollama-compat endpoint. Tested with `jina-embeddings-v3` (1024d, default), `nomic-embed-text` (768d), `qwen3-embedding:0.6b` (1024d), `qwen3-embedding:4b` (4096d). Dimension is detected on first embed and **locked** into the HNSW index — switching models means re-ingesting.
- **Reflection LLM** (optional): any OpenAI-compat chat endpoint, or native Gemini API (e.g. via Google's free tier or a Tailscale credential broker). Disabled by default.

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

## Scope & limits

Be explicit about what this plugin is and isn't, so you can decide if it fits before installing:

### The **memory pipeline** (recall, ingest, dashboard, cache, isolation) is channel-agnostic
Works with any openclaw agent — DM, Discord, Slack, WhatsApp, etc. Ingest accepts text from any source via the HTTP gateway. **No coupling to a specific channel or bot account.**

### The **Moderator** (Phase C / D, opt-in) is **Telegram-group-only** today
When `moderator.enabled=true`, the plugin registers a `before_dispatch` hook that claims **group @-mentions on the `telegram` channel** — codex (or whatever other plugin would have replied) is suppressed for those messages; the Moderator replies out-of-band via the Telegram Bot API.

- **DMs are untouched** — codex handles them as before
- **Group messages without an @-mention are untouched** — codex doesn't reply to those anyway
- **Slack / Discord / WhatsApp `@-mentions` are NOT claimed** — only `channelId === "telegram"` matches today

If you want the Moderator on another channel, the suppression rule (`index.ts` → `before_dispatch` hook) and the Telegram-Bot-API reply path (`src/moderator/telegram-api.ts`) both need adaptation. Issue/PR welcome.

### Single-tenant by default; explicitly multi-tenant
Every row this plugin writes carries an `agent_id` column. The Moderator uses `cfg.moderator.agentId` (default `"main"`). To run two openclaw instances against the same Postgres without collision, give each install a distinct `agentId`:

```jsonc
"moderator": { "enabled": true, "agentId": "tutor-bot" }
```

`worker_roles`, `moderator.state`, `moderator.decisions`, and `cache.qa` rows are all namespaced — the agents can't see each other's state.

### `web_search` tool requires a Tavily endpoint
Either `credbroker.baseUrl` (Tailscale credential broker that proxies Tavily — see [docs/CONFIG.md](docs/CONFIG.md)) or `TAVILY_API_KEY` in env. **Without one, `web_search` returns an honest error** to the LLM (which then explains the limitation to the user). No silent failures.

### LLM transport
- Moderator decision LLM: **OpenAI-compatible** or **Gemini `:generateContent`** (with tool calls). OpenAI tool-call format is single-shot only today; multi-turn tool calls require Gemini.
- Embedding: **Jina, OpenAI-compat, or Ollama**. Default is Jina free tier.

## Status

`v0.2.x` — memory pipeline + dashboard stable; Moderator + worker-tools layer (Phase C/D) live-tested but newer. Live tests pass against the reference setup. Concurrency simulation covers 8 scenarios (cache stampede, cross-scope parallelism, viewer isolation, mixed load, worker round-trip, role auto-register, tool calls, web_search). See [CHANGELOG.md](CHANGELOG.md).

## License

[Apache 2.0](LICENSE) · [NOTICE](NOTICE) acknowledges OpenClaw upstream.
