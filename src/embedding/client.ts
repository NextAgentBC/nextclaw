/**
 * Embedding client with three wire formats:
 *
 *   - `jina`   — `https://api.jina.ai/v1/embeddings` (DEFAULT).
 *                Adds an asymmetric `task` body parameter
 *                (`retrieval.passage` for ingest, `retrieval.query` for recall).
 *                Free tier on jina.ai/embeddings gives 1M tokens with no card
 *                required, which keeps the 0→1 install path frictionless.
 *   - `openai` — standard `/v1/embeddings` shape; works with OpenAI itself
 *                and most compat endpoints (Together, vLLM, TEI, ...).
 *                No asymmetric retrieval hint — both sides embed the same way.
 *   - `ollama` — local Ollama `/api/embed`; for qwen3-embedding the query
 *                side gets a prefix prepended to the input text rather than
 *                a separate body parameter.
 *
 * Auth: `Authorization: Bearer ${env[apiKeyEnv]}` when apiKeyEnv is set;
 * otherwise no auth header (works for LAN ollama).
 *
 * Why a thin standalone client and not the bundled ollama provider adapter:
 * the ollama plugin lives behind plugins.entries.ollama and pulls in heavier
 * provider plumbing. Here we want a tight, focused embed call usable from
 * ingest/recall paths and from the doctor reachability probe without
 * cross-extension prod imports.
 */

export type EmbeddingApiFormat = "ollama" | "openai" | "jina";

export type EmbeddingClientConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Wire format. See top-of-file docblock for per-format behavior.
   * Default `jina` — frictionless free-tier first-run experience.
   */
  format?: EmbeddingApiFormat;
  /**
   * Optional path override (relative to baseUrl). Useful when a broker
   * mounts the embedding endpoint under a non-canonical prefix.
   */
  path?: string;
};

export type EmbedRequest = {
  inputs: string[];
  /**
   * Asymmetric retrieval hint. `query` is sent on recall paths; ingest paths
   * pass `null` (or omit) for the symmetric/passage case.
   *
   * Per-format behavior:
   *   - `jina`   → `task: "retrieval.query"` vs `"retrieval.passage"` default
   *   - `ollama` → prepends qwen3 instruct prefix to the input text
   *   - `openai` → ignored (no widely-supported asymmetric flag)
   */
  taskPrefix?: "query" | null;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
  dims: number;
  latencyMs: number;
};

const OLLAMA_QUERY_PREFIX =
  "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:";

function decoratedInputs(
  inputs: string[],
  taskPrefix: EmbedRequest["taskPrefix"],
  format: EmbeddingApiFormat,
): string[] {
  if (taskPrefix !== "query") {return inputs;}
  // Only ollama/qwen3 uses prefix-decoration. Jina has a separate `task`
  // body parameter; plain OpenAI compat has nothing.
  if (format !== "ollama") {return inputs;}
  return inputs.map((s) => `${OLLAMA_QUERY_PREFIX}${s}`);
}

function defaultPathFor(format: EmbeddingApiFormat): string {
  if (format === "ollama") {return "/api/embed";}
  return "/v1/embeddings";
}

function buildBody(
  cfg: EmbeddingClientConfig,
  format: EmbeddingApiFormat,
  inputs: string[],
  taskPrefix: EmbedRequest["taskPrefix"],
): string {
  if (format === "jina") {
    return JSON.stringify({
      model: cfg.model,
      input: inputs,
      task: taskPrefix === "query" ? "retrieval.query" : "retrieval.passage",
    });
  }
  return JSON.stringify({
    model: cfg.model,
    input: decoratedInputs(inputs, taskPrefix, format),
  });
}

