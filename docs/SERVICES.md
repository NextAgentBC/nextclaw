# External services nextclaw uses

This doc lists every external service nextclaw can talk to, **why** you'd want it, **where to sign up**, and the **exact env var / config snippet** to wire it in.

Written so both an AI agent (looking for `bash` blocks + JSON paths to act on) and a human (looking for the "why") can use it.

---

## TL;DR — capability matrix

| You want… | You need at minimum |
|---|---|
| Long-term memory + recall (the core) | **Postgres + pgvector** + an **embedding endpoint** (Jina free is fine) |
| Real-time dashboard + HTTP ingest | Just the core (add a random `NEXTCLAW_DASH_TOKEN`) |
| Nightly reflection (memory consolidation) | Core + an **LLM endpoint** (Gemini free or OpenAI) |
| Telegram-group **Moderator** (orchestrator-worker, claims `@mentions`) | Core + a **Telegram bot token** + **Gemini** (or OpenAI) |
| Worker `web_search` tool | Above + **Tavily API key** OR a credbroker |
| Worker `memory_search` tool | Core (no extra service) |
| Multi-agent isolation across one Postgres | Core; just set `cfg.moderator.agentId` per install |

Everything past row 1 is optional. The plugin runs with just core; further services unlock more behavior.

---

## 1. Postgres + pgvector (required)

**Why:** stores all chunks, embeddings, audit, cache. nextclaw is a thin layer over the DB — no in-memory state survives restart without it.

**Get it:**

```bash
# Bundled docker compose (recommended for a clean install)
git clone https://github.com/NextAgentBC/nextclaw.git ~/nextclaw-tmp
cd ~/nextclaw-tmp/dev
docker compose up -d
```

This brings up `pgvector/pgvector:pg16` bound to `127.0.0.1:55432`, never the public interface. Volume `nextclaw_pg` persists across restarts.

**Verify:**

```bash
docker exec -e PGPASSWORD=nextclaw nextclaw-pg \
  psql -U nextclaw -d nextclaw -c "SELECT extname FROM pg_extension;"
# Must list: vector, pg_trgm, btree_gin
```

**Config (in `~/.openclaw/openclaw.json` → `plugins.entries.memory-postgres.config`):**

```jsonc
"postgres": { "url": "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw" }
```

**Already have Postgres?** Skip the docker step; just give the plugin a URL with `vector`, `pg_trgm`, and `btree_gin` extensions installed. The plugin runs its own schema migrations on first start (`src/storage/schema/*.sql`).

---

## 2. Jina embeddings — recommended default (free)

**Why:** turns text into 1024-dim vectors so semantic recall works. Jina's free tier covers ~1M tokens per key (≈ 500 days of typical chat use). Works well for Chinese + English.

**Get a key:**

