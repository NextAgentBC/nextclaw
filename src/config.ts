/**
 * memory-postgres plugin config: TypeScript types + plain runtime guards.
 *
 * The authoritative schema is in openclaw.plugin.json; OpenClaw validates raw
 * config there before this module ever sees it. resolveConfig() applies
 * defaults; validateConfig() exists for tests and defensive runtime use.
 */

export type MemoryPostgresConfig = {
  postgres: {
    url: string;
    poolMax?: number;
    statementTimeoutMs?: number;
  };
  /**
   * Embedding endpoint block. Optional — when omitted, defaults to Jina's
   * free tier (`format=jina`, `model=jina-embeddings-v3`, baseUrl
   * `https://api.jina.ai`, apiKeyEnv `JINA_API_KEY`). New users only need
   * to grab a key from jina.ai and `export JINA_API_KEY=...` to get going.
   */
  embedding?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    dims?: number;
    /**
     * "jina" | "openai" | "ollama" — wire format. Default `jina`.
     * - `jina`   posts `/v1/embeddings` with `{model, input, task}` where
     *   `task` is `retrieval.passage` for ingest and `retrieval.query` for
     *   recall (asymmetric retrieval). Use with Jina's free tier as the
     *   no-setup default.
     * - `openai` posts `/v1/embeddings` with `{model, input}` — works with
     *   OpenAI, vLLM, TEI, Together, any compat endpoint.
     * - `ollama` posts `/api/embed` with `{model, input}` (input gets a
     *   qwen3 instruct prefix on the query side).
     */
    format?: "ollama" | "openai" | "jina";
    /** Optional override for the embed POST path. */
    path?: string;
    /**
     * Max characters of input text to send to the embedding endpoint. Long
     * texts get truncated to this length BEFORE embed; the full text still
     * lives in semantic.chunks.text, recoverable via tsvector / trgm.
     * Default 2000 — cuts long-reply ingest latency by 50-70% with minimal
     * recall quality loss (the gist is almost always in the first 2 KB).
     */
    maxEmbedChars?: number;
  };
  tiers?: {
    t0SizeLimit?: number;
    t1SizeLimit?: number;
    t1TtlDays?: number;
    warmthDecayHalflife?: number;
    promotionThreshold?: number;
    primeOnSessionStart?: boolean;
  };
  sidecar?: {
    enabled?: boolean;
    triggers?: {
      minUserMessageChars?: number;
      onWriteTools?: boolean;
      onNumericMention?: boolean;
      onExplicitRemember?: boolean;
    };
    consecutiveBadJsonDisableCount?: number;
  };
  gates?: Record<string, unknown>;
  recall?: Record<string, unknown>;
  compaction?: Record<string, unknown>;
  retention?: Record<string, unknown>;
  scoring?: {
    ingest?: {
      weights?: { token?: number; latency?: number; quality?: number; path?: number };
      tokenBudgetCeiling?: number;
      latencyBudgetMs?: number;
    };
    recall?: {
      weights?: { token?: number; latency?: number; tier?: number; relevance?: number };
      tokenBudgetCeiling?: number;
      latencyBudgetMs?: number;
      relevanceFollowupWindowMs?: number;
    };
  };
  tuning?: {
    autoApplyEnabled?: boolean;
    scopes?: Record<string, "auto" | "review" | "manual" | "off">;
  };
  dashboard?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    tokenEnv?: string;
  };
  /**
   * Plugin-internal git watchers. Each entry polls a local repo on its own
   * interval and ingests new commits since last_sha — fully deterministic,
   * no agent involvement. Persisted last-sha lives in audit.plugin_meta.
   */
  gitWatchers?: GitWatcherConfig[];
  /**
   * Plugin-internal transcript watchers. Each entry polls a directory of
   * session JSONL files (`~/.openclaw/agents/<agentId>/sessions/`) and
   * ingests every user / assistant message line. This is what makes the
   * recall pipeline truly "user-invisible" — every conversation turn
   * lands in memory without the agent having to call memory_store.
   */
  transcriptWatchers?: TranscriptWatcherConfig[];
  /**
   * Shadow-mode model comparators. For every gpt-5.5 turn observed in the
   * agent trajectory file, replays the same prompt against a challenger
   * chat endpoint and stores both sides in `audit.model_comparisons`. Used
   * to compare gpt-5.5 vs qwen3.6-35B etc. without affecting the live reply.
   */
  shadowComparators?: ShadowComparatorConfig[];
  /**
   * Daily reflection worker. Reads recent conversation chunks per agent
   * and asks an LLM to produce: (1) a one-paragraph reflection chunk
   * (`kind='reflection'`), and (2) a list of profile bullets (`kind='profile'`)
   * that get primed into T0 on every subsequent recall — MemGPT-style
   * "core memory". Disabled by default; opt in by setting `enabled: true`
   * and pointing `model` at an OpenAI-compat or native-Gemini endpoint.
   */
  reflection?: ReflectionConfig;
  /**
   * Moderator service (Phase C). When enabled, hooks openclaw's
   * Telegram `message_received` event and runs an orchestrator-worker
   * decision loop for every inbound message in a group / supergroup
   * (DMs pass through unchanged so the existing per-DM agent path
   * keeps working). Off by default — opt in.
   */
  moderator?: ModeratorConfig;
};

