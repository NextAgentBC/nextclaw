# Changelog

## 0.2.1 — Curl-first install + distribution fixes

0.2.1 is a packaging / install-UX release. No new runtime features — the focus
is letting a non-developer install the plugin against a curl-installed OpenClaw
in under 10 minutes, on a machine with neither pnpm nor a source checkout.

### Distributable via `openclaw plugins install git:` / `npm:`

- `package.json` `openclaw.extensions` now points at `./dist/index.js`. The
  previous `./index.ts` value only worked for local-development checkouts —
  OpenClaw's plugin installer requires a compiled entry for any non-`--link`
  install source. Verified live: `openclaw plugins install
  git:github.com/NextAgentBC/nextclaw` against a curl-installed OpenClaw now
  succeeds end-to-end, registers `memory-postgres` as an enabled plugin, and
  surfaces the dashboard at `127.0.0.1:8765` after `openclaw gateway restart`.
- `dist/` (752 KB, 75 files) is now tracked in git. OpenClaw's installer runs
  `npm install --omit=dev --omit=peer`, which strips the typescript compiler,
  so any `prepare`-time rebuild is impossible during a normal install. The
  in-tree dist is the source of truth. Contributors must `npm run build` and
  `git add dist/` before merging source changes — a comment at the top of
  `.gitignore` calls this out.
- New `scripts/prepare-build.mjs`. Invoked from the `prepare` script. When
  typescript is resolvable (regular dev checkouts) it rebuilds; otherwise it
  cleanly skips and prints a one-line note. Either way the install succeeds
  with a usable `dist/`.
- `openclaw.plugin.json` had two `"activation"` keys at the top of the
  manifest. The second one shadowed the first, forcing `onStartup: false`.
  Now deduped → plugin activates on gateway startup as intended.

### Documentation rewritten around curl-installed OpenClaw

- `README.md` Quick Start replaced. Old flow was clone OpenClaw → `pnpm
  install && pnpm build` → drop nextclaw into `extensions/` → `pnpm openclaw
  gateway start`. New flow is:
  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash
  openclaw onboard --install-daemon
  # ... pick Postgres (Neon or Docker)
  openclaw plugins install git:github.com/NextAgentBC/nextclaw
  curl -fsSL .../scripts/configure-minimal.mjs | PG_URL=... node --input-type=module
  openclaw gateway restart
  ```
- Postgres step now offers **Neon (zero local deps, free tier)** as Option A
  alongside a single-`docker run` Option B. Neither requires cloning this repo
  to get a `docker-compose.yml`.
- New helper `scripts/configure-minimal.mjs`. Pipes through `curl | node`. Reads
  the existing `~/.openclaw/openclaw.json` (created by `openclaw onboard`),
  injects only `plugins.slots.memory` and `plugins.entries["memory-postgres"]`,
  writes back. Round-trip tested against a real onboard-produced config: every
  non-`plugins` key (gateway, agents, auth, channels, …) is byte-identical
  before/after. Masks the Postgres password in its stdout output.
- New "Other install methods" section in README enumerates git / npm /
  ClawHub / local-dev install sources. Notes that the bare `nextclaw` npm
  name is taken by an unrelated CLI, so any future npm publish will be
  scoped (e.g. `@nextagentbc/nextclaw`).
- `docs/INSTALL.md` steps ①②④⑤⑦ rewritten to match. Discord, multi-agent
  isolation, reflection, Telegram Moderator, and web_search bolt-on sections
  preserved verbatim.
- `docs/SERVICES.md` §1 (Postgres) gains the Neon / Docker side-by-side; §7
  (OpenClaw) drops the source-checkout + pnpm instructions.

### Documentation bug fixes surfaced by end-to-end dogfood

Two long-standing doc bugs only became visible after dogfooding the new flow
end-to-end on a clean machine.

- **Dashboard auth header.** The HTTP dashboard validates requests via the
  `X-Token` header (or `?token=` query param). Pre-0.2.1 README/INSTALL
  examples used `Authorization: Bearer $TOKEN`, which the dashboard treats
  as no token at all and returns 401. All `curl` examples (`/api/ingest`,
  `/api/recall`, `/api/reflection/run-now`) switched to `X-Token`. The
  dashboard JS itself was already using `X-Token` after capturing `?token=`
  into `sessionStorage`, so this was a docs-only fix.
- **Daemon env path.** `openclaw onboard --install-daemon` runs the gateway
  via launchd on macOS and systemd-user on Linux. Neither reads `~/.zshrc`
  or `~/.bashrc`. The daemon sources `~/.openclaw/service-env/ai.openclaw.gateway.env`
  on every start. Pre-0.2.1 docs told users to `echo "export
  NEXTCLAW_DASH_TOKEN=…" >> ~/.zshrc`, which left the daemon with an empty
  token (dashboard rejected every request) and no `JINA_API_KEY` (embedding
  client got `AUTH_MISSING_API_KEY` from Jina). README step 3 and step 6 +
  INSTALL.md step ⑦ now write to the service-env file and keep the
  shell-rc append only for the smoke-test curls.

