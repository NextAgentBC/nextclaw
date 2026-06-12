/**
 * memory-postgres plugin config: TypeScript types + plain runtime guards.
 *
 * The authoritative schema is in openclaw.plugin.json; OpenClaw validates raw
 * config there before this module ever sees it. resolveConfig() applies
 * defaults; validateConfig() exists for tests and defensive runtime use.
 */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === "string" && v.length > 0;
const num = (v, d) => typeof v === "number" && Number.isFinite(v) ? v : d;
const bool = (v, d) => (typeof v === "boolean" ? v : d);
/**
 * Defensive runtime check; matches the JSON schema in openclaw.plugin.json.
 * Throws with a path-prefixed message on failure.
 */
export function validateConfig(raw) {
    if (!isObject(raw)) {
        throw new Error("config: not an object");
    }
    const pg = raw.postgres;
    if (!isObject(pg)) {
        throw new Error("config.postgres: required");
    }
    if (!isString(pg.url)) {
        throw new Error("config.postgres.url: required string");
    }
    // embedding block is optional in 0.2+ — omitting it implies the Jina free-tier
    // defaults (format=jina, model=jina-embeddings-v3, JINA_API_KEY env). When
    // present, only the format field is constrained; provider+model are filled
    // in by resolveConfig() based on format.
    const em = raw.embedding;
    if (em !== undefined && !isObject(em)) {
        throw new Error("config.embedding: must be object when present");
    }
    if (em && em.format && !["jina", "openai", "ollama"].includes(em.format)) {
        throw new Error(`config.embedding.format: must be one of jina|openai|ollama, got ${em.format}`);
    }
}
export function resolveConfig(raw) {
    const tiers = raw.tiers ?? {};
    const scoring = raw.scoring ?? {};
    const ingestScoring = scoring.ingest ?? {};
    const recallScoring = scoring.recall ?? {};
    const dashboard = raw.dashboard ?? {};
    const tuning = raw.tuning ?? {};
    const credbroker = resolveCredbroker(raw.credbroker);
    return {
        postgres: {
            url: raw.postgres.url,
            poolMax: num(raw.postgres.poolMax, 8),
            statementTimeoutMs: num(raw.postgres.statementTimeoutMs, 30_000),
        },
        credbroker,
        embedding: resolveEmbeddingConfig(raw.embedding, credbroker),
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
            publicUrl: typeof dashboard.publicUrl === "string" && /^https:\/\//.test(dashboard.publicUrl)
                ? dashboard.publicUrl.replace(/\/+$/, "")
                : undefined,
        },
        tuning: { autoApplyEnabled: bool(tuning.autoApplyEnabled, false) },
        gitWatchers: (raw.gitWatchers ?? []).map(resolveGitWatcher),
        transcriptWatchers: (raw.transcriptWatchers ?? []).map(resolveTranscriptWatcher),
        shadowComparators: (raw.shadowComparators ?? []).map(resolveShadowComparator),
        reflection: resolveReflectionConfig(raw.reflection, credbroker),
        residual: resolveResidualConfig(raw.residual, credbroker),
        moderator: resolveModeratorConfig(raw.moderator, credbroker),
    };
}
/**
 * Build a `ResolvedCredbrokerConfig` from the raw block. If `baseUrl` is
 * missing the whole struct disables (all fields `null`), which means
 * per-service URLs MUST be set explicitly elsewhere. The service tail
 * defaults match Yao's setup but are overridable for other deployments.
 */