export type ModeratorConfig = {
  enabled?: boolean;
  /** LLM transport — mirrors reflection.model. Default: gpt-5.5 via OpenAI. */
  model?: {
    format: "openai" | "gemini";
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
  };
  /** Per (scope, user) burst-collapse window. Default 1500ms. */
  debounceMs?: number;
};

export type ReflectionConfig = {
  /** Master switch. Default false. */
  enabled?: boolean;
  /** How often to run the worker. Default 24h, min 1h. */
  intervalMs?: number;
  /** How far back to look for conversation chunks per run. Default 24h. */
  lookbackHours?: number;
  /** Cap total input chars to the LLM (truncates oldest to fit). Default 8000. */
  maxInputChars?: number;
  /** LLM endpoint. Two supported formats — see below. */
  model: ReflectionModelConfig;
};

export type ReflectionModelConfig = {
  /** Wire format. `openai` = standard /v1/chat/completions.
   *  `gemini` = Google native /v1beta/models/<model>:generateContent
   *  (also works when proxied through a Tailscale credential broker). */
  format: "openai" | "gemini";
  /** Base URL (no path). For credbroker gemini, e.g.
   *  http://100.79.97.110:8800/v1/proxy/gemini . */
  baseUrl: string;
  /** Model id. e.g. `gpt-4o-mini`, `gemini-2.5-flash`. */
  model: string;
  /** Optional env var holding a bearer token / api key. Skip for credbroker
   *  setups that authenticate via Tailscale identity. */
  apiKeyEnv?: string;
};

export type ShadowComparatorConfig = {
  /** Stable id (used as audit.plugin_meta key prefix). */
  id: string;
  /** Path to agent's session dir (containing *.trajectory.jsonl). */
  trajectoryDir: string;
  /** Challenger chat endpoint (OpenAI-compatible). */
  baseUrl: string;
  /** Challenger model id sent in the request body. */
  model: string;
  /** Optional Bearer token env name. */
  apiKeyEnv?: string;
  /** Poll interval. Default 30s. Min 10s. */
  intervalMs?: number;
  /** Skip turns older than this many ms at startup. Default 24h. */
  backfillWindowMs?: number;
  /** Cap output tokens for shadow runs. Default 400 (we just want the answer, not extended thinking). */
  maxOutputTokens?: number;
  /** Per-request timeout. Default 90s. */
  requestTimeoutMs?: number;
  /** Don't run shadow if user message length below this. Default 0 (always run). */
  minUserMessageChars?: number;
};

export type TranscriptWatcherConfig = {
  id: string;
  /**
   * Owning agent id — every chunk ingested by this watcher gets `agent_id`
   * set to this value, providing hard memory namespace isolation.
   * Default 'main' for back-compat.
   */
  agentId?: string;
  /** Directory containing `<sessionId>.jsonl` files. */
  dir: string;
  /** Poll interval. Default 10s. Min enforced 5s. */
  intervalMs?: number;
  /** Source label prefix; full label is `<source>:<role>`. Default "session". */
  source?: string;
  /** Cap bytes-read per tick per file. Default 256 KB. */
  maxBytesPerTick?: number;
  /** Static anchors merged into every ingested message. */
  anchors?: { cwd?: string; branch?: string };
  /**
   * On a session's FIRST poll (no persisted offset), how far back to read.
   * Avoids flooding memory with the full transcript history when watcher
   * starts for the first time. Default 64 KB ≈ a few hundred messages.
   * Set to 0 to disable backfill entirely (only catch new messages going forward).
   */
  firstRunBackfillBytes?: number;
  /** Default importance for session ingests. Default 0.35 — lower than manual writes so they decay first. */
  defaultImportance?: number;
  /** When true, skip user messages whose entire content is a question (ends with ? or 吗/呢/嘛). */
  dropPureQuestions?: boolean;
};

