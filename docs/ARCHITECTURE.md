# nextclaw architecture

> Why a Postgres-backed memory plugin looks the way it does, and how the
> pieces fit together.

---

## Storage layout

Postgres 16 + pgvector + pg_trgm + btree_gin. Five schemas:

```
semantic.*      — chunks (text, embedding, warmth, retention) + chunk_indexes
                  (kind, value pairs for the multi-key router)
structured.*    — entities, relations, events, preferences, metrics, provenance
audit.*         — ingest_decisions, recall_decisions, model_comparisons,
                  tuning_proposals, plugin_meta, schema_migrations
cache.*         — UNLOGGED hot tables: hot_chunks, embeddings, intent,
                  recall, entity_alias
cold.*          — gists (compacted summaries with source_chunk_ids)
```

All DDL lives in `src/storage/schema/*.sql`, applied lexically by the
migration runner on plugin start. New schema goes in a new file with the
next number prefix (e.g. `27-foo.sql`).

The `agent_id` column on `semantic.chunks` is the **memory namespace
boundary**. All recall routes filter `WHERE c.agent_id = $X`; all
ingests tag with the writer's agent id. This is enforced at the SQL
layer, not at the application layer.

---

## 4-tier recall

A query walks tiers cheapest → most expensive, returning at the first
useful hit. The tier label written to `audit.recall_decisions.hit_tier`
tells you exactly where each query landed.

| Tier | Storage | Latency | LLM | Embed | Fires when |
|---|---|---|---|---|---|
| **T0** | In-process LRU per `(agent_id, session_id)` | < 0.1 ms | 0 | 0 | Recently-touched chunks in the live session |
| **T1** | `cache.recall` (UNLOGGED), keyed on query+scope hash | ~ 1 ms | 0 | 0 | Same query repeats within 5 minutes |
| **T2 anchor** | `chunk_indexes (kind=anchor_*)` JOIN chunks | ~ 5–15 ms | 0 | 0 | Caller passed (or query implied) `pr` / `file` / `branch` |
| **T2 hybrid** | All 8 routes in parallel + MMR rerank | ~ 200–300 ms | 0 | 1 | Generic queries with no high-precision anchor |
| **T3** | `cold.gists` HNSW + drill-down to source chunks | ~ 200 ms | varies | 1 | T2 returned nothing useful; query is historical |

T0 and T1 cover the vast majority of repeat queries (~75%) in real
usage. The expensive T2 hybrid path runs only when the question is
genuinely new.

### Promotion / demotion

- T2 hit → chunk is promoted to T1 (`cache.hot_chunks` with TTL 7d) and
  T0 (in-process registry, capped at `tiers.t0SizeLimit`)
- T1 hit → already hot; just touch `last_recalled_at` and bump warmth
- Spreading-activator worker fires async on every T2 hit: neighbor
  chunks (sharing entity / concept_tag / time bucket) get a warmth bump
  so adjacent recalls are faster
- 90 days without recall + non-pinned + low importance → candidate for
  cold gist consolidation (compactor worker)

---

## 8-route Xinhua-dictionary recall

The "Xinhua dictionary" idea: any character should be reachable from
many orthogonal paths (pinyin / radical / stroke / corner code). Apply
the same to chunks. Every chunk is indexed on **every** signal we can
derive deterministically:

| Route | What it matches | Index |
|---|---|---|
| `semantic` | Vector cosine | HNSW on `embedding` |
| `fulltext` | Tokenized text match | GIN on `to_tsvector('simple', text)` |
| `trgm` | Trigram similarity (typos, fuzzy CJK) | GIST `text gist_trgm_ops` |
| `concept_tag` | Hyphenated / camelCase / CJK 2–6 char nouns | `chunk_indexes(kind='concept_tag')` |
| `entity_ref` | Resolved entities from `structured.entities` | `chunk_indexes(kind='entity_ref')` |
| `time_bucket` | Date bucket `YYYY-MM-DD` | `chunk_indexes(kind='time_bucket')` |
| `anchor` | cwd / branch / pr / file / session | `chunk_indexes(kind='anchor_*')` |
| `category` | health/medical/tech/life/work/finance/other | `chunk_indexes(kind='category')` |

All eight run in parallel (`Promise.all`) on a T2 hybrid query. Results
merge with weighted normalization, then MMR rerank for diversity.
Multi-route hits compound: a chunk that matches semantic + concept_tag
+ time_bucket beats a chunk that only matches one route weakly.

The router infers anchors and concept tags from the query string itself
(deterministic regex), so the caller doesn't need to pre-extract.

---

## Stage 0–6 ingest pipeline

```
text in
   ↓
[Stage 1] trash filter — bilingual CN/EN boilerplate, length, noise regex
   ↓ pass
[Stage 0] deterministic extractors:
            - entities (regex + alias dictionary)
            - events (time + verb + actor)
            - metrics (number + unit)
            - preferences (rule-shaped)
            - relations (subj-pred-obj)
            - concept tags (camelCase split + CJK noun phrases)
            - categories (CN+EN keyword dictionary, multi-label)
[Stage 2] sidecar JSON parse (when present, with auto-disable on N consecutive bad JSON)
   ↓ merge
[Stage 3] embedding cache — text_hash lookup
   ↓ if cache miss
[Stage 4] LLM residual — only when Stage 0+2 produced nothing AND a
            residual hook is configured. Default: skip.
   ↓
[Stage 5] write semantic.chunks + parallel multi-key index INSERTs
[Stage 6] reconcile structured rows + provenance + audit + scoring
```

