# nextclaw 使用的外部服务

[English](SERVICES.md) · **简体中文**

本文档列出了 nextclaw 可以对接的每一项外部服务（external service），说明**为什么**你会需要它、**在哪里注册**，以及把它接入所需的**具体环境变量 / 配置片段**。

文档的写法兼顾 AI 智能体（查找可执行的 `bash` 代码块与 JSON 路径）和人类用户（查找"为什么要用"），双方都能使用。

---

## TL;DR —— 能力矩阵

| 你想要…… | 至少需要 |
|---|---|
| 长期记忆 + 召回（核心功能） | **Postgres + pgvector** + 一个**嵌入服务端点**（Jina 免费额度即可） |
| 实时仪表盘 + HTTP 数据摄入 | 仅需核心（再加一个随机的 `NEXTCLAW_DASH_TOKEN`） |
| 夜间反思（记忆整合） | 核心 + 一个 **LLM 端点**（Gemini 免费版或 OpenAI） |
| Telegram 群组**主持人（Moderator）**（编排者-工作者模式，认领 `@提及`） | 核心 + 一个 **Telegram bot token** + **Gemini**（或 OpenAI） |
| 工作者的 `web_search` 工具 | 上述内容 + **Tavily API 密钥** 或一个 credbroker |
| 工作者的 `memory_search` 工具 | 核心（无需额外服务） |
| 在同一个 Postgres 上实现多智能体隔离 | 核心；只需为每个安装实例设置 `cfg.moderator.agentId` |

第一行以外的一切都是可选的。仅靠核心，插件即可运行；接入更多服务可解锁更多行为。

---

## 1. Postgres + pgvector（必需）

**为什么：** 存储所有分块（chunk）、嵌入、审计与缓存。nextclaw 只是数据库之上的一层薄封装——没有它，任何内存中的状态都无法在重启后存活。

**获取方式：** 选择最适合你环境的一种。

### 方案 A —— Neon（云端，免费 0.5 GB，零本地依赖）

