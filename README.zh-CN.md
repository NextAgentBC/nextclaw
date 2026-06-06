# nextclaw

[English](README.md) · **简体中文**

> 为 [OpenClaw](https://github.com/openclaw/openclaw) 打造的 Postgres + pgvector 长期记忆插件。
> 四层召回 · 多键索引（“新华字典”式）· 确定性优先摄入 · 硬性按 agent 隔离 · 实时仪表盘。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: 0.3.0](https://img.shields.io/badge/status-0.3.0-blue)

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

## 功能简介

- 作为 OpenClaw 内置 SQLite 记忆插件（`memory-core`）的**即插即用替代**
- **四层召回**，让 75%+ 的重复查询在 <5ms 内返回，且**消耗 0 个 LLM token**、**0 次嵌入调用**
- **多键索引**（“新华字典”式）：每个记忆块(chunk)都能从多个正交维度被检索到 —— 语义 / 全文 / trigram / 概念标签 / 实体引用 / 时间桶 / 锚点 / 类别
- **确定性优先摄入**：热路径中没有 LLM；LLM 只作为残余阶段存在，仅当确定性抽取一无所获时才介入
- **硬性的按 agent 记忆命名空间隔离**：在同一个数据库上同时运行一个私有 agent 和一个公开的 Discord agent —— 它们在物理上无法看到彼此的记忆（在 SQL 层强制隔离，而非应用层）
- **语义问答缓存**（`cache.qa`）：重复的问题会命中亚毫秒级（L0 LRU）→ 约 5ms（L1 精确哈希）→ 约 50ms（L2 HNSW）。对重复问题完全跳过 LLM。
- **Telegram 群组 Moderator(群消息编排器)**（可选，默认关闭）：采用 Anthropic《Building Effective Agents》中所述的编排器–worker 模式。把群组中的 `@-mentions` 路由给带工具（`memory_search`、通过 Tavily 的 `web_search`）的专家 worker，并持久化角色设计，让注册表随时间不断积累。
- **实时仪表盘**（中英双语），包含类别分布、健康/医疗信息脱敏、bot 轮次遥测、模型并排对比
- **自调优循环**（每日 / 每周 / 每月提案）
- **通用 HTTP 摄入网关** —— 任何 cron / skill / 外部脚本都能通过同一条 Stage 0–6 流水线写入记忆
- **精选、带引用的召回**：`memory_search` 的结果会附带 `pg://` 引用，让 agent 能为某个论断标注出处，并通过 `memory_get(chunkId)` 重新取回其完整内容；`memory_update` / `memory_forget` 让 agent 能主动精选记忆，而不只是一味追加
- **动作敏感的记忆**：agent 可能会去*执行*的指令（取消、发送、授权、预约）会被标注 `safe_to_act` / `requires_confirmation` / `authority`，并在召回时以 ⚠ 标记呈现 —— 一句过时或无关的话，不经核实就无法触发真实世界的动作

## 配套 skill

可与 nextclaw 良好组合的独立 OpenClaw skill：

- **[openclaw-skill-reminder](https://github.com/NextAgentBC/openclaw-skill-reminder)** —— 注重隐私的基于时间的提醒。cron 配置文件里只看得到不透明的 `reminder:<short-id>` 名称；真正的细节（姓名、地址、预约）存放在一个 mode-600 权限的文件中。`/dashboard` 用户用它来安排跟进事项，而不会把 PII 泄露进 `jobs.json`。
- **[openclaw-selfcare](skills/openclaw-selfcare/)** —— *随本仓库一同提供*（`skills/openclaw-selfcare/`）。安全地让宿主的 OpenClaw 核心**以及本插件**保持更新：在任何升级之前都会先跑一遍沙箱兼容性预检（新版 openclaw 是否仍能加载本插件并解析其依赖？），它会自动修复可安全修复的问题（把插件升到兼容的 tag、安装缺失的传递依赖如 `undici`），并拒绝升级到一个已损坏或不兼容的状态。默认是只读的 `check`；`apply` 才会真正执行升级。参见 [`skills/openclaw-selfcare/SKILL.md`](skills/openclaw-selfcare/SKILL.md)。

## 快速上手（Neon 约 5 分钟，Docker 约 10 分钟）

你需要：一个 Postgres+pgvector 数据库（免费的 **Neon** 云端，或本地 **Docker**），以及一个免费的 **Jina** 嵌入(embedding) key（30 秒注册）。OpenClaw 自带 Node 22+，因此无需额外安装运行时。

关于 Telegram Moderator、web_search 和反思升级，参见 [INSTALL.md](docs/INSTALL.zh-CN.md) 中的附加组件。**请先阅读 [SERVICES.md](docs/SERVICES.zh-CN.md)**，了解每项能力分别需要哪些外部服务。

### 第 1 步 —— 安装 OpenClaw（宿主运行时，一行命令）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
# Windows PowerShell:  iwr -useb https://openclaw.ai/install.ps1 | iex
```

### 第 2 步 —— 准备一个带 pgvector 的 Postgres（二选一）

<details open><summary><strong>方案 A —— Neon（推荐，零本地依赖，免费 0.5 GB）</strong></summary>

1. 访问 <https://neon.tech> → **Sign up**（GitHub OAuth，无需信用卡）→ **Create project**
2. 复制创建后显示的连接串，例如 `postgresql://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require`
3. 在 Neon 的 **SQL Editor** 标签页里，粘贴并运行：

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS btree_gin;
   ```

4. 导出连接串：

   ```bash
   export PG_URL="postgresql://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require"
   ```

</details>

<details><summary><strong>方案 B —— Docker（本地，完全可控）</strong></summary>

```bash
docker run -d --name nextclaw-pg --restart unless-stopped \
  -e POSTGRES_USER=nextclaw -e POSTGRES_PASSWORD=nextclaw -e POSTGRES_DB=nextclaw \
  -p 127.0.0.1:55432:5432 -v nextclaw_pg:/var/lib/postgresql/data \
  pgvector/pgvector:pg16
until docker exec nextclaw-pg pg_isready -U nextclaw >/dev/null 2>&1; do sleep 1; done
docker exec nextclaw-pg psql -U nextclaw -d nextclaw -c \
  "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gin;"
export PG_URL="postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw"
```

</details>

### 第 3 步 —— 获取一个免费的 Jina 嵌入 key（30 秒，无需信用卡，100 万 token）

<https://jina.ai/embeddings> → **Get API key for free** → 复制

```bash
export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

把 `PG_URL` 持久化以供日后的 shell 使用，把 `JINA_API_KEY` 同时持久化给 shell *和* OpenClaw 守护进程。守护进程由 launchd/systemd 启动，因此它**不会**读取你的 `~/.zshrc` —— 它读取的是 `~/.openclaw/service-env/ai.openclaw.gateway.env`：

```bash
# For interactive shells (future `configure-minimal.mjs` runs, ad-hoc psql, etc.)
cat >> ~/.zshrc <<EOF   # or ~/.bashrc
export PG_URL="$PG_URL"
export JINA_API_KEY=$JINA_API_KEY
EOF

# For the gateway daemon (so memory_search / memory_store can call Jina)
echo "export JINA_API_KEY=$JINA_API_KEY" >> ~/.openclaw/service-env/ai.openclaw.gateway.env
```

### 第 4 步 —— 把 nextclaw 安装进 OpenClaw

```bash
openclaw plugins install git:github.com/NextAgentBC/nextclaw
```

该插件的 id 是 **`memory-postgres`**（无论从哪个来源安装均如此）。其他来源 —— npm、ClawHub、本地开发 —— 列在[其他安装方式](#其他安装方式)一节中。

### 第 5 步 —— 把它接入你的 `openclaw.json`（安全合并 —— 保留现有配置）

```bash
curl -fsSL https://raw.githubusercontent.com/NextAgentBC/nextclaw/main/scripts/configure-minimal.mjs |
  PG_URL="$PG_URL" node --input-type=module
```

这会向 `~/.openclaw/openclaw.json` 添加两个键，其余一切（`gateway`、`agents`、`auth`……）原封不动：

- `plugins.slots.memory = "memory-postgres"`
- `plugins.entries["memory-postgres"]`，包含 `postgres.url` + 仪表盘

> 更想手动编辑？把下面这段粘贴进你现有的 `plugins.entries` —— 其中的 embedding 块是可选的，省略时默认使用 Jina 免费档。
>
> ```jsonc
> "memory-postgres": {
>   "enabled": true,
>   "config": {
>     "postgres": { "url": "<your PG_URL>" },
>     "dashboard": { "enabled": true, "tokenEnv": "NEXTCLAW_DASH_TOKEN" }
>   }
> }
> ```

### 第 6 步 —— 设置仪表盘 token 并重启守护进程

```bash
export NEXTCLAW_DASH_TOKEN=$(openssl rand -hex 24)
# Persist for the daemon (same env file as JINA_API_KEY above)
echo "export NEXTCLAW_DASH_TOKEN=$NEXTCLAW_DASH_TOKEN" >> ~/.openclaw/service-env/ai.openclaw.gateway.env
# Persist for this shell session too, for the smoke-test curls below
echo "export NEXTCLAW_DASH_TOKEN=$NEXTCLAW_DASH_TOKEN" >> ~/.zshrc

openclaw gateway restart
```

### 第 7 步 —— 冒烟测试：写入一条记忆，再把它召回

仪表盘的 HTTP API 通过 **`X-Token`** 请求头（或 `?token=` 查询参数）来鉴权 —— 而不是 `Authorization: Bearer`。浏览器仪表盘会把 `?token=…` 捕获进 `sessionStorage`，随后在每次后续调用中以 `X-Token` 转发。

```bash
curl -sS -X POST http://127.0.0.1:8765/api/ingest \
  -H "X-Token: $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"My favorite Postgres extension is pgvector.","source":"smoke","agentId":"main"}'

curl -sS -X POST http://127.0.0.1:8765/api/recall \
  -H "X-Token: $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my favorite Postgres extension?","agentId":"main"}'
# → returns the chunk with hitTier: "t2_hybrid"
```

要在浏览器中打开实时仪表盘：

```
http://127.0.0.1:8765/?token=$NEXTCLAW_DASH_TOKEN
```

要查看带 persona 文件、故障排查、Discord/Telegram bot、web_search 以及多 agent 隔离的**完整 0 → 1 全流程**，参见 **[docs/INSTALL.md](docs/INSTALL.zh-CN.md)**。

### 其他安装方式

`openclaw plugins install` 接受多种来源 —— 选一个符合你工作流的：

```bash
# Git (recommended today — auto-builds during npm install via `prepare`)
openclaw plugins install git:github.com/NextAgentBC/nextclaw
openclaw plugins install git:github.com/NextAgentBC/nextclaw@v0.2.0   # pin a tag

# npm (coming soon — the bare `nextclaw` npm name is taken by an unrelated
# CLI, so this plugin will publish as a scoped name like @nextagentbc/nextclaw)
# openclaw plugins install npm:@nextagentbc/nextclaw

# ClawHub (coming soon — OpenClaw's official plugin hub)
# openclaw plugins install clawhub:memory-postgres

# Local dev (clone + live-reload symlink; runs from .ts source, no build needed)
git clone https://github.com/NextAgentBC/nextclaw.git
openclaw plugins install --link ./nextclaw
```

### 借助 AI agent 安装 nextclaw

本套文档刻意写成既适合人类、也适合 LLM agent 阅读。如果你想让一个 agent 替你安装 nextclaw：

1. 把 agent 指向 **[docs/SERVICES.md](docs/SERVICES.zh-CN.md)**，列举出你将需要哪些外部服务
2. agent 会按顺序逐项走完依赖 —— Postgres → 嵌入 → （可选）LLM → （可选）Telegram → （可选）Tavily —— 使用每一节给出的注册链接、env-var 名称和验证用 curl
3. 最后一步：agent 跑第 5 步的 `scripts/configure-minimal.mjs`，再跑第 7 步的冒烟测试

SERVICES.md 末尾的 “For AI agents” 一节详述了推荐的对话流程。

> **想自托管嵌入器而非使用 Jina？** 在本地运行 Ollama，
> 并在 `memory-postgres` 条目中加上 `"embedding": { "format": "ollama" }`
> —— embedding 块的其余字段会从各 format 的默认值自动补全。参见
> [docs/CONFIG.md#embedding](docs/CONFIG.zh-CN.md#embedding)。
>
> ⚠️ **嵌入维度是单向的。** 它会在首次摄入时自动检测，并锁进 HNSW 索引。
> 从 `jina-embeddings-v3`（1024d）切换到
> `qwen3-embedding:4b`（4096d）需要执行 `TRUNCATE semantic.chunks`
> 并重新摄入全部内容。请选一个你能用上一段时间的模型。

## 文档

| 文档 | 内容 |
|---|---|
| **[docs/SERVICES.md](docs/SERVICES.zh-CN.md)** | **请先阅读。** 每一项外部服务（Postgres、Jina、Gemini、Tavily、Telegram、OpenAI、credbroker）—— 注册链接、env var、配置片段、验证用 curl。为 AI agent 与人类双方而写。 |
| **[docs/INSTALL.md](docs/INSTALL.zh-CN.md)** | 全新机器的 0 → 1 全流程 · Discord bot · Telegram Moderator · web_search · 多 agent 隔离 · 故障排查。提供 A → D 四个能力等级，可逐级进阶。 |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.zh-CN.md)** | 存储布局 · 四层召回 · 八路混合 · Stage 0–6 摄入 · 隔离保证 · 打分 · 自调优 · worker |
| **[docs/CONFIG.md](docs/CONFIG.zh-CN.md)** | 每一个配置字段、默认值、调优建议 |
| **[docs/LIVE_TESTS.md](docs/LIVE_TESTS.zh-CN.md)** | 如何对一个真实的 PG + 嵌入服务端点跑实时测试 |

## 兼容性

- **OpenClaw** `>= 2026.4.25`
- **Node** `>= 22`
- **Postgres** `>= 16`，需 **pgvector** `>= 0.7.0`（HNSW）
- **嵌入**：Jina（默认，免费档），以及任意 OpenAI- 或 Ollama-兼容的服务端点。已测试 `jina-embeddings-v3`（1024d，默认）、`nomic-embed-text`（768d）、`qwen3-embedding:0.6b`（1024d）、`qwen3-embedding:4b`（4096d）。维度在首次嵌入时被检测并**锁进** HNSW 索引 —— 换模型就意味着重新摄入。
- **反思 LLM**（可选）：任意 OpenAI-兼容的聊天服务端点，或原生 Gemini API（例如通过 Google 的免费档或一个 Tailscale 凭证 broker）。默认关闭。

## 性能参考

数据来自单机部署、约 280 个记忆块、单条 Discord 对话流：

| 操作 | 路径 | LLM token | 嵌入调用 | 延迟 |
|---|---|---|---|---|
| 召回 —— 5 分钟内的重复查询 | T1 | 0 | 0 | ~ 1 ms |
| 召回 —— 锚点（如查询中含 PR #） | T2 anchor | 0 | 0 | ~ 8 ms |
| 召回 —— 一般性问题 | T2 hybrid | 0 | 1 | ~ 250 ms |
| 摄入 —— 短文本（<200 字符），嵌入已预热 | deterministic | 0 | 0（缓存命中） | ~ 50 ms |
| 摄入 —— 长文本（~2000 字符） | deterministic | 0 | 1 | ~ 600 ms |

在典型负载下，摄入端到端**消耗 0 个 LLM token**。除非启用了可选的意图分类器，召回的 LLM token 也是 0。

## 默认即隐私

- `health` 和 `medical` 类的记忆块会在摄入时被自动置顶（`importance ≥ 0.7`，`retention_class='pinned'`），且是确定性的 —— 依据一份中英文关键词词典，而非 LLM 判断
- 它们的 `text_excerpt` 在仪表盘的 `/api/recent` 响应中会被脱敏
- 按 agent 隔离意味着一个面向公众的 agent **无法**取回它们，即便用对抗式提示也不行

## 范围与限制

我们把这个插件是什么、不是什么讲清楚，方便你在安装前判断它是否合适：

### **记忆流水线**（召回、摄入、仪表盘、缓存、隔离）与渠道无关
适用于任何 openclaw agent —— DM、Discord、Slack、WhatsApp 等。摄入通过 HTTP 网关接受来自任何来源的文本。**不与任何特定渠道或 bot 账号绑定。**

### **Moderator**（Phase C / D，需主动开启）目前**仅限 Telegram 群组**
当 `moderator.enabled=true` 时，插件会注册一个 `before_dispatch` hook，认领 **`telegram` 渠道上的群组 @-mentions** —— codex（或本来会回复的其他任何插件）对这些消息会被抑制；Moderator 通过 Telegram Bot API 带外回复。

- **DM 不受影响** —— codex 一如既往地处理它们
- **不含 @-mention 的群消息不受影响** —— codex 本来也不回复这些
- **Slack / Discord / WhatsApp 的 `@-mentions` 不会被认领** —— 目前只有 `channelId === "telegram"` 才匹配

如果你想让 Moderator 用在另一个渠道上，抑制规则（`index.ts` → `before_dispatch` hook）和 Telegram-Bot-API 回复路径（`src/moderator/telegram-api.ts`）都需要做适配。欢迎提 issue/PR。

### 默认单租户；可显式多租户
本插件写入的每一行都带有一个 `agent_id` 列。Moderator 使用 `cfg.moderator.agentId`（默认 `"main"`）。要在同一个 Postgres 上运行两个 openclaw 实例而互不冲突，给每个安装一个不同的 `agentId`：

```jsonc
"moderator": { "enabled": true, "agentId": "tutor-bot" }
```

`worker_roles`、`moderator.state`、`moderator.decisions` 以及 `cache.qa` 的行全部按命名空间隔离 —— 各 agent 看不到彼此的状态。

### `web_search` 工具需要一个 Tavily 端点
要么是 `credbroker.baseUrl`（一个代理 Tavily 的 Tailscale 凭证 broker —— 参见 [docs/CONFIG.md](docs/CONFIG.zh-CN.md)），要么是 env 中的 `TAVILY_API_KEY`。**两者都没有时，`web_search` 会向 LLM 返回一个诚实的错误**（LLM 随后会向用户解释这一限制）。绝不静默失败。

### LLM 传输
- Moderator 决策 LLM：**OpenAI-兼容** 或 **Gemini `:generateContent`**（带工具调用）。OpenAI 的工具调用格式目前只支持单轮；多轮工具调用需要 Gemini。
- 嵌入：**Jina、OpenAI-兼容，或 Ollama**。默认是 Jina 免费档。

## 状态

`v0.2.x` —— 记忆流水线 + 仪表盘已稳定；Moderator + worker 工具层（Phase C/D）已经过实时测试，但相对更新。实时测试在参考配置上全部通过。并发模拟覆盖 8 个场景（缓存踩踏、跨 scope 并行、viewer 隔离、混合负载、worker 往返、角色自动注册、工具调用、web_search）。参见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[Apache 2.0](LICENSE) · [NOTICE](NOTICE) 致谢 OpenClaw 上游项目。