function resolveCredbroker(raw) {
    const baseUrl = isString(raw?.baseUrl) ? raw.baseUrl.replace(/\/+$/, "") : null;
    if (!baseUrl) {
        return { baseUrl: null, embeddingUrl: null, geminiUrl: null, tavilyUrl: null };
    }
    const services = raw?.services ?? {};
    const tail = (name, fallback) => isString(services[name])
        ? services[name]
        : fallback;
    return {
        baseUrl,
        embeddingUrl: `${baseUrl}/v1/proxy/${tail("embedding", "local-embed")}`,
        geminiUrl: `${baseUrl}/v1/proxy/${tail("gemini", "gemini")}`,
        // Tavily is hit as `/v1/proxy/tavily/search` (the `/search` is appended
        // by the worker tool); store the service-root here, not the full URL.
        tavilyUrl: `${baseUrl}/v1/proxy/${tail("tavily", "tavily")}/search`,
    };
}
function resolveModeratorConfig(raw, credbroker) {
    const block = raw ?? {};
    const modelBlock = block.model ?? {};
    const format = modelBlock.format === "gemini" ? "gemini" : "openai";
    // Credbroker proxies Gemini only — for openai we never derive.
    const credbrokerFallback = format === "gemini" ? credbroker.geminiUrl : null;
    // Skill emit directory: enabled gates the whole feature; dir defaults to
    // ~/.openclaw/skills/nextclaw-roles via defaultSkillEmitDir(). We resolve
    // to `null` when disabled so the worker dispatch path can skip emit
    // cheaply, OR to a fully-resolved absolute path string.
    const publishBlock = block.publishAsSkills ?? {};
    let publishSkillsDir = null;
    if (publishBlock.enabled === true) {
        if (isString(publishBlock.dir) && publishBlock.dir.length > 0) {
            publishSkillsDir = publishBlock.dir;
        }
        else {
            // Substitute the default lazily to avoid pulling the moderator module
            // into the config-resolution import graph (circular concern).
            const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
            publishSkillsDir = `${home}/.openclaw/skills/nextclaw-roles`;
        }
    }
    return {
        enabled: bool(block.enabled, false),
        agentId: isString(block.agentId)
            ? (block.agentId)
            : "main",
        debounceMs: Math.max(100, num(block.debounceMs, 1500)),
        model: {
            format,
            baseUrl: isString(modelBlock.baseUrl) ? modelBlock.baseUrl : (credbrokerFallback ?? ""),
            model: isString(modelBlock.model) ? modelBlock.model
                : format === "gemini" ? "gemini-2.5-flash" : "gpt-5.5",
            apiKeyEnv: isString(modelBlock.apiKeyEnv) ? modelBlock.apiKeyEnv : undefined,
        },
        publishSkillsDir,
    };
}
function resolveResidualConfig(raw, credbroker) {
    const block = raw ?? {};
    const modelBlock = block.model ?? {};
    // Default to gemini (the credbroker only proxies gemini); honour an explicit openai.
    const format = modelBlock.format === "openai" ? "openai" : "gemini";
    const credbrokerFallback = format === "gemini" ? credbroker.geminiUrl : null;
    return {
        enabled: bool(block.enabled, false),
        maxRpm: Math.max(1, num(block.maxRpm, 8)),
        dailyTokenBudget: Math.max(0, num(block.dailyTokenBudget, 50_000)),
        model: {
            format,
            baseUrl: isString(modelBlock.baseUrl) ? modelBlock.baseUrl : (credbrokerFallback ?? ""),
            model: isString(modelBlock.model) ? modelBlock.model : "gemini-2.5-flash",
            apiKeyEnv: isString(modelBlock.apiKeyEnv) ? modelBlock.apiKeyEnv : undefined,
        },
    };
}
function resolveReflectionConfig(raw, credbroker) {
    // Defaults are inert (`enabled=false`). When the user enables it without
    // a model block, we still produce a sane shape but the daemon won't start.
    const block = raw ?? {};
    const modelBlock = block.model ?? {};
    const format = modelBlock.format === "gemini" ? "gemini" : "openai";
    const credbrokerFallback = format === "gemini" ? credbroker.geminiUrl : null;
    return {
        enabled: bool(block.enabled, false),
        intervalMs: Math.max(60 * 60 * 1000, num(block.intervalMs, 24 * 60 * 60 * 1000)),
        lookbackHours: Math.max(1, num(block.lookbackHours, 24)),
        maxInputChars: Math.max(500, num(block.maxInputChars, 8000)),
        model: {
            format,
            baseUrl: isString(modelBlock.baseUrl) ? modelBlock.baseUrl : (credbrokerFallback ?? ""),
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
const EMBEDDING_DEFAULTS = {
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
function resolveEmbeddingConfig(raw, credbroker) {
    const block = raw ?? {};
    const format = (block.format ?? "jina");
    const defaults = EMBEDDING_DEFAULTS[format] ?? EMBEDDING_DEFAULTS.jina;
    // Credbroker fallback: only for self-hosted formats (openai/ollama).
    // For format=jina we KEEP the Jina cloud default so new users without
    // credbroker get the free-tier path automatically.
    const credbrokerFallback = credbroker.embeddingUrl && (format === "openai" || format === "ollama")
        ? credbroker.embeddingUrl
        : null;
    return {
        provider: isString(block.provider) ? block.provider : defaults.provider,
        model: isString(block.model) ? block.model : defaults.model,
        baseUrl: isString(block.baseUrl)
            ? block.baseUrl
            : credbrokerFallback ?? defaults.baseUrl,
        apiKeyEnv: isString(block.apiKeyEnv) ? block.apiKeyEnv : defaults.apiKeyEnv,
        dims: block.dims,
        format,
        path: block.path,
        maxEmbedChars: Math.max(100, num(block.maxEmbedChars, 2000)),
    };
}
function resolveShadowComparator(c) {
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
function resolveTranscriptWatcher(w) {
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
function resolveGitWatcher(w) {
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
