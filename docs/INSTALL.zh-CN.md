# nextclaw —— 从 0 到 1 安装实战

[English](INSTALL.md) · **简体中文**

这是一份**全新机器**上的安装指南。如果你已经跑起了 OpenClaw 和一个嵌入服务端点（embedding endpoint），可以直接跳到步骤 ④。

已在 Ubuntu 24.04 和 macOS 14 上测试通过。理论上凡是 OpenClaw 安装脚本能跑起来的主机都适用（Linux、macOS、Windows-WSL）。Postgres 既可以用云端（Neon —— 零本地依赖），也可以用本地（Docker）。预计耗时：走 Neon 的「纯记忆」路线约 **15 分钟**；如果还想加上 Telegram Moderator 和 `web_search`，再多花 **15 分钟**。

> 📦 **动手之前：请先看 [SERVICES.zh-CN.md](SERVICES.zh-CN.md)** —— 那里列出了 nextclaw 可以接入的全部外部服务（Postgres、Jina、Gemini、Tavily、Telegram、OpenAI、credbroker），附带注册链接和每个服务对应的验证命令。本文假设你已经想清楚自己要用哪些服务。

### 能力等级（开始前先选一个）

| 等级 | 能用什么 | 需要的外部服务 | 预计耗时 |
|---|---|---|---|
| **A. 纯记忆** | 召回、摄入、仪表盘、隔离 | Postgres + Jina | 10 分钟 |
| **B. + 反思（Reflection）** | 在 A 的基础上加每晚记忆整合 | Postgres + Jina + Gemini | 15 分钟 |
| **C. + Telegram Moderator** | 在上面基础上加群内 `@bot` 应答 | Postgres + Jina + Gemini + Telegram bot | 30 分钟 |
| **D. + 网页搜索** | 在上面基础上加 worker 的 `web_search`，用于获取实时信息 | Postgres + Jina + Gemini + Telegram + Tavily | 35 分钟 |

本文**先把等级 A 搭起来**，B/C/D 则做成可选附加（bolt-on）的章节，你可以之后再做。

---

## ① 安装 OpenClaw

