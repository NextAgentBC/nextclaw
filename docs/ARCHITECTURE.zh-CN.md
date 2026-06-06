# nextclaw 架构

[English](ARCHITECTURE.md) · **简体中文**

> 一个基于 Postgres 的记忆插件为何长成这个样子，以及各个部件是如何
> 协同工作的。

---

## 存储布局

Postgres 16 + pgvector + pg_trgm + btree_gin。共五个 schema：

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

所有 DDL 都放在 `src/storage/schema/*.sql` 中，由迁移运行器（migration
runner）在插件启动时按字典序依次执行。新的 schema 写入一个带下一个序号
前缀的新文件（例如 `27-foo.sql`）。

`semantic.chunks` 上的 `agent_id` 列是**记忆命名空间的边界**。所有召回
路由都按 `WHERE c.agent_id = $X` 过滤；所有摄入都用写入者的 agent id
打标。这一约束在 SQL 层强制执行，而非在应用层。

---

## 四层召回

一次查询会按从最便宜到最昂贵的顺序逐层遍历，在第一个有用命中处即返回。
写入 `audit.recall_decisions.hit_tier` 的层级标签会精确告诉你每次查询
落在了哪一层。

| Tier | Storage | Latency | LLM | Embed | Fires when |
|---|---|---|---|---|---|
| **T0** | In-process LRU per `(agent_id, session_id)` | < 0.1 ms | 0 | 0 | Recently-touched chunks in the live session |
| **T1** | `cache.recall` (UNLOGGED), keyed on query+scope hash | ~ 1 ms | 0 | 0 | Same query repeats within 5 minutes |
| **T2 anchor** | `chunk_indexes (kind=anchor_*)` JOIN chunks | ~ 5–15 ms | 0 | 0 | Caller passed (or query implied) `pr` / `file` / `branch` |
| **T2 hybrid** | All 8 routes in parallel + MMR rerank | ~ 200–300 ms | 0 | 1 | Generic queries with no high-precision anchor |
| **T3** | `cold.gists` HNSW + drill-down to source chunks | ~ 200 ms | varies | 1 | T2 returned nothing useful; query is historical |

在真实使用中，T0 和 T1 覆盖了绝大多数重复查询（约 75%）。昂贵的 T2
混合路径只有在问题确实是全新的时候才会运行。

### 升级 / 降级

- T2 命中 → 记忆块被升级到 T1（`cache.hot_chunks`，TTL 7 天）和
  T0（进程内注册表，上限为 `tiers.t0SizeLimit`）
- T1 命中 → 已经是热数据；只需触碰 `last_recalled_at` 并提升 warmth
- 激活扩散 worker 在每次 T2 命中时异步触发：相邻记忆块（共享 entity /
  concept_tag / 时间桶）的 warmth 会被提升，使得邻近召回更快
- 90 天未被召回 + 未固定（non-pinned）+ 低重要性 → 成为冷 gist 整合的
  候选（压缩器 worker）

---

## 8 路“新华字典”式召回

“新华字典”的思路是：任何一个汉字都应当能从许多正交的路径触达（拼音 /
部首 / 笔画 / 四角号码）。把同样的思路套用到记忆块上。每个记忆块都会在
我们能确定性推导出的**每一个**信号上建立索引：

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

在一次 T2 混合查询中，这八路全部并行执行（`Promise.all`）。结果通过
加权归一化合并，再经 MMR 重排以保证多样性。多路命中会叠加增益：一个
同时命中 semantic + concept_tag + time_bucket 的记忆块，会胜过一个只
弱命中单一路由的记忆块。

路由器会直接从查询字符串本身推断锚点和概念标签（确定性正则），因此
调用方无需事先抽取。

---

## Stage 0–6 摄入流水线

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

在正常运行下，**摄入不消耗任何 LLM token**。确定性的各个阶段处理掉了
绝大部分工作；LLM 残余阶段的存在，是为了应对自动抽取没有产出任何东西、
但内容仍值得摄入的情况。

### 摄入时的隐私策略

类别为 `health` 和 `medical` 的内容会自动：
- 将 `retention_class` 提升为 `pinned`（永不衰减）
- 将 `importance` 提升到 ≥ 0.7
- 在仪表盘的 `/api/recent` 摘录中被脱敏

这是确定性的——对 `(医院|hospital|...)` 的一次正则匹配即触发该策略。
它**不**依赖某个 LLM 同意该内容属于敏感信息。

---

## 按 agent 隔离保证

多个 agent 人格可以共享同一个 Postgres 实例而不共享记忆。这条边界在
四个层面强制执行：