export class EmbeddingClient {
  constructor(private readonly cfg: EmbeddingClientConfig) {
    if (!cfg.baseUrl) {throw new Error("[memory-postgres] embedding baseUrl missing");}
    if (!cfg.model) {throw new Error("[memory-postgres] embedding model missing");}
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    if (req.inputs.length === 0) {
      return { embeddings: [], model: this.cfg.model, dims: 0, latencyMs: 0 };
    }
    const format: EmbeddingApiFormat = this.cfg.format ?? "jina";
    const path = this.cfg.path ?? defaultPathFor(format);
    // Concat directly — `new URL(path, base)` would replace the base's pathname
    // when `path` starts with `/`, which breaks proxy-prefixed endpoints like
    // `http://broker/v1/proxy/local-embed`.
    const baseTrimmed = this.cfg.baseUrl.replace(/\/+$/, "");
    const pathPrefixed = path.startsWith("/") ? path : `/${path}`;
    const url = `${baseTrimmed}${pathPrefixed}`;
    const body = buildBody(this.cfg, format, req.inputs, req.taskPrefix ?? null);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) {headers["authorization"] = `Bearer ${this.cfg.apiKey}`;}

    const fetchImpl = this.cfg.fetchImpl ?? globalThis.fetch;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    const start = Date.now();
    let resp: Response;
    try {
      resp = await fetchImpl(url, { method: "POST", headers, body, signal: ctrl.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      throw new Error(`[memory-postgres] embed HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const json = (await resp.json()) as
      | { embeddings?: number[][] }                                     // ollama
      | { data?: Array<{ embedding?: number[]; index?: number }> };    // openai / jina
    const embeddings = format === "ollama"
      ? ((json as { embeddings?: number[][] }).embeddings ?? [])
      : extractOpenAiEmbeddings(json as { data?: Array<{ embedding?: number[]; index?: number }> });
    if (embeddings.length !== req.inputs.length) {
      throw new Error(
        `[memory-postgres] embed response missing embeddings (got ${embeddings.length}, expected ${req.inputs.length})`,
      );
    }
    const dims = embeddings[0]?.length ?? 0;
    if (dims === 0) {throw new Error("[memory-postgres] embed response has zero dims");}
    return {
      embeddings,
      model: this.cfg.model,
      dims,
      latencyMs: Date.now() - start,
    };
  }

  async probe(): Promise<{ ok: true; dims: number; latencyMs: number } | { ok: false; error: string }> {
    try {
      const result = await this.embed({ inputs: ["probe"] });
      return { ok: true, dims: result.dims, latencyMs: result.latencyMs };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}

/**
 * Defaults baked in when the corresponding config field is missing:
 *   format=jina, baseUrl=https://api.jina.ai/v1, model=jina-embeddings-v3,
 *   apiKeyEnv=JINA_API_KEY.
 *
 * Each default is applied independently, so a caller can mix-and-match
 * (e.g. set `format: "ollama"` without re-specifying baseUrl).
 */
export function buildEmbeddingClientFromConfig(cfg: {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  format?: EmbeddingApiFormat;
  path?: string;
}): EmbeddingClient {
  const format: EmbeddingApiFormat = cfg.format ?? "jina";
  const baseUrl = cfg.baseUrl ?? defaultBaseUrlFor(format);
  const model = cfg.model ?? defaultModelFor(format);
  const apiKeyEnv = cfg.apiKeyEnv ?? defaultApiKeyEnvFor(format);
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  return new EmbeddingClient({
    baseUrl,
    model,
    apiKey,
    format,
    path: cfg.path,
  });
}

function defaultBaseUrlFor(format: EmbeddingApiFormat): string {
  if (format === "ollama") {return "http://127.0.0.1:11434";}
  if (format === "openai") {return "https://api.openai.com";}
  return "https://api.jina.ai";
}

function defaultModelFor(format: EmbeddingApiFormat): string {
  if (format === "ollama") {return "qwen3-embedding:4b";}
  if (format === "openai") {return "text-embedding-3-small";}
  return "jina-embeddings-v3";
}

function defaultApiKeyEnvFor(format: EmbeddingApiFormat): string | undefined {
  if (format === "ollama") {return undefined;}
  if (format === "openai") {return "OPENAI_API_KEY";}
  return "JINA_API_KEY";
}

function extractOpenAiEmbeddings(
  json: { data?: Array<{ embedding?: number[]; index?: number }> },
): number[][] {
  const data = Array.isArray(json.data) ? json.data : [];
  // Sort by index when present so multi-input batches stay aligned.
  const sorted = data.toSorted(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  return sorted
    .map((d) => (Array.isArray(d.embedding) ? d.embedding : null))
    .filter((v): v is number[] => v !== null);
}
