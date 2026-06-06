# nextclaw — 配置参考

[English](CONFIG.md) · **简体中文**

每一个配置字段、默认值与调优建议。配置位于
`~/.openclaw/openclaw.json` 中的
`plugins.entries.memory-postgres.config` 下。

权威的 JSON Schema 定义在 `openclaw.plugin.json` 中；本文档
与之保持一致，并附带说明。

---

## `postgres`

```jsonc
"postgres": {
  "url": "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw",  // required
  "poolMax": 8,                       // default 8
  "statementTimeoutMs": 30000         // default 30s
}
```

| Field | Default | 说明 |
|---|---|---|
| `url` | required | `postgres://user:pass@host:port/db` |
| `poolMax` | 8 | node-postgres 连接池大小。如果同时运行多个并发摄入源，可调高到 16 以上 |
| `statementTimeoutMs` | 30000 | 单条语句的耗时上限。对失控查询触发一次干净的中止 |

---

## `embedding`

整个 `embedding` 配置块都是**可选的**。省略它（或传入 `{}`）
即可使用 Jina 免费层的默认值。设置 `format` 可切换嵌入(embedding)家族；
其余字段会按各 format 的默认值自动填充。

```jsonc
"embedding": {
  "format":     "jina",                          // "jina" (default) | "openai" | "ollama"
  "provider":   "jina",                          // informational tag, auto-filled from format
  "model":      "jina-embeddings-v3",            // auto-filled from format
  "baseUrl":    "https://api.jina.ai",           // auto-filled from format
  "apiKeyEnv":  "JINA_API_KEY",                  // auto-filled from format
  "path":       "/v1/embeddings",                // auto-filled from format
  "dims":       1024,                            // optional; auto-detected on first call
  "maxEmbedChars": 2000
}
```

| Field | Default | 说明 |
|---|---|---|
| `format` | `"jina"` | 协议格式（wire format）。`jina` = Jina 的 `/v1/embeddings`，采用非对称的 `task=retrieval.passage\|.query`。`openai` = 标准 `/v1/embeddings`。`ollama` = 本地 `/api/embed` |
| `provider` | from format | 仅作标签 —— 用于日志记录 |
| `model` | from format | 随请求体发送。各 format 的默认值：`jina-embeddings-v3` / `text-embedding-3-small` / `qwen3-embedding:4b` |
| `baseUrl` | from format | 服务端点主机，不含路径。各 format 的默认值：`https://api.jina.ai` / `https://api.openai.com` / `http://127.0.0.1:11434` |
| `apiKeyEnv` | from format | 持有 Bearer token 的环境变量名（不是其值）。各 format 的默认值：`JINA_API_KEY` / `OPENAI_API_KEY` / （ollama 无） |
| `path` | from format | 服务端点路径。各 format 的默认值：jina 与 openai 为 `/v1/embeddings`，ollama 为 `/api/embed` |
| `dims` | 首次调用时自动检测 | 锁定 HNSW 索引的维度。**不重新摄入就无法更改。** |
| `maxEmbedChars` | 2000 | 在嵌入(embedding)**之前**截断文本。完整文本仍存储在 `chunks.text` 中，可通过 tsvector / trgm 恢复。对长回复可将嵌入延迟降低 50–70%，且召回损失可忽略不计 |

**⚠️ 维度锁定。** HNSW 索引在首次嵌入时记录维度。从
`jina-embeddings-v3`（1024 维）切换到 `qwen3-embedding:4b`（4096 维）（或任何
其他维度变更）需要执行：
```sql
TRUNCATE semantic.chunks RESTART IDENTITY CASCADE;
TRUNCATE cache.embeddings;
DROP INDEX IF EXISTS semantic.chunks_embedding_hnsw;
```
……然后重启 gateway。迁移运行器会按新维度重建 HNSW。请将此
视为每个部署的一次性、不可逆决策。

**零摩擦方案 —— Jina 免费层。** 在 jina.ai/embeddings 获取一个 key，
执行 `export JINA_API_KEY=...`，然后整个 `embedding` 配置块都省略即可。

**自托管方案 —— Ollama。** 在本地运行 `ollama serve`，然后：
```jsonc
"embedding": { "format": "ollama" }
```
`model` 默认为 `qwen3-embedding:4b`；可覆盖 `model` 改用更小的模型
（`qwen3-embedding:0.6b` 提供快速的 1024 维，`nomic-embed-text`
提供极小的 768 维、偏英文）。

**多主机方案 —— 凭据代理。** 如果你运行了一个仅限 Tailscale、
服务端注入 API key 的 OpenAI 兼容代理，把端点指向它即可：
```jsonc
"embedding": {
  "format": "openai",
  "baseUrl": "http://100.79.97.110:8800/v1/proxy/local-embed",
  "model": "qwen3-embedding:0.6b"
}
```

---

## `tiers`