### Validated end-to-end on a clean machine

Full dogfood ran on macOS with no pnpm, no docker, no Node project. Steps
executed exactly as the new docs ship them: `brew install colima docker` →
`colima start` → single `docker run pgvector/pgvector:pg16` + three
`CREATE EXTENSION` → `openclaw plugins install git:…` → `configure-minimal.mjs` →
`openclaw gateway restart`. The smoke test then exercises all four recall
behaviours:

- Lexical hit on a keyword-overlapping query → `hitTier=t1, embedCalls=0, latencyMs=2`
- Semantically equivalent English query with no lexical overlap → `hitTier=t2_hybrid, embedCalls=1, latencyMs=379`
- Chinese cross-language query → `hitTier=t2_hybrid, embedCalls=1, latencyMs=440, score=1.78`
- Repeat of any prior query → `t1 cache, zeroCostHit=true, latencyMs=2`

All four match what the README advertises.

---

## 0.2.0 — Jina-default + active memory

The 0.1.0 release was passive: chunks went in, chunks came out via 8
deterministic routes. 0.2.0 adds three shifts borrowed from post-RAG
agent-memory work (MemGPT/Letta core memory, Karpathy "agent's wiki",
GraphRAG) plus a frictionless first-run path:

### Embedding default → Jina free tier

- `format=jina` is now the default. `jina-embeddings-v3` over
  `https://api.jina.ai` with `JINA_API_KEY` env. 1M tokens / no card.
  Asymmetric retrieval: ingest sends `task=retrieval.passage`, recall
  sends `task=retrieval.query`.
- Per-format defaults: `format=ollama` fills in `127.0.0.1:11434` +
  `qwen3-embedding:4b`; `format=openai` fills in `api.openai.com` +
  `text-embedding-3-small` + `OPENAI_API_KEY`. Pick a format, get a
  working setup.
- `embedding` block is now optional at the manifest level. Minimal
  config is just `postgres.url`.

### New recall route — `graph_walk` (GraphRAG-style 1-hop)

- 9th parallel route. Seeds from `ctx.entityIds` (explicit) and
  auto-resolves seeds from concept-tag matches against
  `structured.entities` (canonical name + aliases + pg_trgm fuzzy).
- Walks one hop over `structured.relations`, then joins back to chunks
  via `chunk_indexes(kind='entity_ref')`. Score combines distinct
  neighbor count × average relation confidence.
- Weight: 0.9 (below `entity_ref` direct mention at 1.0, above
  `concept_tag` substring at 0.8).

### Agent-active memory editing — `memory_update` / `memory_forget`

- Two new tools the agent can call to **curate** its own memory.
  `memory_update(chunkId, ...)` rewrites text (re-embeds), shifts
  importance, or flips retention class. `memory_forget(chunkId, ...)`
  soft-trashes (default) or hard-tombstones.