In normal operation, **0 LLM tokens are spent on ingest**. The
deterministic stages handle the bulk; the LLM residual exists for cases
where automated extraction yields nothing but the content is still
worth ingesting.

### Privacy policy at ingest

Categories `health` and `medical` automatically:
- elevate `retention_class` to `pinned` (never decay)
- raise `importance` to ≥ 0.7
- get redacted in the dashboard's `/api/recent` excerpt

This is deterministic — a regex match on `(医院|hospital|...)` triggers
the policy. It is **not** dependent on an LLM agreeing the content is
sensitive.

---

## Per-agent isolation guarantee

Multiple agent personas can share the same Postgres instance without
sharing memory. The boundary is enforced at four layers:

1. **Database row-level** — `semantic.chunks.agent_id`; every recall
   route's SQL has `WHERE c.agent_id = $X`
2. **In-process working set (T0)** — registry keyed by
   `<agent_id>::<session_id>`
3. **Cache scope key (T1)** — `cache.recall.scope_key` includes
   `agent:<id>` prefix
4. **Tools** — `memory_search` / `memory_store` parse the agent id from
   the calling session key and pass through

Tested with adversarial probes: a secondary agent issuing 6 queries
designed to surface the primary agent's chunks recovers **0**.

---

## Scoring

Every ingest and every recall writes a 0–100 composite score to
`audit.*.score`. Lets the dashboard show "memory operations are
healthy" or "we're spending too much on recall".

### Ingest score

```
ingest_score = 100 × (
    w_tok  × token_efficiency        ; default 0.30, ceiling 1000 tokens
  + w_lat  × latency_efficiency      ; default 0.20, ceiling 500 ms
  + w_qual × quality_signal          ; default 0.30
  + w_path × ingest_path_efficiency  ; default 0.20
)
```

`quality_signal` reflects extractor confidence; `ingest_path_efficiency`
prefers cheap paths (deterministic / cache > LLM residual).

### Recall score

```
recall_score = 100 × (
    w_tok  × token_efficiency
  + w_lat  × latency_efficiency      ; ceiling 200 ms
  + w_tier × tier_efficiency         ; T0=1.00, T1=0.90, T2_anchor=0.75, T2_hybrid=0.55, T3=0.20
  + w_rel  × relevance_estimate      ; async-filled from follow-up signals
)
```

Default weights are configurable in `scoring.{ingest,recall}.weights`.

---

## Self-tuning loop

Three cadences, all read `audit.*` SQL views, write proposals to
`audit.tuning_proposals`:

| Cadence | Cost | Auto-apply | Examples |
|---|---|---|---|
| Daily (cron 04:00) | 0 LLM, pure SQL | `safe_auto` proposals only | dead trash regex pruning, frequent-reject pattern promotion, cache TTL adjustment |
| Weekly | 0 LLM, A/B replay | `pending` (review required) | salience threshold calibration, tier capacity changes |
| Monthly | optional LLM | `pending`, `high_risk` | new structured types emerging, embedding model refresh proposal |

Auto-applied changes write a rollback row; a 24h post-application
monitor reverts on > 20% deviation in key metrics.

---

## Real-time observability

PG triggers fire on every audit row insert:

```sql
CREATE TRIGGER ingest_decisions_notify AFTER INSERT ON audit.ingest_decisions
  FOR EACH ROW EXECUTE FUNCTION audit.notify_event();
```

The dashboard's HTTP server holds a `LISTEN audit_events` connection
and re-broadcasts to any SSE clients. Sub-second tail of every memory
operation.

---

## Workers

| Worker | Purpose | Trigger |
|---|---|---|
| `transcript-watcher` | Tails `<agent>/sessions/*.jsonl` and ingests every conversation turn | Polls every 10s; per-file byte offset persisted in `audit.plugin_meta` |
| `git-watcher` | Polls a local repo and ingests new commits since `last_sha` | Polls every 1h; `last_sha` persisted |
| `shadow-comparator` | Replays each turn against a challenger chat endpoint | Polls trajectory file every 30s |
| `compactor` | 90-day rolling cold-gist consolidation | Runs in the dreaming cycle |
| `spreading-activator` | Hebbian neighbor warmth bump | Fires async on every T2 recall |
| `tuning` | Scheduled proposal analyzer | Cron-style (daily / weekly / monthly) |
| `dashboard` | HTTP + SSE | Long-running |

All workers respect graceful shutdown via the plugin's `stop()` hook.

---

## What's intentionally NOT here

- **No reranker model**. MMR + multi-route compounding gets us to good
  precision without a separate cross-encoder. Add one if your domain
  needs it.
- **No graph traversal language**. Relations are stored, but recall
  doesn't walk them. The architecture is set up so this can be added
  as a 9th route, but it's not on the v0.1 path.
- **No Redis**. cache.* tables use PG UNLOGGED. If you instrument and
  see cache contention, swap the `CacheBackend` impl; the abstraction
  is already in place.
- **No automatic cross-encoder reranker**. `mmrRerank` is reused from
  upstream OpenClaw and gives diversity without an extra model call.