```jsonc
"tiers": {
  "t0SizeLimit": 50,
  "t1SizeLimit": 500,
  "t1TtlDays": 7,
  "warmthDecayHalflife": 14,
  "promotionThreshold": 2,
  "primeOnSessionStart": true
}
```

| Field | Default | 说明 |
|---|---|---|
| `t0SizeLimit` | 50 | 每会话进程内 LRU 上限 |
| `t1SizeLimit` | 500 | 每个 `user_scope` 在 `cache.hot_chunks` 中的软上限；写入时淘汰较旧的条目 |
| `t1TtlDays` | 7 | 超过此天数的热记忆块(chunk)回落到 T2 |
| `warmthDecayHalflife` | 14 days | 两次召回之间 warmth_score 衰减的半衰期 |
| `promotionThreshold` | 2 | 晋升到 T1 前需达到的 T2 命中次数 |
| `primeOnSessionStart` | true | 会话开始时用与锚点相关的记忆块(chunk)预热 T0 |

**调优**：对于单次会话中浮现大量不同话题的长上下文对话，
可将 `t0SizeLimit` 调高到 100 以上。

---

## `dashboard`

```jsonc
"dashboard": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 8765,
  "tokenEnv": "NEXTCLAW_DASH_TOKEN"
}
```

| Field | Default | 说明 |
|---|---|---|
| `enabled` | false | 默认关闭，除非显式开启 |
| `host` | `127.0.0.1` | 仅环回地址。设为其他值属于刻意为之 |
| `port` | 8765 | |
| `tokenEnv` | none | 持有仪表盘 token 的环境变量名。当 `host` 不是环回地址时**必填** |

**安全**：在没有 token 的情况下，nextclaw 拒绝将仪表盘公开暴露。
如需远程访问，请使用 Tailscale / Cloudflare Tunnel /
SSH 隧道，并保持 `host: 127.0.0.1`，**切勿**使用 `0.0.0.0`。

---

## `transcriptWatchers[]`

```jsonc
"transcriptWatchers": [{
  "id": "agent-main",                 // required, stable
  "agentId": "main",                  // default "main"
  "dir": "~/.openclaw/agents/main/sessions",  // required
  "intervalMs": 10000,                // min 5000
  "source": "session",                // label prefix
  "maxBytesPerTick": 262144,          // 256 KiB cap per file per tick
  "firstRunBackfillBytes": 65536,     // 64 KiB on first run
  "defaultImportance": 0.35,
  "dropPureQuestions": true,
  "anchors": { "cwd": "...", "branch": "..." }  // static anchors merged into every ingest
}]
```

`agentId` 控制记忆命名空间的隔离 —— 由该 watcher 摄入的记忆块(chunk)
会将 `agent_id` 设为此值。查询时按相同的 agent id 过滤即可检索到它们；
跨 agent 的查询在物理上无法访问。

`firstRunBackfillBytes`：在首次轮询某个会话文件时（没有持久化的偏移量），
向前回溯读取多少字节。可避免 watcher 首次启动时把整段历史记录
灌入记忆。设为 `0` 可完全禁用回填(backfill)。

`dropPureQuestions`：跳过整条内容都是问句的用户消息
（以 `?` 或 吗/呢/嘛 结尾）。这很有用，因为纯问句
很少包含可长期保留的事实。

---

## `gitWatchers[]`

```jsonc
"gitWatchers": [{
  "id": "openclaw-main",
  "path": "/home/me/openclaw",
  "branch": "main",
  "remote": "origin",
  "intervalMs": 3600000,              // 1h
  "source": "git",
  "anchors": { "cwd": "/home/me/openclaw", "branch": "main" }
}]
```

每隔 `intervalMs` 轮询本地仓库，摄入自 `last_sha`（持久化在
`audit.plugin_meta` 中）以来的新提交。会先执行 `git fetch`；
请确保守护进程的运行用户对该仓库及其远程拥有读取权限。

---

## `shadowComparators[]`

```jsonc
"shadowComparators": [{
  "id": "qwen-vs-gpt",
  "trajectoryDir": "~/.openclaw/agents/main/sessions",
  "baseUrl": "http://127.0.0.1:8000",
  "model": "Qwen3-32B-Instruct",
  "apiKeyEnv": "QWEN_API_KEY",        // optional
  "intervalMs": 30000,                // min 10s
  "backfillWindowMs": 86400000,       // 24h
  "maxOutputTokens": 400,
  "requestTimeoutMs": 90000,
  "minUserMessageChars": 4
}]
```

对于在 `<agent>/sessions/*.trajectory.jsonl` 中观察到的每一个 gpt 回合，
将同一条 prompt 重放到这个挑战者端点，并把双方结果存入
`audit.model_comparisons`。为仪表盘的 “Model
Comparison”（模型对比）面板提供数据。

---

## `sidecar`