- Both enforce per-agent isolation at the SQL layer: an `agent:club`
  call hitting `agent:main`'s chunkId fails with `wrong-agent`.
- Edits invalidate `cache.recall` and clear `cache.hot_chunks` so the
  agent's own changes are reflected in the next recall.
- `audit.ingest_decisions` gains `chunk_id`, `reason`, `agent_session_id`
  columns (migration `27-edit-audit.sql`) so the dashboard can show edit
  lineage alongside ingest.

### Profile chunks (MemGPT core memory) — primed into T0 on first recall

- New chunk convention: `kind='profile'`, `retention_class='pinned'`.
  Per-agent (and per-entity if you want) curated facts that always
  live in the T0 working set instead of competing for top-k slots.
- First recall in a session calls `primeWorkingSetWithProfiles` which
  loads all `kind='profile'` chunks for `agent_id` into the working
  set. Idempotent via a `profilesPrimed` flag on `WorkingSet`.
- Profile chunks are normally written by the reflection worker; the
  agent can also pin manually via `memory_update`.

### Reflection worker — daily LLM consolidation

- New optional worker. Runs on `cfg.reflection.intervalMs` (default 24h,
  min 1h). Per agent, pulls last `lookbackHours` of conversation chunks
  (cap `maxInputChars`), asks an LLM to emit a 2–4 sentence
  REFLECTION + a list of PROFILE_DELTA bullets.
- Writes the reflection as `kind='reflection'` (standard retention),
  bullets as `kind='profile'` (pinned). Both available on next recall.
- **Two LLM transports**: `model.format=openai` for any
  `/v1/chat/completions` endpoint, or `model.format=gemini` for
  Google's native `/v1beta/models/<m>:generateContent`. The Gemini path
  works directly against `generativelanguage.googleapis.com` (with
  `apiKeyEnv` → `?key=`), and also against a Tailscale credential
  broker proxy that injects the key server-side (no caller key).
- Off by default. Opt in with `reflection.enabled: true` + a `model`
  block.

### Temporal query routing — bilingual

- New `src/recall/temporal.ts` parses `今天 / 昨天 / 前天 / N 天前 /
  this week / last week / this month / last month / yesterday / today /
  YYYY-MM-DD / 2026年5月10日` from query text and emits a list of
  `YYYY-MM-DD` bucket strings.
- `routeTimeBucket` now takes both `ctx.timeBucket` (single, explicit)
  and `ctx.timeBuckets` (range, inferred); unions and scores by
  distinct-bucket hit count.

### Low-risk hardening from 0.1.x review

- `ensureHnswIndex` failures no longer get swallowed in `index.ts`,
  `manager-runtime.ts`, or `src/tools.ts`. Logs a `warn` with the
  underlying error so a silently-degraded T2 (HNSW failed →
  seq scan) is visible.
- `agentIdFromSessionKey` is now fail-closed: unknown sessionKey
  shapes throw instead of silently bucketing into `main`. Empty /
  undefined still resolves to `main` (manual scripts, doctor probes).
- New tests cover Jina format passage/query body parameter, embedded
  defaults fall-through, agentId fail-closed parser, and the temporal
  inferrer's 12 cases.

### Migrations

- `src/storage/schema/27-edit-audit.sql` — adds `chunk_id`, `reason`,
  `agent_session_id`, `scored_at` columns to `audit.ingest_decisions`;
  loosens `text_hash` / `text_excerpt` to nullable so edit-lineage
  rows don't need to repeat the chunk text.

### Breaking-ish

- If you were relying on `embedding.provider` + `embedding.model`
  being required at the manifest level, those constraints are gone.
  Existing configs that include them keep working unchanged.
- `agentIdFromSessionKey` (used by `memory_search` / `memory_store`)
  no longer falls back to `main` for unrecognised session-key shapes.
  If you're injecting custom session keys, ensure they start with
  `agent:<agentId>:`.