nextclaw 是 [OpenClaw](https://github.com/openclaw/openclaw) 的一个*插件*，而不是独立程序。先装好 OpenClaw；它自带 Node 运行时，所以没有额外的前置依赖。

```bash
# macOS / Linux — one-line installer
curl -fsSL https://openclaw.ai/install.sh | bash

# Windows (PowerShell):
#   iwr -useb https://openclaw.ai/install.ps1 | iex

# Run the onboarding wizard (installs the gateway as a launchd/systemd user service)
openclaw onboard --install-daemon
```

验证：

```bash
openclaw --version    # should print 2026.x.x
openclaw doctor       # should mostly pass; warnings about disabled bundled plugins are fine
```

> 引导向导会生成 `~/.openclaw/openclaw.json`，里面带有一套合理的默认配置（网关 gateway、认证 profile、agent 工作区）。我们会在步骤 ⑤ 里把 nextclaw 的插件条目**追加**进这个文件 —— 切勿覆盖它。

---

## ② 启动 Postgres + pgvector

二选一：**选项 A（Neon，云端，零本地依赖）** 或 **选项 B（Docker，本地）**。两条路都会产出一个 `PG_URL` 环境变量，本指南后续都会用到它。

### 选项 A —— Neon（推荐，免费 0.5 GB，无需信用卡）

1. 打开 <https://neon.tech> → 用 GitHub **Sign up** → **Create project**
2. 复制创建完成后显示的连接串，例如 `postgresql://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require`
3. 在 Neon 的 **SQL Editor** 标签页里粘贴并运行：

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS btree_gin;
   ```

4. 导出它：

   ```bash
   export PG_URL="postgresql://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require"
   ```

> Neon 会自动挂起（suspend）空闲的数据库。长时间空闲后的第一次召回可能要等 ~1–2 秒，等计算实例唤醒；之后的召回又会恢复到正常速度。

### 选项 B —— Docker（本地，完全可控）

```bash
docker run -d --name nextclaw-pg --restart unless-stopped \
  -e POSTGRES_USER=nextclaw -e POSTGRES_PASSWORD=nextclaw -e POSTGRES_DB=nextclaw \
  -p 127.0.0.1:55432:5432 -v nextclaw_pg:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

# Wait for PG, then install the three extensions
until docker exec nextclaw-pg pg_isready -U nextclaw >/dev/null 2>&1; do sleep 1; done
docker exec nextclaw-pg psql -U nextclaw -d nextclaw -c \
  "CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS btree_gin;"

export PG_URL="postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw"
```

两条路都用下面这条命令验证：

```bash
psql "$PG_URL" -c "SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','btree_gin');"
# Should list all three. (Install psql via `brew install libpq` or `apt-get install postgresql-client` if missing.)
```

> Docker 容器只绑定在宿主机的 **127.0.0.1:55432** 上，绝不会暴露到公网接口。数据卷 `nextclaw_pg` 会在容器重启后持久保留。想清空重来：`docker rm -f nextclaw-pg && docker volume rm nextclaw_pg`。

---

## ③ 准备一个嵌入服务端点

**默认方案：Jina 免费档 —— 30 秒搞定，无需信用卡、无需 GPU。**

1. 打开 [jina.ai/embeddings](https://jina.ai/embeddings/)，点击 "Get API key for free"
2. 复制密钥并导出：

```bash
export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

就这么简单。验证：

```bash
curl -sS https://api.jina.ai/v1/embeddings \
  -H "Authorization: Bearer $JINA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"jina-embeddings-v3","input":["hello"]}' | head -c 200
# Should return JSON with a "data": [{ "embedding": [...] }] array
```

`jina-embeddings-v3` 是 1024 维、多语言的（中文支持很好），免费档每个密钥覆盖 100 万 token（按典型聊天用量算约等于 500 天）。当配置里省略 `embedding` 块时，插件默认就用它。

> ⚠️ **嵌入维度是单向的，无法回头。** 它会在首次摄入时被自动检测，并锁进 HNSW 索引。要从 `jina-embeddings-v3`（1024 维）切换到 `qwen3-embedding:4b`（4096 维），就必须执行 `TRUNCATE semantic.chunks RESTART IDENTITY CASCADE` 并把所有内容重新摄入一遍。所以请挑一个你未来几个月都能接受的模型。

### 备选方案：用 Ollama 自托管（无需 API，完全可控）

如果你更想把嵌入模型跑在本地 —— 隐私更好、没有速率限制，但需要 ~1–4 GB 的内存/显存：

```bash
# Linux (one-liner installer)
curl -fsSL https://ollama.com/install.sh | sh
# macOS: download from https://ollama.com (or: brew install ollama)

ollama serve &                          # background, listens on 127.0.0.1:11434
ollama pull qwen3-embedding:0.6b        # ~1 GB, multilingual, recommended
# or:  ollama pull nomic-embed-text     # ~274 MB, English-leaning
```

然后在 embedding 块里写上 `"format": "ollama"`（其余字段都会从该格式的默认值里自动补齐）。详见 [`docs/CONFIG.md#embedding`](CONFIG.zh-CN.md#embedding)。

### 备选方案：Tailscale 凭据中转（私有集群、多主机）

如果你在一个 Tailscale tailnet 上跑多个 agent，并且希望调用方主机上一个 API 密钥都不存，那就把端点指向你信任的 mainserver 上的一个 OpenAI 兼容代理。示例（把 IP / 端口换成你自己的）：

```jsonc
"embedding": {
  "format": "openai",
  "baseUrl": "http://100.79.97.110:8800/v1/proxy/local-embed",
  "model": "qwen3-embedding:0.6b"
  // apiKeyEnv omitted — broker authenticates via tailnet identity
}
```

---

## ④ 把 nextclaw 装进 OpenClaw

OpenClaw 的插件加载器可以直接从本仓库拉取插件。`package.json` 里的 `prepare` 脚本会在 `npm install` 期间自动构建，所以等安装完成时，编译产物已经就绪。

```bash
openclaw plugins install git:github.com/NextAgentBC/nextclaw

# Optional: pin to a specific tag for reproducibility
# openclaw plugins install git:github.com/NextAgentBC/nextclaw@v0.2.0
```

验证：

```bash
openclaw plugins list | grep memory-postgres
# Should show:  memory-postgres  enabled  global:memory-postgres/dist/index.js  0.2.0
```

> 无论你从哪里安装，插件的 id 永远是 **`memory-postgres`** —— 这正是你在 `openclaw.json` 的 `plugins.slots.memory` 和 `plugins.entries` 里要引用的那个键。npm 包名和仓库名（"nextclaw"）都跟 manifest 里的 id 无关。

> **其他安装来源**（都会产出同一个 `memory-postgres` id）：
>
> | 来源 | 命令 | 何时使用 |
> |---|---|---|
> | npm（即将上线） | `openclaw plugins install npm:@nextagentbc/nextclaw` | 一旦以带作用域的名字发布到 npm 后 |
> | ClawHub（即将上线） | `openclaw plugins install clawhub:memory-postgres` | 在 OpenClaw 官方 hub 上架之后 |
> | 本地 checkout | `git clone … && openclaw plugins install --link ./nextclaw` | 想改插件本身时 —— 软链接方式，直接从 `.ts` 源码运行 |
> | 本地 tarball | `openclaw plugins install npm-pack:./nextclaw-0.2.0.tgz` | 隔离网络 / 离线安装 |

---

## ⑤ 配置 `~/.openclaw/openclaw.json`

步骤 ① 里的 `openclaw onboard` 已经写好了这个文件，里面有 `gateway`、`agents`、`auth` 等等。你需要做的是把 nextclaw 的插件条目**合并**进去，同时不打扰其他任何内容。

### 最快：用自带的辅助脚本（安全合并）

```bash
curl -fsSL https://raw.githubusercontent.com/NextAgentBC/nextclaw/main/scripts/configure-minimal.mjs |
  PG_URL="$PG_URL" node --input-type=module
```

它只会精确地加两个键：

- `plugins.slots.memory = "memory-postgres"`
- `plugins.entries["memory-postgres"]`，包含你的 `postgres.url` 和一个默认的 dashboard 块

文件里的其他每一个键都会逐字节原样保留。

### 手动：自己编辑

用编辑器打开 `~/.openclaw/openclaw.json`。在已有的 `plugins.entries` 对象下，加入：

```jsonc
"memory-postgres": {
  "enabled": true,
  "config": {
    "postgres": { "url": "<your PG_URL>" },
    "dashboard": { "enabled": true, "tokenEnv": "NEXTCLAW_DASH_TOKEN" }
  }
}
```

再在 `plugins.slots` 下加上（或设置）`"memory": "memory-postgres"`。embedding 块是可选的 —— 省略时默认使用 Jina 免费档，并从环境变量里读取 `JINA_API_KEY`。

### 更贴近实战的配置 —— 开启仪表盘、对话记录监听器、每晚反思

如果想要一套更接近生产环境的配置，完整的 `memory-postgres.config` 长这样（把 `configure-minimal.mjs` 生成的那个值粘贴替换掉）：

```jsonc
"memory-postgres": {
  "enabled": true,
  "config": {
    "postgres": { "url": "<your PG_URL>" },

    // Embedding block is OPTIONAL — defaults to Jina free-tier.
    // Uncomment + edit to swap to ollama / openai / proxy:
    // "embedding": { "format": "ollama" },

    "tiers": {
      "t0SizeLimit": 50,
      "t1SizeLimit": 500,
      "t1TtlDays": 7,
      "primeOnSessionStart": true
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
      "dir": "~/.openclaw/agents/main/sessions",
      "intervalMs": 10000,
      "defaultImportance": 0.35
    }]
    // For nightly reflection see the bolt-on section below.
  }
}
```

> 如果你的 OpenClaw 构建不会自动展开 `~`，请把它换成你的绝对 home 路径（Linux 上是 `/home/<you>`，macOS 上是 `/Users/<you>`）。

---

## ⑥ 配置工作区人格文件（可选但推荐）

OpenClaw 会把 agent 工作区里的 markdown 加载进系统提示词。没有这些文件，agent 就没有人格。

```bash
mkdir -p ~/.openclaw/workspace
cat > ~/.openclaw/workspace/SOUL.md <<'EOF'
You are a long-memory AI assistant.
- Direct answers; skip pleasantries
- Be honest about uncertainty
- Use memory_search before answering questions about past conversations
EOF

cat > ~/.openclaw/workspace/IDENTITY.md <<'EOF'
- Name: <pick one>
- Vibe: helpful, precise, long-termist
EOF

cat > ~/.openclaw/workspace/USER.md <<'EOF'
- Name: <your name>
- Email: <your email>
- Preferences: <how you want to be addressed, language, etc>
EOF
```

> AGENTS.md 随 OpenClaw 一起提供，告诉 agent 总体上该怎么表现。SOUL.md / IDENTITY.md / USER.md 则是每个用户自己的定制。如果你跳过这一步，bot 仍然能用，只是人格比较通用。

---

## ⑦ 启动，然后用冒烟测试验证

```bash
# Generate a dashboard token (any random string)
export NEXTCLAW_DASH_TOKEN=$(openssl rand -hex 24)

# Persist for the daemon (launchd/systemd does NOT read ~/.zshrc — it sources
# ~/.openclaw/service-env/ai.openclaw.gateway.env on each start).
# Same file should also hold JINA_API_KEY so the embedding client can run.
ENV_FILE=~/.openclaw/service-env/ai.openclaw.gateway.env
grep -q '^export JINA_API_KEY=' "$ENV_FILE" 2>/dev/null \
  || echo "export JINA_API_KEY=$JINA_API_KEY" >> "$ENV_FILE"
echo "export NEXTCLAW_DASH_TOKEN=$NEXTCLAW_DASH_TOKEN" >> "$ENV_FILE"

# Persist for this shell too (for the smoke-test curls below)
echo "export NEXTCLAW_DASH_TOKEN=$NEXTCLAW_DASH_TOKEN" >> ~/.zshrc

# Restart the gateway daemon so it picks up the new plugin + config
openclaw gateway restart
```

首次启动时，迁移执行器会应用插件自带的所有 DDL 文件（位于 `<install-path>/dist/src/storage/schema/*.sql`；确切的安装路径因环境而异 —— 运行 `openclaw plugins list | grep memory-postgres` 即可看到）。留意这几行：

```
memory-postgres: capability + tools registered (memory_search, memory_store, dashboard, ...)
memory-postgres: transcript-watcher started — id=agent-main ...
http server listening
```

### 冒烟测试 1 —— 通过通用 HTTP 网关写入 + 召回

仪表盘 API 通过 **`X-Token`** 请求头（或 `?token=` 查询参数）来鉴权。浏览器仪表盘会把 `?token=…` 捕获进 `sessionStorage`，并在之后每次请求里以 `X-Token` 的形式带上。

```bash
# Write
curl -sS -X POST http://127.0.0.1:8765/api/ingest \
  -H "X-Token: $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"My favorite Postgres extension is pgvector.","source":"smoke","agentId":"main"}' \
  | python3 -m json.tool

# Recall
curl -sS -X POST http://127.0.0.1:8765/api/recall \
  -H "X-Token: $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my favorite Postgres extension?","agentId":"main"}' \
  | python3 -m json.tool
```

召回应当返回带 `hitTier: "t2_hybrid"` 的那个记忆块（chunk）。5 分钟内再次发起完全相同的召回会命中 `t1` 缓存（~1ms）。

### 冒烟测试 2 —— 打开仪表盘

```
http://127.0.0.1:8765/?token=$NEXTCLAW_DASH_TOKEN
```

token 会被捕获到 `sessionStorage`，并在后续 fetch 里以 `X-Token` 形式转发。你应该会看到：

- KPI：过去 24 小时内 1 次摄入、1 次召回
- 实时事件流：2 条事件（1 次摄入、1 次召回）
- 最近摄入表：你刚刚写入的那个 chunk
- 最近召回表：你刚刚发起的那个查询

如果有任何面板是空的，看文末的**故障排查**。

---

## ⑧ 加一个 Discord bot（可选）

如果你想要一个聊天 bot 前端，而不只是 HTTP API：

### 8.1 创建 Discord 应用

1. 打开 https://discord.com/developers/applications → **New Application**
2. Bot 标签页 → **Reset Token** → 保存 token（只显示这一次）
3. Privileged Gateway Intents → 启用 **Message Content Intent**
4. OAuth2 → URL Generator → 勾选 `bot` scope；权限勾选 View Channel、Send Messages、Read Message History → 把 bot 邀请到你的服务器

### 8.2 拿到你需要的几个 ID

在 Discord 客户端里 → User Settings → Advanced → **Developer Mode: ON**。然后右键 → **Copy ID**，分别复制：

- 你把 bot 邀请进去的那个服务器（guild）
- 你想让它应答的那个频道

### 8.3 接入 `openclaw.json`

```jsonc
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "<your bot token>",
      "groupPolicy": "allowlist",
      "allowFrom": ["*"],
      "allowBots": "mentions",
      "guilds": {
        "<your guild id>": {
          "slug": "my-server",
          "requireMention": true,
          "ignoreOtherMentions": true,
          "channels": {
            "<your channel id>": { "enabled": true }
          }
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "discord",
        "guildId": "<your guild id>",
        "peer": { "kind": "channel", "id": "<your channel id>" }
      }
    }
  ]
}
```

> `groupPolicy: "allowlist"` 加 `allowFrom: ["*"]` 的意思是：在列出的 guild 里，**任何用户**都能跟 bot 对话。想收紧，就把 `"*"` 换成具体的 Discord 用户 ID。

> `requireMention: true` 意味着只有被显式 @ 提及时 bot 才会应答。如果你想让**其他** bot（比如一个 Linux IRC 桥接 bot）也能 @ 它，就配合 `allowBots: "mentions"` 一起用。

重启网关，进你的 Discord 频道，**@你的-bot hi**，然后看着仪表盘亮起来。

---

## ⑨ 多 agent 硬隔离（可选）

如果你想要一个面向公众的 agent（比如一个社区 Discord），并且让它**物理上无法**看到你的私有记忆：

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
        "guildId": "<public-guild-id>",
        "peer": { "kind": "channel", "id": "<public-channel-id>" }
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

再建一个独立的工作区目录 + 人格文件：

```bash
mkdir -p ~/.openclaw/workspace-club ~/.openclaw/agents/club/sessions
# Create SOUL.md / IDENTITY.md (no USER.md — public agent shouldn't know your private info)
```

验证 —— club agent 的 `agent_id='club'` 记忆块在每一条召回路径上都会被 SQL 层过滤。一句 `WHERE c.agent_id = $X` 条件能挡住跨 agent 的读取，哪怕提示词是恶意构造的也一样。完整的隔离模型见 [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md)。

---

## 可选附加：每晚反思（等级 B）

反思守护进程会读取最近 24 小时的对话记忆块，写出一个蒸馏后的 `kind='reflection'` 汇总块，外加一组 `kind='profile'`，后者会在每次召回时被预热（prime）进 T0（模型的工作记忆）。效果是：长时间运行的上下文能跨天存活，而不必把历史一遍遍重新喂进提示词。

**前置条件：** 一个 LLM 端点。免费推荐：**Gemini 2.5 Flash** —— 见 [SERVICES.zh-CN.md §3](SERVICES.zh-CN.md#3-gemini-google-ai-studio--free-llm-for-moderator--reflection)。

```bash
# Get a Gemini key from https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...
```

在 `openclaw.json` 的 `memory-postgres.config` 下加入：

```jsonc
"reflection": {
  "enabled": true,
  "intervalMs": 86400000,
  "lookbackHours": 24,
  "model": {
    "format": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

重启 OpenClaw。在日志里验证：

```
memory-postgres: reflection daemon started — format=gemini model=gemini-2.5-flash intervalMs=86400000
```

第一次反思会在启动约 24 小时后运行。想提前强制跑一次，手动调用仪表盘端点（需要 token）：

```bash
curl -sS -X POST "http://127.0.0.1:8765/api/reflection/run-now" \
  -H "X-Token: $NEXTCLAW_DASH_TOKEN"
```

---

## 可选附加：Telegram Moderator（等级 C）

Moderator（群消息编排器）是一个有自己一套主张的 orchestrator-worker（编排器-worker）：它会把 Telegram 群里的 `@-提及` 从 codex（或其他本来会应答的东西）那里**抢过来**，然后跑一套多步决策循环：

1. 缓存预检（L0/L1/L2）—— 重复问题在 <50ms 内应答，且 0 LLM token 消耗
2. Moderator 决策 —— gpt-5.5 / gemini-flash 选出 `answer-direct` / `clarify` / `escalate` 等动作
3. worker 派发 —— 专职角色 + memory_search +（可选）web_search
4. 通过 Telegram Bot API 回复 —— 先发一个占位的 ⏳，答案就绪后再编辑成正式内容
5. 把答案写回 cache.qa，这样下一个类似问题就能命中预检

私聊（DM）**不会**被抢 —— 仍由 codex 像以前一样处理。

**前置条件：**
1. **Telegram bot token** —— 从 [@BotFather](https://t.me/BotFather) 获取，见 [SERVICES.zh-CN.md §4](SERVICES.zh-CN.md#4-telegram-bot--required-for-moderator)
2. **你的 Telegram 用户 ID** —— 从 [@userinfobot](https://t.me/userinfobot) 获取
3. **LLM 端点**（推荐 Gemini，跟反思用同一个密钥就行）

```bash
# Already have these from Level B; just adding the Telegram pieces:
export GEMINI_API_KEY=AIza...
TELEGRAM_BOT_TOKEN=1234567890:AAH...   # not exported — goes inline in config
TELEGRAM_OWNER_ID=8064984663            # YOUR Telegram user id from @userinfobot
```

在 `openclaw.json` 里加入（顶层，与 `plugins` 平级）：

```jsonc
"channels": {
  "telegram": {
    "enabled": true,
    "botToken": "1234567890:AAH...",
    "polling": { "enabled": true }
  }
},
"commands": {
  "ownerAllowFrom": ["telegram:8064984663"]
}
```

再在 `memory-postgres.config` 下加入：

```jsonc
"moderator": {
  "enabled": true,
  "agentId": "main",
  "debounceMs": 1500,
  "model": {
    "format": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

**在 Oracle Cloud / IPv6 有问题的主机上，设置 IPv6 兜底开关**：见 [docs/CONFIG.zh-CN.md](CONFIG.zh-CN.md#telegram-on-ipv6-broken-hosts) —— 在 systemd drop-in 里加上 `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`。

重启 OpenClaw。把你的 bot 加进一个 Telegram 群。发送 `@my_tutor_bot hello`。观察：

```bash
journalctl --user -u openclaw-gateway --since "1 min ago" | grep -E "moderator|before_dispatch"
```

你应该会看到 `[moderator/hook] before_dispatch CLAIMED`，紧接着是 `moderator: scope=tg:chat:... action=answer-direct`。bot 会先回一个占位的 ⏳，然后是真正的答案。

**常见坑：** 群里的 Telegram bot 默认只能看到**@ 它**或**回复它消息**的那些消息（默认隐私模式）。这恰好就是 Moderator 想要的。除非你想让 Moderator 处理群里的每一条消息，否则**不要**去用 `/setprivacy` → Disable。

---

## 可选附加：web_search worker 工具（等级 D）

没有它，worker 只能靠记忆 + LLM 训练数据来回答，并会表示自己无法上网查实时信息（新闻、最新版本号，以及任何时效性内容）。接入 Tavily 后，worker 的工具调用循环里就解锁了实时网页搜索。

**已经配好了 OpenClaw 的 tavily 插件？**（判断方法：`openclaw doctor` 里提到了 tavily，或者你在启动日志里看到 `tavily web search provider selected`）那就**完事了**。nextclaw 的 Moderator worker 会自动复用 `plugins.entries.tavily.config.webSearch.apiKey` 里那把同样的 Tavily 密钥。不用环境变量，也不用额外配置。

**第一次接 Tavily？** 见 [SERVICES.zh-CN.md §5](SERVICES.zh-CN.md#5-tavily--web-search-for-the-moderators-web_search-tool) —— 免费每月 1,000 次搜索。推荐做法：把密钥放进 `plugins.entries.tavily.config.webSearch.apiKey`，这样 codex 和 Moderator worker 就能共用同一份凭据。

**重启后验证：** 问 bot 一些实时的东西，比如 "@my_tutor_bot 今天有什么 AI 新闻"。日志里应该出现：

```
worker[tN]: model invoked 1 tool(s): web_search
```

如果看到这一行却没有答案：说明 Tavily 调用失败了（查 `journalctl ... | grep web_search`）。如果压根看不到这一行：说明 worker 判断光靠记忆就够了 —— 这是模型自己的决定。

---

## ⑩ 故障排查

**首次启动时迁移报错**
```
ERROR: extension "vector" is not available
```
→ pgvector 扩展没装上。
- **Neon**：在 Neon 的 SQL Editor 里把步骤 ②A 的那三条 `CREATE EXTENSION` 语句再跑一遍。
- **Docker**：确认你用的是 `pgvector/pgvector:pg16` 镜像（而不是原版 `postgres:16`）。清空重建：`docker rm -f nextclaw-pg && docker volume rm nextclaw_pg`，然后重新执行步骤 ②B 里的 docker run。

**`openclaw plugins install git:` 报错 "requires compiled runtime output"**
→ 你是从一个缺了 `prepare` 脚本的 fork 安装的。检查源码里的 `package.json`，确认 `scripts` 中有 `"prepare": "npm run build"`，且 `devDependencies` 里有 `typescript`。上游的 `NextAgentBC/nextclaw` 仓库自 v0.2.0 起两者都有。

**仪表盘提示 "unauthorized" 或 401**
→ token 没传进去。用 `?token=$NEXTCLAW_DASH_TOKEN` 打开一次 URL；之后它会存进浏览器的 `sessionStorage`，并在后续加载时以 `X-Token` 转发。关掉标签页就会清空。

**bot 在 Discord 上不应答**
→ 按顺序检查：
1. `openclaw doctor` —— 有没有任何 "channel allowlist drops" 的警告？
2. 你 @ 的是不是**用户** id，而不是**身份组（role）** id？有些客户端会自动补全成一个跟 bot 同名的身份组。临时关掉 `requireMention` 来测试。
3. `tail -f /tmp/openclaw/openclaw-*.log | grep discord` —— 找 `skipping guild message` 的原因。
4. bot 在那个频道上有没有 **View Channel + Send Messages** 权限？

**写入之后召回却始终返回 0 条结果**
→ 嵌入服务端点不可达。直接 `curl /v1/embeddings` 测一下。检查 `/api/recent`，看摄入事件是否有 `decision: "accepted"` 且 `latency_ms` 非零 —— 如果写入进得去但召回什么都找不到，那多半是 HNSW 索引没建起来（它在首次嵌入时才惰性创建）。重启网关，再重新写一个 chunk。

**`<mem>{...}</mem>` 文本泄漏进了 bot 在 Discord 上的回复里**
→ 你的 OpenClaw 比 2026 年 5 月还旧。用 `openclaw update` 更新，或者在 memory-postgres 配置里设 `prompting.sidecar: "off"`。

**仪表盘面板是空的 / 事件不推流**
→ PG 的 `LISTEN/NOTIFY` 可能被挡了。检查直接执行 `SELECT pg_notify('test', 'hello')` 是否能成功。（Neon 自 2023 年起支持 LISTEN/NOTIFY；如果它失效了，去看 Neon 的状态页。）SSE 给每个客户端保持一条连接；重新加载仪表盘标签页即可。

**插件安装成功，但网关日志报 "memory-postgres config validation failed"**
→ 你在配置 `postgres.url` 之前就运行了 `openclaw plugins install`。安装这一步同时还会试图*激活*插件，而激活需要一份有效的配置。先完成步骤 ⑤（或重新跑一遍 `configure-minimal.mjs`），然后 `openclaw gateway restart`。

---

## 接下来去哪儿

- [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md) —— 四层召回模型、Stage 0–6 流水线、多键索引、隔离保证
- [CONFIG.zh-CN.md](CONFIG.zh-CN.md) —— 每一个配置字段、默认值和调优建议
- [LIVE_TESTS.zh-CN.md](LIVE_TESTS.zh-CN.md) —— 如何针对真实的 PG + 嵌入服务端点运行实时测试套件
- 如果本指南里有任何步骤对你不管用，欢迎提 issue：https://github.com/NextAgentBC/nextclaw/issues