1. **数据库行级** —— `semantic.chunks.agent_id`；每条召回路由的 SQL
   都带有 `WHERE c.agent_id = $X`
2. **进程内工作集（T0）** —— 以 `<agent_id>::<session_id>` 为键的
   注册表
3. **缓存作用域键（T1）** —— `cache.recall.scope_key` 包含
   `agent:<id>` 前缀
4. **工具** —— `memory_search` / `memory_store` 从调用会话的会话键中
   解析出 agent id 并透传

经对抗性探测验证：一个次级 agent 发起 6 次旨在浮现主 agent 记忆块的
查询，召回结果为 **0**。

---

## 打分

每一次摄入和每一次召回都会向 `audit.*.score` 写入一个 0–100 的综合
分数。它让仪表盘能够显示“记忆操作健康”或“我们在召回上花费过多”。

### 摄入分数

```
ingest_score = 100 × (
    w_tok  × token_efficiency        ; default 0.30, ceiling 1000 tokens
  + w_lat  × latency_efficiency      ; default 0.20, ceiling 500 ms
  + w_qual × quality_signal          ; default 0.30
  + w_path × ingest_path_efficiency  ; default 0.20
)
```

`quality_signal` 反映抽取器的置信度；`ingest_path_efficiency` 偏好
廉价路径（确定性 / 缓存 > LLM 残余）。

### 召回分数

```
recall_score = 100 × (
    w_tok  × token_efficiency
  + w_lat  × latency_efficiency      ; ceiling 200 ms
  + w_tier × tier_efficiency         ; T0=1.00, T1=0.90, T2_anchor=0.75, T2_hybrid=0.55, T3=0.20
  + w_rel  × relevance_estimate      ; async-filled from follow-up signals
)
```

默认权重可在 `scoring.{ingest,recall}.weights` 中配置。

---

## 自调优循环

三种节奏，全部读取 `audit.*` SQL 视图，并将提案写入
`audit.tuning_proposals`：

| Cadence | Cost | Auto-apply | Examples |
|---|---|---|---|
| Daily (cron 04:00) | 0 LLM, pure SQL | `safe_auto` proposals only | dead trash regex pruning, frequent-reject pattern promotion, cache TTL adjustment |
| Weekly | 0 LLM, A/B replay | `pending` (review required) | salience threshold calibration, tier capacity changes |
| Monthly | optional LLM | `pending`, `high_risk` | new structured types emerging, embedding model refresh proposal |

自动应用的变更会写入一行回滚记录；应用后 24 小时的监控会在关键指标
偏差超过 20% 时回退。

---

## 实时可观测性

PG 触发器在每一行审计记录插入时触发：

```sql
CREATE TRIGGER ingest_decisions_notify AFTER INSERT ON audit.ingest_decisions
  FOR EACH ROW EXECUTE FUNCTION audit.notify_event();
```

仪表盘的 HTTP 服务器持有一个 `LISTEN audit_events` 连接，并向任意 SSE
客户端重新广播。可以亚秒级地跟踪每一次记忆操作。

---

## Worker

| Worker | Purpose | Trigger |
|---|---|---|
| `transcript-watcher` | Tails `<agent>/sessions/*.jsonl` and ingests every conversation turn | Polls every 10s; per-file byte offset persisted in `audit.plugin_meta` |
| `git-watcher` | Polls a local repo and ingests new commits since `last_sha` | Polls every 1h; `last_sha` persisted |
| `shadow-comparator` | Replays each turn against a challenger chat endpoint | Polls trajectory file every 30s |
| `compactor` | 90-day rolling cold-gist consolidation | Runs in the dreaming cycle |
| `spreading-activator` | Hebbian neighbor warmth bump | Fires async on every T2 recall |
| `tuning` | Scheduled proposal analyzer | Cron-style (daily / weekly / monthly) |
| `dashboard` | HTTP + SSE | Long-running |

所有 worker 都通过插件的 `stop()` 钩子支持优雅关闭。

---

## 有意不做的部分

- **不引入重排模型（reranker）**。MMR + 多路叠加已经能让我们达到不错的
  精度，无需单独的 cross-encoder。如果你的领域需要，可以自行加上。
- **不引入图遍历语言**。关系（relations）会被存储，但召回不会去遍历
  它们。架构上已为此预留——可以作为第 9 路加入——但它不在 v0.1 的
  路线上。
- **不引入 Redis**。cache.* 各表使用 PG UNLOGGED。如果你做了埋点并
  观察到缓存争用，替换 `CacheBackend` 实现即可；这一抽象已经就位。
- **不引入自动 cross-encoder 重排器**。`mmrRerank` 复用自上游
  OpenClaw，无需额外的模型调用即可提供多样性。