```jsonc
"sidecar": {
  "enabled": true,
  "triggers": {
    "minUserMessageChars": 50,
    "onWriteTools": true,
    "onNumericMention": true,
    "onExplicitRemember": true
  },
  "consecutiveBadJsonDisableCount": 5
}
```

sidecar(旁路) 的 prompt 构建器会要求 agent 在回合结束时输出一个结构化的
`<mem>{entities, events, preferences, metrics}</mem>` 块。插件随后解析它
（第 2 阶段）并将结构化的数据行直接喂给抽取环节 ——
在结构化这一遍上零 LLM 成本。

当连续出现 `consecutiveBadJsonDisableCount` 个格式错误的 JSON 时，
自动停用 7 天。

---

## `gates`

```jsonc
"gates": {
  "salience": { "minImportance": 0.35, "model": "qwen3-instruct:7b" },
  "extractor": { "minConfidence": 0.7, "quarantineBelow": true },
  "perSourceOverrides": {
    "manual":  { "skipGates": true },
    "session": { "minImportance": 0.6 },
    "dream":   { "minImportance": 0.4 }
  },
  "trashRegexes": ["^\\s*$", "^(I'll|Let me)..."]
}
```

第 4 阶段的 LLM 残差路径。几乎所有人都会把它关掉（不做
残差 LLM 调用）。如果你想启用，可将 `salience.model` 设为一个廉价的本地模型。

---

## `recall`

```jsonc
"recall": {
  "intentModel": "qwen3-instruct:7b",  // optional, used only if intent classification is on
  "totalK": 24,
  "cacheRecallTtlSec": 300,
  "cacheIntentTtlSec": 3600
}
```

| Field | Default | 说明 |
|---|---|---|
| `totalK` | 24 | MMR 重排后的 Top-k |
| `cacheRecallTtlSec` | 300 | T1 cache.recall 的 TTL（5 分钟）。如果你的数据更新频繁，可调低 |
| `cacheIntentTtlSec` | 3600 | 意图分类缓存的 TTL |

---

## `compaction`

```jsonc
"compaction": {
  "enabled": true,
  "minAgeDays": 90,
  "minClusterSize": 5,
  "runDuringDeepDream": true
}
```

冷数据要点（cold-gist）合并。将满足以下条件的记忆块(chunk)聚为一类：
存在 90 天以上、共享 concept_tags / entities、且未被固定（pin）。
用 `cold.gists` 中的单条要点摘要替换它们；原始记忆块(chunk)被标记为
`retention='ephemeral'`，但为保留来源（`provenance`）会再留存 30 天。

---

## `retention`

```jsonc
"retention": {
  "ephemeralAfterDays": 90,
  "neverDecayPinned": true
}
```

冷数据要点（cold-gist）合并运行后，ephemeral 记忆块(chunk)在此窗口
之后成为真正删除的候选。被固定（pin）的记忆块(chunk)（含所有
健康/医疗类）永远不会被自动删除。

---

## `scoring`

```jsonc
"scoring": {
  "ingest": {
    "weights": { "token": 0.30, "latency": 0.20, "quality": 0.30, "path": 0.20 },
    "tokenBudgetCeiling": 1000,
    "latencyBudgetMs": 500
  },
  "recall": {
    "weights": { "token": 0.25, "latency": 0.25, "tier": 0.25, "relevance": 0.25 },
    "tokenBudgetCeiling": 500,
    "latencyBudgetMs": 200,
    "relevanceFollowupWindowMs": 3600000
  }
}
```

0–100 综合评分公式。默认权重是针对
“摄入大多廉价、召回应当快速” 这类工作负载调优的。如果你的
优先级不同，可自行调整（例如，若想对低置信度的抽取施加更重的
惩罚，可调高 `quality` 的权重）。

---

## `tuning`

```jsonc
"tuning": {
  "autoApplyEnabled": false,
  "scopes": {
    "trash_regex": "auto",       // safe_auto: dead regex pruning, etc.
    "salience_threshold": "review",
    "tier_capacity": "review",
    "embedding_model": "manual"
  }
}
```

自调优循环针对每个 scope 的应用策略。默认值偏
保守；在你设置 `autoApplyEnabled: true` 之前，不会有任何项被
自动应用。

---

## 顶层结构

```jsonc
{
  "postgres": { ... },        // required
  "embedding": { ... },       // required
  "tiers": { ... },           // optional
  "dashboard": { ... },       // optional
  "transcriptWatchers": [],   // optional
  "gitWatchers": [],          // optional
  "shadowComparators": [],    // optional
  "sidecar": { ... },         // optional
  "gates": { ... },           // optional
  "recall": { ... },          // optional
  "compaction": { ... },      // optional
  "retention": { ... },       // optional
  "scoring": { ... },         // optional
  "tuning": { ... }           // optional
}
```

凡是不在此列表中的项，都会在配置加载时被
`openclaw.plugin.json` 中的 JSON Schema 拒绝。
