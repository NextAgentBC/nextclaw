# nextclaw — 0 → 1 installation walkthrough

This is the **fresh-machine** guide. If you already have OpenClaw + an
embedding endpoint running, jump to step ④.

Tested on Ubuntu 24.04 + macOS 14. Should work on any host with Docker +
Node 22+. Estimated time: **30 minutes** end to end including downloads.

---

## ① Install OpenClaw

nextclaw is a *plugin* for [OpenClaw](https://github.com/openclaw/openclaw),
not a standalone program. You install OpenClaw first, then drop nextclaw
into its `extensions/` directory.

```bash
# Clone OpenClaw at a stable tag (replace with the latest you want)
git clone --depth 1 https://github.com/openclaw/openclaw.git ~/openclaw
cd ~/openclaw
pnpm install
pnpm build
```

Verify:

```bash
pnpm openclaw --version    # should print 2026.x.x
pnpm openclaw doctor       # should mostly pass; warnings about disabled bundled plugins are fine
```

> If `pnpm` is not on your machine: `npm i -g pnpm@latest` then retry.

---

## ② Start Postgres + pgvector

```bash
git clone https://github.com/NextAgentBC/nextclaw.git ~/nextclaw-tmp
cd ~/nextclaw-tmp/dev
docker compose up -d
```

Verify:

```bash
docker exec -e PGPASSWORD=nextclaw nextclaw-pg \
  psql -U nextclaw -d nextclaw -c "SELECT version(); SELECT extname FROM pg_extension;"
# Should list: vector, pg_trgm, btree_gin
```

> The container binds **127.0.0.1:55432** on the host, never the public
> interface. Volume `nextclaw_pg` persists across restarts. If you need to
> wipe and start over: `docker compose down -v`.

---

## ③ Stand up an embedding endpoint

nextclaw needs an OpenAI-compatible embeddings endpoint. The simplest is
**Ollama** running `nomic-embed-text` locally (small, fast, free).

```bash
# Linux (one-liner installer)
curl -fsSL https://ollama.com/install.sh | sh
# macOS: download from https://ollama.com (or: brew install ollama)

ollama serve &                          # background, listens on 127.0.0.1:11434
ollama pull nomic-embed-text            # 274 MB, takes ~30s on a decent connection
```

Verify:

```bash
curl -sS http://127.0.0.1:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text","input":"hello"}' | head -c 200
# Should return JSON with a "data": [{ "embedding": [...] }] array
```

> **Larger / Chinese-friendly alternatives**: if you want better Chinese
> recall and have GPU memory, swap to `qwen3-embedding:0.6b` (or 4B/8B).
> The dimension is detected on first embed call and locked into the HNSW
> index, so picking the dimension up front is **not** required.

---

## ④ Install nextclaw into OpenClaw's `extensions/`

```bash
mv ~/nextclaw-tmp ~/openclaw/extensions/memory-postgres
cd ~/openclaw
pnpm install                # picks up the new extension's package.json
pnpm build
```

> The directory **must** be named `memory-postgres` (not `nextclaw`)
> because OpenClaw's `plugins.slots.memory` convention looks up plugins
> by entry id and our manifest sets the id to `memory-postgres`. You can
> rename later if you fork the manifest, but use this name for the
> default install.

---

## ⑤ Configure `~/.openclaw/openclaw.json`

Create or edit this file:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace"
      }
    ]
  },
  "plugins": {
    "slots": { "memory": "memory-postgres" },
    "entries": {
      "memory-postgres": {
        "enabled": true,
        "config": {
          "postgres": {
            "url": "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw"
          },
          "embedding": {
            "provider": "ollama",
            "model": "nomic-embed-text",
            "baseUrl": "http://127.0.0.1:11434",
            "format": "openai",
            "path": "/v1/embeddings",
            "maxEmbedChars": 2000
          },
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
        }
      }
    }
  }
}
```

> Replace `~` with your absolute home path if your OpenClaw build doesn't
> expand it (`/home/<you>` on Linux, `/Users/<you>` on macOS).

---

## ⑥ Set up workspace persona files (optional but recommended)

OpenClaw loads markdown from your agent's workspace into the system prompt.
Without these, the agent has no persona.

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

> AGENTS.md ships with OpenClaw and tells the agent how to behave in
> general. SOUL.md / IDENTITY.md / USER.md are per-user customization.
> If you skip this step the bot still works but has a generic persona.

---

## ⑦ Start, then verify with a smoke test

```bash
# Generate a dashboard token (any random string)
export NEXTCLAW_DASH_TOKEN=$(openssl rand -hex 24)