export type GitWatcherConfig = {
  /** Stable id; persisted last-sha key uses this. */
  id: string;
  /** Repo path on disk. */
  path: string;
  /** Branch to watch (default `main`). */
  branch?: string;
  /** Remote name (default `origin`). */
  remote?: string;
  /** How often to poll. Default 1 hour. */
  intervalMs?: number;
  /** Source label for ingested chunks. Default `git`. */
  source?: string;
  /** Static anchors merged into every ingested commit. */
  anchors?: { cwd?: string; branch?: string };
  /** Pin to a specific shell git binary; default `git`. */
  gitBinary?: string;
};

export type ResolvedMemoryPostgresConfig = {
  postgres: { url: string; poolMax: number; statementTimeoutMs: number };
  embedding: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    dims?: number;
    format?: "ollama" | "openai" | "jina";
    path?: string;
    maxEmbedChars: number;
  };
  tiers: {
    t0SizeLimit: number;
    t1SizeLimit: number;
    t1TtlDays: number;
    warmthDecayHalflife: number;
    promotionThreshold: number;
    primeOnSessionStart: boolean;
  };
  scoring: {
    ingest: {
      weights: { token: number; latency: number; quality: number; path: number };
      tokenBudgetCeiling: number;
      latencyBudgetMs: number;
    };
    recall: {
      weights: { token: number; latency: number; tier: number; relevance: number };
      tokenBudgetCeiling: number;
      latencyBudgetMs: number;
      relevanceFollowupWindowMs: number;
    };
  };
  dashboard: { enabled: boolean; host: string; port: number; tokenEnv?: string };
  tuning: { autoApplyEnabled: boolean };
  gitWatchers: ResolvedGitWatcher[];
  transcriptWatchers: ResolvedTranscriptWatcher[];
  shadowComparators: ResolvedShadowComparator[];
  reflection: ResolvedReflectionConfig;
  moderator: ResolvedModeratorConfig;
};

export type ResolvedModeratorConfig = {
  enabled: boolean;
  debounceMs: number;
  model: {
    format: "openai" | "gemini";
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
  };
};

export type ResolvedReflectionConfig = {
  enabled: boolean;
  intervalMs: number;
  lookbackHours: number;
  maxInputChars: number;
  model: {
    format: "openai" | "gemini";
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
  };
};

export type ResolvedShadowComparator = {
  id: string;
  trajectoryDir: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  intervalMs: number;
  backfillWindowMs: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  minUserMessageChars: number;
};

export type ResolvedTranscriptWatcher = {
  id: string;
  agentId: string;
  dir: string;
  intervalMs: number;
  source: string;
  maxBytesPerTick: number;
  firstRunBackfillBytes: number;
  defaultImportance: number;
  dropPureQuestions: boolean;
  anchors?: { cwd?: string; branch?: string };
};