1. 访问 <https://neon.tech> → 用 GitHub 注册（无需信用卡）→ **Create project**
2. 复制连接字符串（形如 `postgresql://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require`）
3. 在 Neon 的 **SQL Editor** 标签页中运行：

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS btree_gin;
   ```

4. 导出：
   ```bash
   export PG_URL="postgresql://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require"
   ```

> Neon 会自动挂起空闲的数据库。长时间空闲后的第一次查询会将其唤醒（约 1–2 秒）；之后的查询又会恢复快速。

### 方案 B —— Docker（本地，完全可控）

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

仅绑定到 `127.0.0.1:55432`，绝不暴露在公网接口上。数据卷 `nextclaw_pg` 会在重启之间持久保存数据。

### 验证（两种方案通用）

```bash
psql "$PG_URL" -c "SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','btree_gin');"
# Must list all three. Install psql via `brew install libpq` or `apt-get install postgresql-client` if missing.
```

**配置（位于 `~/.openclaw/openclaw.json` → `plugins.entries.memory-postgres.config`）：**

```jsonc
"postgres": { "url": "<your $PG_URL>" }
```

**已经在别处有 Postgres 了？** 那就跳过以上两种方案；只需给插件一个已安装 `vector`、`pg_trgm` 和 `btree_gin` 扩展的 URL 即可。插件会在首次启动时运行自己的数据库 schema 迁移（`dist/src/storage/schema/*.sql`）。

---

## 2. Jina 嵌入 —— 推荐的默认选项（免费）

**为什么：** 把文本转换成 1024 维向量，从而让语义召回得以工作。Jina 的免费额度（free tier）每个密钥约覆盖 100 万 token（约等于典型聊天场景下 500 天的用量）。对中英文都表现良好。

**获取密钥：**

1. 打开 [https://jina.ai/embeddings](https://jina.ai/embeddings/)
2. 点击 **"Get API key for free"** —— 无需信用卡
3. 复制密钥（形如 `jina_xxxxxxxxxxxxxxxxxx`）

**设置环境变量：**

```bash
export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Persist it:
echo 'export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> ~/.bashrc
```

**验证：**

```bash
curl -sS https://api.jina.ai/v1/embeddings \
  -H "Authorization: Bearer $JINA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"jina-embeddings-v3","input":["hello"]}' | head -c 200
# Must return JSON with a data[].embedding array
```

**配置：** *无需任何配置块* —— 当 openclaw.json 中省略 `embedding` 时，插件默认使用 Jina（`format=jina`、`baseUrl=https://api.jina.ai`、`apiKeyEnv=JINA_API_KEY`）。

---

## 2b. 备选方案：Ollama（自托管，无需 API 密钥）

**为什么：** 没有速率限制、完全私密、可离线运行。需要约 1–4 GB 内存/显存。

**获取方式：**

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh
# macOS
brew install ollama   # or download from https://ollama.com

ollama serve &                              # listens on 127.0.0.1:11434
ollama pull qwen3-embedding:0.6b            # ~1 GB, multilingual, recommended
# OR
ollama pull nomic-embed-text                # ~274 MB, English-leaning
```

**验证：**

```bash
curl -sS http://127.0.0.1:11434/api/embed \
  -d '{"model":"qwen3-embedding:0.6b","input":"hello"}' | head -c 200
```

**配置：**

```jsonc
"embedding": {
  "format": "ollama",
  "model": "qwen3-embedding:0.6b"
}
```

`baseUrl` 默认为 `http://127.0.0.1:11434`；若 Ollama 运行在其他主机上，请覆盖此值。

---

## 2c. 备选方案：OpenAI 兼容接口（任意提供方、vLLM、TEI 等）

```bash
export OPENAI_API_KEY=sk-...
```

```jsonc
"embedding": {
  "format": "openai",
  "baseUrl": "https://api.openai.com",
  "model": "text-embedding-3-small",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

> ⚠️ **嵌入维度是单向的。** 它会在首次摄入时被自动检测，并锁定进 HNSW 索引。从 `jina-embeddings-v3`（1024 维）切换到 `qwen3-embedding:4b`（4096 维）需要执行 `TRUNCATE semantic.chunks RESTART IDENTITY CASCADE` 并重新摄入所有数据。请挑选一个你能用上几个月的模型。

---

## 3. Gemini（Google AI Studio）—— 供主持人与反思使用的免费 LLM

**为什么：** 主持人（Moderator）的决策循环和夜间反思守护进程都需要一个对话 LLM。Gemini 2.5 Flash 拥有慷慨的免费额度（每个密钥约 250 RPD）。

**获取密钥：**

1. 打开 [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. 用 Google 账号登录
3. **Create API key** → 复制（形如 `AIza...`）

**设置环境变量：**

```bash
export GEMINI_API_KEY=AIza...
echo 'export GEMINI_API_KEY=AIza...' >> ~/.bashrc
```

**验证：**

```bash
curl -sS "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"say hi"}]}]}' | head -c 200
```

**配置 —— 主持人：**

```jsonc
"moderator": {
  "enabled": true,
  "model": {
    "format": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

**配置 —— 反思（可选，夜间摘要）：**

```jsonc
"reflection": {
  "enabled": true,
  "model": {
    "format": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

---

## 3b. 备选 LLM：OpenAI / OpenAI 兼容接口

```bash
export OPENAI_API_KEY=sk-...
```

```jsonc
"moderator": {
  "enabled": true,
  "model": {
    "format": "openai",
    "baseUrl": "https://api.openai.com",
    "model": "gpt-5.5",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

> ⚠️ **工具调用（Tool-calling）**：目前工作者的工具调用路径（`web_search`、`memory_search`）只完整支持 Gemini 的 `:generateContent` API。使用 `format=openai` 时，工作者会以单次（single-shot）模式运行——回答仍然有效，但不会在回答中途进行工具调用。OpenAI 的工具格式是一个待办项（TODO）。如果你现在就想要联网搜索，请使用 Gemini。

---

## 4. Telegram bot —— 主持人必需

**为什么：** 主持人活动在 Telegram 群组中。没有 bot 账号，主持人就没有任何可认领或可回复的对象。

**获取 token：**

1. 打开 Telegram，搜索 **`@BotFather`**，开始一段对话
2. 发送 `/newbot`
3. 按提示操作——挑选一个显示名称（例如 `My Tutor Bot`）和一个用户名（必须以 `bot` 结尾，例如 `my_tutor_bot`）
4. BotFather 会回复一个形如 `1234567890:AAH...long-string...` 的 token。**把它复制下来。**

**获取你自己的用户 id（用于仅限所有者的命令）：**

1. 在 Telegram 中与 **`@userinfobot`** 对话
2. 它会回复你的数字用户 id（例如 `8064984663`）

**把 bot 加入你的群组：**

1. 打开群组 → 添加成员 → 搜索 bot 的用户名 → 添加
2. 确保 bot 能读取消息：默认情况下，群组中的 Telegram bot **只能看到 @提及它的消息**或对它消息的回复。这恰恰是主持人想要的——群内闲聊保持私密，只有明确的提及才会被处理。
3. 如果你希望 bot 看到群里的所有消息（对主持人而言**不推荐**），可使用 BotFather → `/setprivacy` → Disable。

**配置：**

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

**验证 bot 是否存活：**

```bash
curl -sS "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
# Should return {"ok":true,"result":{"id":...,"username":"my_tutor_bot",...}}
```

在 OpenClaw 携带此配置重启后，前往你的群组并发送 `@my_tutor_bot hello`。观察 `tail -f /tmp/openclaw/openclaw-*.log`，留意 `[moderator/hook] before_dispatch CLAIMED` 这一行。

---

## 5. Tavily —— 供主持人 `web_search` 工具使用的联网搜索

**为什么：** 工作者的 `web_search` 工具封装了 Tavily。没有它，主持人只能凭记忆 + LLM 训练数据作答，无法获取当前信息（新闻、最新版本号等）。工作者会如实说明这一点。

### 已经配置好 OpenClaw 的 tavily 插件了？那就大功告成。

如果你的 `openclaw.json` 中已经有：
```jsonc
"plugins": { "entries": { "tavily": { "enabled": true, "config": { "webSearch": { "apiKey": "tvly-..." } } } } }
```
（这是 OpenClaw 存放 codex 侧 tavily 密钥的标准位置——其设置向导会把它放在这里）

**那么 nextclaw 的工作者会自动复用同一个密钥。** 无需 `TAVILY_API_KEY` 环境变量，也无需额外配置。在插件启动时，我们会读取 `plugins.entries.tavily.config.webSearch.apiKey` 并将其传给工作者的工具运行时。这样 codex 和我们的主持人工作者都能用同一份已配置的凭据访问 Tavily。

工作者的解析优先级（先匹配者胜出）：
1. `cfg.credbroker.tavilyUrl`（如果你有一个 Tailscale 凭据代理（credbroker））
2. OpenClaw 的 `plugins.entries.tavily.config.webSearch.apiKey` ← **大多数用户落在这里**
3. `NEXTCLAW_WEB_SEARCH_URL` 环境变量
4. `TAVILY_API_KEY` 环境变量
5. 什么都没配置 → `web_search` 向 LLM 返回一个如实的错误；LLM 会告诉用户它无法搜索。

### 还没有 Tavily 密钥？

1. 打开 [https://app.tavily.com/](https://app.tavily.com/)
2. 用 Google / GitHub / 邮箱登录
3. 侧边栏中的 **API Keys** → **Create new key**（免费额度：1,000 次搜索 / 月）
4. 复制（形如 `tvly-...`）

**配置方式（方案 A —— 推荐，同时也给 codex 提供联网搜索）：**

把以下内容加入 `openclaw.json`，让 codex 和主持人工作者复用同一个密钥：

```jsonc
"plugins": {
  "entries": {
    "tavily": {
      "enabled": true,
      "config": {
        "webSearch": { "apiKey": "tvly-..." }
      }
    }
  }
}
```

**配置方式（方案 B —— 仅主持人，不为 codex 提供联网搜索）：**

```bash
export TAVILY_API_KEY=tvly-...
echo 'export TAVILY_API_KEY=tvly-...' >> ~/.bashrc
```

**验证：**

```bash
curl -sS https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"tvly-...\",\"query\":\"openclaw github\",\"max_results\":2}" | head -c 200
# Returns JSON with results[]
```

### 为什么存在两条路径

OpenClaw 的 tavily 插件为 **codex 智能体循环** 注册了一个搜索工具——codex 通过 `WebSearchProviderPlugin.createTool()` 拾取它。而我们的主持人工作者是 codex 循环之外的**一次独立 LLM 调用**（它是调度专家的编排者，而非 codex 本身）。所以严格来说，我们运行的是自己的 Tavily 请求。我们只是复用了 codex 已配置的密钥，免得运维人员要操心两遍。

---

## 5b. Cloudflare Tunnel（可选 —— 为 Telegram WebApp 提供公网仪表盘 URL）

**为什么：** 要从 **Telegram WebApp 按钮**（`/dashboard` bot 命令）打开记忆仪表盘，仪表盘需要一个公网 HTTPS URL。Cloudflare Tunnel 免费提供一个，无需端口转发，也不需要公网 IP。Telegram 的 WebApp SDK 要求使用 HTTPS——`http://` URL 会被静默拒绝。

### 快速路径（5 分钟，临时 URL）

```bash
mkdir -p ~/bin
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') -o ~/bin/cloudflared
chmod +x ~/bin/cloudflared
~/bin/cloudflared tunnel --url http://localhost:8765 --no-autoupdate
# Outputs: Your quick Tunnel has been created! Visit it at:
#   https://random-words-here.trycloudflare.com
```

把该 URL 粘贴进 `openclaw.json`：

```jsonc
"dashboard": {
  "enabled": true, "host": "127.0.0.1", "port": 8765,
  "tokenEnv": "NEXTCLAW_DASH_TOKEN",
  "publicUrl": "https://random-words-here.trycloudflare.com"
}
```

重启 OpenClaw。向你的 bot 发送 `/dashboard`。点击那个按钮。

> ⚠️ 快速隧道（quick-tunnel）的 URL **每次 cloudflared 重启时都会改变**。用于测试没问题；生产环境请使用具名隧道（named tunnel，见下文）。

### 稳定路径（具名隧道 —— 一次性设置，约 15 分钟）

需要：一个 Cloudflare 账号（免费）+ 一个托管在 Cloudflare DNS 上的域名。

```bash
~/bin/cloudflared tunnel login                            # browser auth
~/bin/cloudflared tunnel create memory-dashboard          # creates UUID
~/bin/cloudflared tunnel route dns memory-dashboard memory.yourdomain.com
# Create ~/.cloudflared/config.yml:
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: memory-dashboard
credentials-file: /home/youruser/.cloudflared/<UUID>.json
ingress:
  - hostname: memory.yourdomain.com
    service: http://localhost:8765
  - service: http_status:404
EOF
# Run as systemd --user service:
~/bin/cloudflared service install
sudo systemctl start cloudflared
```

现在 `https://memory.yourdomain.com` 在重启之间保持稳定。更新 openclaw.json 中的 `publicUrl`，然后就别再去动它了。

### 鉴权机制（不泄露 token）

- 仪表盘的 `/api/*` 端点会拒绝任何不带有效 token（`X-Token` 请求头 / `?token=` 查询参数）的请求。
- 当 Telegram 打开 WebApp 时，它会注入 `window.Telegram.WebApp.initData`——一个经过签名的载荷，包含用户的 Telegram id + auth_date + HMAC。
- 仪表盘的 JS 会把该 initData POST 到 `/api/auth/telegram`。服务端用 bot token 进行 HMAC 校验，确认 `user.id` 在 `commands.ownerAllowFrom` 中，并签发一个**按用户隔离的会话 token**（保存在内存中，TTL 为 1 小时）。
- 会话 token 会作为 `X-Token` 随后续所有调用一起发送。URL 中没有全局 token，意味着**转发该链接不会泄露访问权限**。

---

## 6. Credbroker（可选 —— 仅适用于多主机部署）

**为什么：** 如果你在一个 Tailscale tailnet 上有多台机器，并且希望**调用方主机上零 API 密钥**，那就在一台可信的 "mainserver" 上运行一个凭据代理（credential broker），让所有机器都指向它。代理会基于 Tailscale 身份从其保险库中注入凭据。

这是一种高级用户的配置。如果你还没有这样的设置，可以跳过。

**配置：**

```jsonc
"credbroker": {
  "baseUrl": "http://<mainserver-tailscale-ip>:8800",
  "services": {
    "embedding": "local-embed",
    "gemini":    "gemini",
    "tavily":    "tavily"
  }
}
```

设置后，任何**被省略**的单服务 `baseUrl` 都会自动推导为 `${baseUrl}/v1/proxy/${service}`。显式指定的 URL 始终优先。`services` 块是可选的——其默认值与常见的 credbroker 设置相匹配。

**使用 credbroker 时**，所有单服务的 `baseUrl` + `apiKeyEnv` 字段都可以省去：

```jsonc
"credbroker": { "baseUrl": "http://100.x.y.z:8800" },
"embedding":  { "format": "openai", "model": "qwen3-embedding:0.6b" },
"moderator":  { "enabled": true, "model": { "format": "gemini", "model": "gemini-2.5-flash" } },
"reflection": { "enabled": true, "model": { "format": "gemini", "model": "gemini-2.5-flash" } }
```

搭建 credbroker 本身超出了本文档的范围——请参阅你所在 tailnet 的文档。

---

## 7. OpenClaw（宿主运行时 —— 必需）

nextclaw 是 [OpenClaw](https://github.com/openclaw/openclaw) 的一个插件，并非独立程序。OpenClaw 提供了智能体运行时、通道入口（channel ingress）、钩子系统（hook system）和 CLI。它自带了 Node 运行时，因此没有额外的前置依赖。

**安装：**

```bash
# macOS / Linux
curl -fsSL https://openclaw.ai/install.sh | bash
# Windows PowerShell
#   iwr -useb https://openclaw.ai/install.ps1 | iex

# Install the gateway daemon (launchd/systemd user service)
openclaw onboard --install-daemon
```

**验证：**

```bash
openclaw --version    # 2026.x.x
openclaw doctor
```

**在其之上安装 nextclaw：**

```bash
openclaw plugins install git:github.com/NextAgentBC/nextclaw
openclaw plugins list | grep memory-postgres   # confirm it's discovered
```

---

## 快速参考 —— 环境变量

| 环境变量 | 服务 | 是否可选？ |
|---|---|---|
| `JINA_API_KEY` | Jina 嵌入 | 若使用 Ollama/OpenAI 则可选 |
| `GEMINI_API_KEY` | Gemini LLM（主持人 + 反思） | 若禁用主持人或改用 OpenAI 则可选 |
| `OPENAI_API_KEY` | OpenAI（LLM 或嵌入） | 可选，作为 Gemini/Jina 的替代 |
| `TAVILY_API_KEY` | 联网搜索工具 | 可选——没有它则该功能降级为"无联网访问" |
| `NEXTCLAW_DASH_TOKEN` | 仪表盘鉴权 | 若启用仪表盘则必需 |
| `NEXTCLAW_WEB_SEARCH_URL` | 覆盖 Tavily 端点 | 仅限高级用户 |

---

## 致代为用户安装 nextclaw 的 AI 智能体

如果你是一个正在帮用户安装 nextclaw 的 LLM 智能体，以下是推荐的对话流程：

1. **询问用户想要什么** —— 只要记忆？还是也要一个 Telegram 主持人？或者还要联网搜索？参考本文档顶部的能力矩阵。
2. **了解用户已经有什么** —— Docker？Node？现成的 Postgres？一个 Telegram bot？现有的 API 密钥？
3. **按依赖顺序逐项走查服务：** Postgres → 嵌入 →（若需主持人）LLM →（若需主持人）Telegram bot →（若需联网搜索）Tavily。
4. **对每一项服务：** 大声读出"为什么"那一句（让用户清楚自己正在同意什么），然后要么从用户那里获取密钥，要么用本文档中给出的链接 URL 引导其完成注册。
5. **用 `curl` 片段验证每一步**，再进行下一步。尽早发现错误的 API 密钥能省下日后的调试时间。
6. **最终配置：** 把所有接好的配置块汇集到 `~/.openclaw/openclaw.json` 中。启动 OpenClaw。运行 [INSTALL.zh-CN.md ⑦](INSTALL.zh-CN.md#-start-then-verify-with-a-smoke-test) 中的冒烟测试 1。

冒烟测试必须通过，才能宣告成功。如果召回返回 0 条结果，那很可能是嵌入服务没接对——请先检查 `/api/recent` 是否有摄入错误。