# Start the gateway
pnpm openclaw gateway start
# Or, if you've installed it as a systemd service: openclaw gateway restart
```

On first start, the migration runner applies all DDL files in
`extensions/memory-postgres/src/storage/schema/*.sql`. Watch for:

```
memory-postgres: capability + tools registered (memory_search, memory_store, dashboard, ...)
memory-postgres: transcript-watcher started — id=agent-main ...
http server listening
```

### Smoke test 1 — write + recall via the universal HTTP gateway

```bash
# Write
curl -sS -X POST http://127.0.0.1:8765/api/ingest \
  -H "Authorization: Bearer $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"My favorite Postgres extension is pgvector.","source":"smoke","agentId":"main"}' \
  | python3 -m json.tool

# Recall
curl -sS -X POST http://127.0.0.1:8765/api/recall \
  -H "Authorization: Bearer $NEXTCLAW_DASH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is my favorite Postgres extension?","agentId":"main"}' \
  | python3 -m json.tool
```

Recall should return the chunk with `hitTier: "t2_hybrid"`. Subsequent
identical recalls within 5 minutes hit `t1` cache (~1ms).

### Smoke test 2 — open the dashboard

```
http://127.0.0.1:8765/?token=$NEXTCLAW_DASH_TOKEN
```

Token is captured to `sessionStorage` and forwarded as `X-Token` on
subsequent fetches. You should see:

- KPIs: 1 ingest, 1 recall in last 24h
- Live event stream: 2 events (1 ingest, 1 recall)
- Recent ingests table: the chunk you just wrote
- Recent recalls table: the query you just made

If any panel is empty, check **Troubleshooting** at the bottom.

---

## ⑧ Add a Discord bot (optional)

If you want a chat-bot frontend and not just the HTTP API:

### 8.1 Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**
2. Bot tab → **Reset Token** → save the token (one-time view)
3. Privileged Gateway Intents → enable **Message Content Intent**
4. OAuth2 → URL Generator → check `bot` scope; permissions: View Channel, Send Messages, Read Message History → invite the bot to your server

### 8.2 Get the IDs you need

In Discord client → User Settings → Advanced → **Developer Mode: ON**.
Then right-click → **Copy ID** on:

- the server (guild) you invited the bot to
- the channel you want it to respond in

### 8.3 Wire it into `openclaw.json`

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

> `groupPolicy: "allowlist"` + `allowFrom: ["*"]` means: **any user** can
> talk to the bot in the listed guilds. Tighten by replacing `"*"` with
> specific Discord user IDs.

> `requireMention: true` means the bot only responds when explicitly
> @-mentioned. Combine with `allowBots: "mentions"` if you want OTHER
> bots (e.g. a Linux IRC bridge bot) to also be able to ping it.

Restart the gateway, go to your Discord channel, **@your-bot hi** and
watch the dashboard light up.

---

## ⑨ Multi-agent hard isolation (optional)

If you want a public-facing agent (e.g. a community Discord) that
**physically cannot** see your private memory:

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

Create a separate workspace dir + persona files:

```bash
mkdir -p ~/.openclaw/workspace-club ~/.openclaw/agents/club/sessions
# Create SOUL.md / IDENTITY.md (no USER.md — public agent shouldn't know your private info)
```

Verification — the club agent's `agent_id='club'` chunks are filtered at the
SQL level on every recall path. A `WHERE c.agent_id = $X` clause stops
cross-agent reads even if the prompt is adversarial. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full isolation model.

---

## ⑩ Troubleshooting

**Migration error on first start**
```
ERROR: extension "vector" is not available
```
→ The pgvector extension didn't install. Confirm you used the
`pgvector/pgvector:pg16` image (not vanilla `postgres:16`). Re-run
`docker compose down -v && docker compose up -d`.

**Dashboard says "unauthorized" or 401**
→ Token wasn't passed. Open the URL with `?token=$NEXTCLAW_DASH_TOKEN`
once; it's then stored in browser `sessionStorage` and forwarded as
`X-Token` on subsequent loads. Tab close clears it.

**Bot doesn't reply on Discord**
→ Check, in order:
1. `pnpm openclaw doctor` — any "channel allowlist drops" warnings?
2. Did you @-mention by **user** id, not **role** id? Some clients
   autocomplete to a role with the same name as the bot. Disable
   `requireMention` temporarily to test.
3. `tail -f /tmp/openclaw/openclaw-*.log | grep discord` — look for
   `skipping guild message` reasons.
4. Bot has **View Channel + Send Messages** permission on that channel?

**Recall always returns 0 results even after writes**
→ Embedding endpoint not reachable. Test `curl /v1/embeddings` directly.
Check `/api/recent` for ingest events with `decision: "accepted"` and
non-zero `latency_ms` — if writes are getting in but recall finds
nothing, the HNSW index probably wasn't built (it's lazy on first
embed). Restart the gateway and re-write one chunk.

**`<mem>{...}</mem>` text leaks into bot's reply on Discord**
→ Your OpenClaw is older than May 2026. Pull the upstream
`stripInternalRuntimeScaffolding` change or set `prompting.sidecar:
"off"` in the memory-postgres config.

**Dashboard panel is empty / events not streaming**
→ PG `LISTEN/NOTIFY` may be blocked. Check
`SELECT pg_notify('test', 'hello')` works directly. SSE keeps a
connection per client; reload the dashboard tab.

**`pnpm build` fails on the extension**
→ Make sure the `peerDependencies: openclaw >= 2026.4.25` is satisfied.
If you cloned a newer OpenClaw, you may hit Plugin SDK changes; pin
OpenClaw to a known-good tag and rebuild.

---

## Where to go next

- [ARCHITECTURE.md](ARCHITECTURE.md) — the 4-tier recall model, Stage 0–6 pipeline, multi-key indexing, isolation guarantees
- [CONFIG.md](CONFIG.md) — every config field, default, and tuning advice
- [LIVE_TESTS.md](LIVE_TESTS.md) — how to run the live test suite against a real PG + embedding endpoint
- Open an issue if anything in this guide didn't work for you: https://github.com/NextAgentBC/nextclaw/issues