export type ResolvedGitWatcher = {
  id: string;
  path: string;
  branch: string;
  remote: string;
  intervalMs: number;
  source: string;
  anchors: { cwd: string; branch: string };
  gitBinary: string;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

/**
 * Defensive runtime check; matches the JSON schema in openclaw.plugin.json.
 * Throws with a path-prefixed message on failure.
 */
export function validateConfig(raw: unknown): asserts raw is MemoryPostgresConfig {
  if (!isObject(raw)) {throw new Error("config: not an object");}
  const pg = (raw as MemoryPostgresConfig).postgres;
  if (!isObject(pg)) {throw new Error("config.postgres: required");}
  if (!isString(pg.url)) {throw new Error("config.postgres.url: required string");}
  // embedding block is optional in 0.2+ — omitting it implies the Jina free-tier
  // defaults (format=jina, model=jina-embeddings-v3, JINA_API_KEY env). When
  // present, only the format field is constrained; provider+model are filled
  // in by resolveConfig() based on format.
  const em = (raw as MemoryPostgresConfig).embedding;
  if (em !== undefined && !isObject(em)) {
    throw new Error("config.embedding: must be object when present");
  }
  if (em && em.format && !["jina", "openai", "ollama"].includes(em.format)) {
    throw new Error(`config.embedding.format: must be one of jina|openai|ollama, got ${em.format}`);
  }
}

export function resolveConfig(raw: MemoryPostgresConfig): ResolvedMemoryPostgresConfig {
  const tiers = raw.tiers ?? {};
  const scoring = raw.scoring ?? {};
  const ingestScoring = scoring.ingest ?? {};
  const recallScoring = scoring.recall ?? {};
  const dashboard = raw.dashboard ?? {};
  const tuning = raw.tuning ?? {};

  return {
    postgres: {
      url: raw.postgres.url,
      poolMax: num(raw.postgres.poolMax, 8),
      statementTimeoutMs: num(raw.postgres.statementTimeoutMs, 30_000),
    },
    embedding: resolveEmbeddingConfig(raw.embedding),
    tiers: {
      t0SizeLimit: num(tiers.t0SizeLimit, 50),
      t1SizeLimit: num(tiers.t1SizeLimit, 500),
      t1TtlDays: num(tiers.t1TtlDays, 7),
      warmthDecayHalflife: num(tiers.warmthDecayHalflife, 14),
      promotionThreshold: num(tiers.promotionThreshold, 2),
      primeOnSessionStart: bool(tiers.primeOnSessionStart, true),
    },
    scoring: {
      ingest: {
        weights: {
          token: num(ingestScoring.weights?.token, 0.30),
          latency: num(ingestScoring.weights?.latency, 0.20),
          quality: num(ingestScoring.weights?.quality, 0.30),
          path: num(ingestScoring.weights?.path, 0.20),
        },
        tokenBudgetCeiling: num(ingestScoring.tokenBudgetCeiling, 1000),
        latencyBudgetMs: num(ingestScoring.latencyBudgetMs, 500),
      },
      recall: {
        weights: {
          token: num(recallScoring.weights?.token, 0.25),
          latency: num(recallScoring.weights?.latency, 0.25),
          tier: num(recallScoring.weights?.tier, 0.25),
          relevance: num(recallScoring.weights?.relevance, 0.25),
        },
        tokenBudgetCeiling: num(recallScoring.tokenBudgetCeiling, 500),
        latencyBudgetMs: num(recallScoring.latencyBudgetMs, 200),
        relevanceFollowupWindowMs: num(recallScoring.relevanceFollowupWindowMs, 3_600_000),
      },
    },
    dashboard: {
      enabled: bool(dashboard.enabled, false),
      host: typeof dashboard.host === "string" ? dashboard.host : "127.0.0.1",
      port: num(dashboard.port, 8765),
      tokenEnv: dashboard.tokenEnv,
    },
    tuning: { autoApplyEnabled: bool(tuning.autoApplyEnabled, false) },
    gitWatchers: (raw.gitWatchers ?? []).map(resolveGitWatcher),
    transcriptWatchers: (raw.transcriptWatchers ?? []).map(resolveTranscriptWatcher),
    shadowComparators: (raw.shadowComparators ?? []).map(resolveShadowComparator),
    reflection: resolveReflectionConfig(raw.reflection),
    moderator: resolveModeratorConfig(raw.moderator),
  };
}

function resolveModeratorConfig(raw: ModeratorConfig | undefined): ResolvedModeratorConfig {
  const block = raw ?? ({} as ModeratorConfig);
  const modelBlock = block.model ?? ({} as NonNullable<ModeratorConfig["model"]>);
  const format = modelBlock.format === "gemini" ? "gemini" : "openai";
  return {
    enabled: bool(block.enabled, false),
    debounceMs: Math.max(100, num(block.debounceMs, 1500)),
    model: {
      format,
      baseUrl: isString(modelBlock.baseUrl) ? modelBlock.baseUrl : "",
      model: isString(modelBlock.model) ? modelBlock.model
        : format === "gemini" ? "gemini-2.5-flash" : "gpt-5.5",
      apiKeyEnv: isString(modelBlock.apiKeyEnv) ? modelBlock.apiKeyEnv : undefined,
    },
  };
}

function resolveReflectionConfig(
  raw: ReflectionConfig | undefined,
): ResolvedReflectionConfig {
  // Defaults are inert (`enabled=false`). When the user enables it without
  // a model block, we still produce a sane shape but the daemon won't start.
  const block = raw ?? ({} as ReflectionConfig);
  const modelBlock = block.model ?? ({} as ReflectionModelConfig);
  const format = modelBlock.format === "gemini" ? "gemini" : "openai";
  return {
    enabled: bool(block.enabled, false),
    intervalMs: Math.max(60 * 60 * 1000, num(block.intervalMs, 24 * 60 * 60 * 1000)),
    lookbackHours: Math.max(1, num(block.lookbackHours, 24)),
    maxInputChars: Math.max(500, num(block.maxInputChars, 8000)),
    model: {
      format,
      baseUrl: isString(modelBlock.baseUrl) ? modelBlock.baseUrl : "",
      model: isString(modelBlock.model) ? modelBlock.model
        : format === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini",
      apiKeyEnv: isString(modelBlock.apiKeyEnv) ? modelBlock.apiKeyEnv : undefined,
    },
  };
}

/**
 * Per-format embedding defaults. Picking a format alone (e.g. `{format: "ollama"}`)
 * is enough to get a working setup; baseUrl/model/apiKeyEnv all fall through to
 * the per-format default. The frictionless 0→1 case is empty `{}` (or omitting
 * the block entirely) → Jina free tier with JINA_API_KEY.
 */
const EMBEDDING_DEFAULTS: Record<
  "jina" | "openai" | "ollama",
  { provider: string; model: string; baseUrl: string; apiKeyEnv?: string }
> = {
  jina: {
    provider: "jina",
    model: "jina-embeddings-v3",
    baseUrl: "https://api.jina.ai",
    apiKeyEnv: "JINA_API_KEY",
  },
  openai: {
    provider: "openai",
    model: "text-embedding-3-small",
    baseUrl: "https://api.openai.com",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  ollama: {
    provider: "ollama",
    model: "qwen3-embedding:4b",
    baseUrl: "http://127.0.0.1:11434",
    // ollama is LAN by default; no api key
  },
};

function resolveEmbeddingConfig(
  raw: NonNullable<MemoryPostgresConfig["embedding"]> | undefined,
): ResolvedMemoryPostgresConfig["embedding"] {
  const block = raw ?? {};
  const format = (block.format ?? "jina") as keyof typeof EMBEDDING_DEFAULTS;
  const defaults = EMBEDDING_DEFAULTS[format] ?? EMBEDDING_DEFAULTS.jina;
  return {
    provider: isString(block.provider) ? block.provider : defaults.provider,
    model: isString(block.model) ? block.model : defaults.model,
    baseUrl: isString(block.baseUrl) ? block.baseUrl : defaults.baseUrl,
    apiKeyEnv: isString(block.apiKeyEnv) ? block.apiKeyEnv : defaults.apiKeyEnv,
    dims: block.dims,
    format,
    path: block.path,
    maxEmbedChars: Math.max(100, num(block.maxEmbedChars, 2000)),
  };
}

function resolveShadowComparator(c: ShadowComparatorConfig): ResolvedShadowComparator {
  return {
    id: c.id,
    trajectoryDir: c.trajectoryDir,
    baseUrl: c.baseUrl,
    model: c.model,
    apiKeyEnv: c.apiKeyEnv,
    intervalMs: Math.max(10_000, num(c.intervalMs, 30_000)),
    backfillWindowMs: num(c.backfillWindowMs, 24 * 60 * 60_000),
    maxOutputTokens: num(c.maxOutputTokens, 400),
    requestTimeoutMs: num(c.requestTimeoutMs, 90_000),
    minUserMessageChars: num(c.minUserMessageChars, 0),
  };
}

function resolveTranscriptWatcher(w: TranscriptWatcherConfig): ResolvedTranscriptWatcher {
  return {
    id: w.id,
    agentId: isString(w.agentId) ? w.agentId : "main",
    dir: w.dir,
    intervalMs: Math.max(5000, num(w.intervalMs, 10_000)),
    source: isString(w.source) ? w.source : "session",
    maxBytesPerTick: num(w.maxBytesPerTick, 256 * 1024),
    firstRunBackfillBytes: num(w.firstRunBackfillBytes, 64 * 1024),
    defaultImportance: Math.max(0, Math.min(1, num(w.defaultImportance, 0.35))),
    dropPureQuestions: bool(w.dropPureQuestions, true),
    anchors: w.anchors,
  };
}

function resolveGitWatcher(w: GitWatcherConfig): ResolvedGitWatcher {
  const branch = isString(w.branch) ? w.branch : "main";
  return {
    id: w.id,
    path: w.path,
    branch,
    remote: isString(w.remote) ? w.remote : "origin",
    intervalMs: num(w.intervalMs, 60 * 60 * 1000), // 1h default
    source: isString(w.source) ? w.source : "git",
    anchors: {
      cwd: w.anchors?.cwd ?? w.path,
      branch: w.anchors?.branch ?? branch,
    },
    gitBinary: isString(w.gitBinary) ? w.gitBinary : "git",
  };
}
