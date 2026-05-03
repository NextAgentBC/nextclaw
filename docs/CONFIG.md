# nextclaw — configuration reference

Every config field, default, and tuning advice. Lives under
`plugins.entries.memory-postgres.config` in your `~/.openclaw/openclaw.json`.

The authoritative JSON Schema is in `openclaw.plugin.json`; this doc
mirrors it with explanations.

---

## `postgres`

```jsonc
"postgres": {
  "url": "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw",  // required
  "poolMax": 8,                       // default 8
  "statementTimeoutMs": 30000         // default 30s
}
```

| Field | Default | Notes |
|---|---|---|
| `url` | required | `postgres://user:pass@host:port/db` |
| `poolMax` | 8 | node-postgres pool size. Bump to 16+ if you run many concurrent ingest sources |
| `statementTimeoutMs` | 30000 | Per-statement cap. Raises a clean abort on a runaway query |

---

## `embedding`

```jsonc
"embedding": {
  "provider": "ollama",               // "ollama" | "openai" | freeform string
  "model": "nomic-embed-text",        // required
  "baseUrl": "http://127.0.0.1:11434",
  "apiKeyEnv": "OPENAI_API_KEY",      // optional; reads env var on each call
  "format": "openai",                 // "openai" | "ollama" wire format
  "path": "/v1/embeddings",
  "dims": 768,                        // optional; auto-detected on first call if omitted
  "maxEmbedChars": 2000               // truncate text before embed
}
```

| Field | Default | Notes |
|---|---|---|
| `provider` | required | Label only — used for logging |
| `model` | required | Sent in the request body. For Ollama: the pulled model name |
| `baseUrl` | required | Endpoint host, no path |
| `apiKeyEnv` | none | Env var name (not the value) holding a Bearer token. Optional |
| `format` | `"ollama"` | OpenAI's `/v1/embeddings` wraps response differently from Ollama's `/api/embeddings`. Pick the one your endpoint speaks |
| `path` | `/api/embeddings` (ollama) or `/v1/embeddings` (openai) | Endpoint path |
| `dims` | auto-detect on first call | Locks the HNSW index dimension. Don't change after first chunks are written |
| `maxEmbedChars` | 2000 | Truncates text **before** embedding. Full text is still stored in `chunks.text` and recoverable via tsvector / trgm. Reduces GPU time on long replies by 50–70% with negligible recall loss |

**Tuning**: if you have GPU memory, swap `nomic-embed-text` (768d) for
`qwen3-embedding:0.6b` (1024d) or `qwen3-embedding:4b` (4096d) for
better Chinese recall. The HNSW dim is detected and locked on first
embed call, so just clear the chunks table when changing models.

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

| Field | Default | Notes |
|---|---|---|
| `t0SizeLimit` | 50 | Per-session in-process LRU cap |
| `t1SizeLimit` | 500 | Soft cap for `cache.hot_chunks` per `user_scope`; older entries evict on write |
| `t1TtlDays` | 7 | Hot chunks past this fall back to T2 |
| `warmthDecayHalflife` | 14 days | Half-life for warmth_score decay between recalls |
| `promotionThreshold` | 2 | T2 hits before promotion to T1 |
| `primeOnSessionStart` | true | Pre-warm T0 with anchor-related chunks at session start |

**Tuning**: bump `t0SizeLimit` to 100+ for long-context conversations
where many distinct topics surface in one session.

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

| Field | Default | Notes |
|---|---|---|
| `enabled` | false | Off unless explicitly turned on |
| `host` | `127.0.0.1` | Loopback only. Anything else is a deliberate choice |
| `port` | 8765 | |
| `tokenEnv` | none | Env var name holding the dashboard token. **Required** if `host` is not loopback |

**Security**: nextclaw refuses to expose the dashboard publicly without
a token. If you need remote access, use Tailscale / Cloudflare Tunnel /
SSH tunnel and keep `host: 127.0.0.1`, **never** `0.0.0.0`.

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

`agentId` controls memory namespace isolation — chunks ingested by this
watcher get `agent_id` set to this value. Filter queries on the same
agent id to retrieve them; cross-agent queries physically can't.

`firstRunBackfillBytes`: on the very first poll of a session file (no
persisted offset), how far back to read. Avoids flooding memory with
the entire transcript history when a watcher starts for the first
time. Set to `0` to disable backfill entirely.

`dropPureQuestions`: skips user messages whose entire content is a
question (ends with `?` or 吗/呢/嘛). Useful because pure questions
rarely contain durable facts.

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

Polls the local repo every `intervalMs`, ingests new commits since
`last_sha` (persisted in `audit.plugin_meta`). Runs `git fetch` first;
make sure the daemon's user has read access to the repo and the remote.

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

For every gpt turn observed in `<agent>/sessions/*.trajectory.jsonl`,
replays the same prompt against this challenger endpoint and stores
both sides in `audit.model_comparisons`. Powers the dashboard's "Model
Comparison" panel.

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

The sidecar prompt-builder asks the agent to emit a structured
`<mem>{entities, events, preferences, metrics}</mem>` block at turn
end. The plugin parses it (Stage 2) and feeds the structured rows
straight to extraction — zero LLM cost on the structuring pass.

Auto-disables for 7 days after `consecutiveBadJsonDisableCount`
malformed JSONs in a row.

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

The Stage 4 LLM-residual path. Almost everyone leaves this off (no
residual LLM call). Set `salience.model` to a cheap local model if you
want it.

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

| Field | Default | Notes |
|---|---|---|
| `totalK` | 24 | Top-k after MMR rerank |
| `cacheRecallTtlSec` | 300 | T1 cache.recall TTL (5 min). Lower if your data churns |
| `cacheIntentTtlSec` | 3600 | Intent classification cache TTL |

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

Cold-gist consolidation. Cluster chunks that are 90+ days old, share
concept_tags / entities, and aren't pinned. Replace with a single gist
summary in `cold.gists`; original chunks marked `retention='ephemeral'`
but kept for `provenance` for 30 days.

---

## `retention`

```jsonc
"retention": {
  "ephemeralAfterDays": 90,
  "neverDecayPinned": true
}
```

After cold-gist consolidation runs, ephemeral chunks become candidates
for true deletion after this window. Pinned chunks (incl. all
health/medical) never get deleted automatically.

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

Composite 0–100 score formulas. The default weights are tuned for an
"ingest is mostly cheap, recall should be fast" workload. Adjust if
your priorities differ (e.g. raise `quality` weight if you want to
penalize low-confidence extractions more).

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

The self-tuning loop's apply policy per scope. Defaults are
conservative; nothing auto-applies until you set
`autoApplyEnabled: true`.

---

## Top-level shape

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

Anything not in this list will be rejected by the JSON Schema in
`openclaw.plugin.json` at config load time.