## 0.1.0 — initial public release

First open release. Built and validated against OpenClaw `>=2026.4.25`.

### Architecture

- Postgres + pgvector backend, 5 schemas: `semantic`, `structured`, `audit`, `cache`, `cold`
- 4-tier recall: T0 in-process working set / T1 PG UNLOGGED hot cache / T2 main store / T3 cold gist
- Multi-key indexing (Xinhua-dictionary mode): every chunk indexed on concept tags, entity refs, anchors (cwd / branch / PR / file / session), time buckets, metric / preference keys, and 6+1 taxonomy categories (health / medical / tech / life / work / finance / other)
- 8 parallel recall routes: semantic / fulltext / trgm / concept_tag / entity_ref / time_bucket / anchor / category
- MMR rerank for diversity at the merge step

### Ingest pipeline (Stages 0-6)

- Stage 0 deterministic extractors (entities / events / metrics / preferences / relations + concept tags + categories)
- Stage 1 trash filter with bilingual CN/EN boilerplate regex
- Stage 2 sidecar JSON parsing with auto-disable on consecutive bad JSON
- Stage 3 embedding cache (PG UNLOGGED)
- Stage 4 LLM residual (only when Stage 0/2 produced nothing)
- Stage 5 multi-key index writes (parallel INSERTs)
- Stage 6 reconcile + provenance + audit + scoring

### Recall

- Query-side anchor inference (PR/issue refs, file paths)
- Query-side concept-tag inference (camelCase / hyphenated / CJK noun phrases)
- Query-side category inference (deterministic 6+1 taxonomy)
- cache.recall (5-min TTL) + cache.intent (1h TTL)
- Working-set keyed by `<agent_id>::<session_id>` for in-process T0

### Hard per-agent memory namespace isolation

- `agent_id` column on chunks + audit + cold tables
- All 8 recall routes filter `WHERE c.agent_id = $X`
- T0 working set + cache.recall scope_key both incorporate agent_id
- Tools parse agent id from session key; transcript-watcher carries `agentId` per watcher

### Operations

- Scoring: ingest_score (token / latency / quality / path) and recall_score (token / latency / tier / relevance), both 0-100
- Self-tuning loop: daily / weekly / monthly proposals to `audit.tuning_proposals` (auto-apply only on `safe_auto`)
- Compactor: 90-day rolling cluster → cold gist
- Spreading activator: Hebbian neighbor warmth bump

### Workers

- `transcript-watcher`: tails `<agent>/sessions/*.jsonl` and ingests every conversation turn deterministically
- `git-watcher`: polls a local repo and ingests new commits since last sha
- `shadow-comparator`: replays each turn against a challenger chat endpoint (e.g. Qwen 3.6) for side-by-side latency / token / quality comparison
- `compactor`: cold gist consolidation
- `spreading-activator`: Hebbian neighbor warmth
- `tuning`: proposal analyzer

### Dashboard

- Local HTTP server (default `127.0.0.1:8765`), token-gated for `/api/*`
- Real-time event stream via PG `LISTEN audit_events`
- Bilingual (CN/EN) UI with category breakdown, redaction of health/medical excerpts, bot turn telemetry, model comparison panel
- Endpoints: `/api/stats`, `/api/recent`, `/api/stream`, `/api/ingest`, `/api/recall`, `/api/bot-stats`, `/api/model-compare`

### Privacy

- `health` and `medical` chunks auto-pinned with importance ≥ 0.7
- `text_excerpt` redacted in `/api/recent` for sensitive categories

### Testing

- Categorizer unit tests: 13/13
- Memory regression suite: 36/36 (Xinhua-dictionary multi-angle hit, trash filter, tier-walk cascade, multi-key derivation, reconcile, edge cases, route comparison, score distribution)
- Hard isolation probe: 6/6 adversarial queries from a secondary agent recovered 0 chunks from the primary namespace
