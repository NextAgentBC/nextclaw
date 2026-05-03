# Changelog

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