1. Open [https://jina.ai/embeddings](https://jina.ai/embeddings/)
2. Click **"Get API key for free"** — no credit card
3. Copy the key (looks like `jina_xxxxxxxxxxxxxxxxxx`)

**Set the env var:**

```bash
export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Persist it:
echo 'export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> ~/.bashrc
```

**Verify:**

```bash
curl -sS https://api.jina.ai/v1/embeddings \
  -H "Authorization: Bearer $JINA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"jina-embeddings-v3","input":["hello"]}' | head -c 200
# Must return JSON with a data[].embedding array
```

**Config:** *no config block needed* — when `embedding` is omitted from openclaw.json, the plugin defaults to Jina (`format=jina`, `baseUrl=https://api.jina.ai`, `apiKeyEnv=JINA_API_KEY`).

---

## 2b. Alternative: Ollama (self-hosted, no API key)

**Why:** zero rate limits, full privacy, runs offline. Needs ~1–4 GB RAM/GPU.

**Get it:**

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

**Verify:**

```bash
curl -sS http://127.0.0.1:11434/api/embed \
  -d '{"model":"qwen3-embedding:0.6b","input":"hello"}' | head -c 200
```

**Config:**

```jsonc
"embedding": {
  "format": "ollama",
  "model": "qwen3-embedding:0.6b"
}
```

`baseUrl` defaults to `http://127.0.0.1:11434`; override if Ollama is on another host.

---

## 2c. Alternative: OpenAI-compatible (any provider, vLLM, TEI, etc.)

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

> ⚠️ **Embedding dimension is one-way.** Auto-detected on first ingest and locked into the HNSW index. Switching from `jina-embeddings-v3` (1024d) to `qwen3-embedding:4b` (4096d) requires `TRUNCATE semantic.chunks RESTART IDENTITY CASCADE` and re-ingesting everything. Pick a model you can live with for a few months.

---

## 3. Gemini (Google AI Studio) — free LLM for Moderator + reflection

**Why:** the Moderator decision loop and the nightly reflection daemon both need a chat LLM. Gemini 2.5 Flash has a generous free tier (~250 RPD per key).

**Get a key:**

1. Open [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in with a Google account
3. **Create API key** → copy (looks like `AIza...`)

**Set the env var:**

```bash
export GEMINI_API_KEY=AIza...
echo 'export GEMINI_API_KEY=AIza...' >> ~/.bashrc
```

**Verify:**

```bash
curl -sS "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"say hi"}]}]}' | head -c 200
```

**Config — Moderator:**

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

**Config — reflection (optional, nightly summary):**

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

## 3b. Alternative LLM: OpenAI / OpenAI-compatible

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

> ⚠️ **Tool-calling**: today the worker tool-call path (`web_search`, `memory_search`) only fully supports Gemini's `:generateContent` API. With `format=openai` the worker runs in single-shot mode — answers will still work, but no mid-answer tool calls. OpenAI tool format is a TODO. If you want web search now, use Gemini.

---

## 4. Telegram bot — required for Moderator

**Why:** the Moderator lives on Telegram groups. Without a bot account, the Moderator has nothing to claim or reply to.

**Get a token:**

1. Open Telegram, search for **`@BotFather`**, start a chat
2. Send `/newbot`
3. Follow prompts — pick a display name (e.g. `My Tutor Bot`) and a username (must end in `bot`, e.g. `my_tutor_bot`)
4. BotFather replies with a token like `1234567890:AAH...long-string...`. **Copy it.**

**Get your own user id (for owner-only commands):**

1. Talk to **`@userinfobot`** in Telegram
2. It replies with your numeric user id (e.g. `8064984663`)

**Add the bot to your group:**

1. Open the group → add member → search the bot's username → add
2. Make sure the bot can read messages: by default, Telegram bots in groups **only see messages that @-mention them** or replies to their messages. That's exactly what the Moderator wants — group chatter stays private; only explicit mentions get processed.
3. If you want the bot to see all group messages (NOT recommended for the Moderator), use BotFather → `/setprivacy` → Disable.

**Config:**

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

**Verify the bot is alive:**

```bash
curl -sS "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
# Should return {"ok":true,"result":{"id":...,"username":"my_tutor_bot",...}}
```

After OpenClaw restarts with this config, go to your group and send `@my_tutor_bot hello`. Watch `tail -f /tmp/openclaw/openclaw-*.log` for the `[moderator/hook] before_dispatch CLAIMED` line.

---

## 5. Tavily — web search for the Moderator's `web_search` tool

**Why:** the worker `web_search` tool wraps Tavily. Without it, the Moderator can answer from memory + LLM training but can't pull current info (news, latest version numbers, etc.). The worker will say so honestly.

**Get a key:**

1. Open [https://app.tavily.com/](https://app.tavily.com/)
2. Sign in with Google / GitHub / email
3. **API Keys** in the sidebar → **Create new key** (free tier: 1,000 searches / month)
4. Copy (looks like `tvly-...`)

**Set the env var:**

```bash
export TAVILY_API_KEY=tvly-...
echo 'export TAVILY_API_KEY=tvly-...' >> ~/.bashrc
```

**Verify:**

```bash
curl -sS https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$TAVILY_API_KEY\",\"query\":\"openclaw github\",\"max_results\":2}" | head -c 200
# Returns JSON with results[]
```

**Config:** *no config needed* — when `TAVILY_API_KEY` is in env, the worker's web_search tool auto-uses it. If both `credbroker.baseUrl` and `TAVILY_API_KEY` are set, credbroker wins.

**If you skip this:** `web_search` returns `{"error":"web_search is not configured on this deployment..."}` to the LLM; the LLM tells the user it can't search the web; everything else still works.

---

## 6. Credbroker (optional — multi-host setups only)

**Why:** if you have multiple machines on a Tailscale tailnet and want **zero API keys on caller hosts**, run a credential broker on one trusted "mainserver" and point everything at it. The broker injects credentials from its vault based on Tailscale identity.

This is a power-user setup. If you don't already have one, skip.

**Config:**

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

When set, any per-service `baseUrl` that's **omitted** auto-derives as `${baseUrl}/v1/proxy/${service}`. Explicit URLs always win. The `services` block is optional — defaults match a common credbroker setup.

**With credbroker** all per-service `baseUrl` + `apiKeyEnv` fields can be dropped:

```jsonc
"credbroker": { "baseUrl": "http://100.x.y.z:8800" },
"embedding":  { "format": "openai", "model": "qwen3-embedding:0.6b" },
"moderator":  { "enabled": true, "model": { "format": "gemini", "model": "gemini-2.5-flash" } },
"reflection": { "enabled": true, "model": { "format": "gemini", "model": "gemini-2.5-flash" } }
```

Setting up a credbroker itself is out of scope here — see your tailnet's docs.

---

## 7. OpenClaw (host runtime — required)

nextclaw is a plugin for [OpenClaw](https://github.com/openclaw/openclaw), not standalone. OpenClaw provides the agent runtime, channel ingress, hook system, and CLI.

**Install:**

```bash
git clone --depth 1 https://github.com/openclaw/openclaw.git ~/openclaw
cd ~/openclaw && pnpm install && pnpm build
```

**Verify:**

```bash
pnpm openclaw --version    # 2026.x.x
pnpm openclaw doctor
```

If `pnpm` is missing: `npm i -g pnpm@latest`.

---

## Quick reference — env vars

| Env var | Service | Optional? |
|---|---|---|
| `JINA_API_KEY` | Jina embeddings | Optional if you use Ollama/OpenAI |
| `GEMINI_API_KEY` | Gemini LLM (Moderator + reflection) | Optional if Moderator disabled or using OpenAI |
| `OPENAI_API_KEY` | OpenAI (LLM or embeddings) | Optional alternative to Gemini/Jina |
| `TAVILY_API_KEY` | Web search tool | Optional — feature degrades to "no web access" without it |
| `NEXTCLAW_DASH_TOKEN` | Dashboard auth | Required if dashboard enabled |
| `NEXTCLAW_WEB_SEARCH_URL` | Override Tavily endpoint | Power-user only |

---

## For AI agents installing nextclaw on behalf of a user

If you're an LLM agent helping a user install nextclaw, here's the recommended dialogue flow:

1. **Ask the user what they want** — just memory? Or also a Telegram Moderator? Or web search too? Use the capability matrix at the top of this doc.
2. **Check what they already have** — Docker? Node? An existing Postgres? A Telegram bot? Existing API keys?
3. **Walk through services in dependency order:** Postgres → embedding → (if Moderator) LLM → (if Moderator) Telegram bot → (if web search) Tavily.
4. **For each service:** read aloud the "Why" sentence (so the user knows what they're agreeing to), then either get a key from them or guide them through signup using the linked URLs in this doc.
5. **Verify each step** with the `curl` snippet before moving on. Catching a wrong API key early saves debugging time later.
6. **Final config:** assemble all the wired-up blocks into `~/.openclaw/openclaw.json`. Start OpenClaw. Run smoke test 1 from [INSTALL.md ⑦](INSTALL.md#-start-then-verify-with-a-smoke-test).

The smoke test must pass before declaring success. If recall returns 0 results, the embedding service probably isn't wired right — check `/api/recent` for ingest errors first.
