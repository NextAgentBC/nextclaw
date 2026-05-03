/**
 * qwen3 embedding client via the Ollama-compatible /api/embed endpoint.
 *
 * Single round-trip; supports batching (embeddings: [...]).
 * Auth: Bearer ${env[apiKeyEnv]} when apiKeyEnv is set; otherwise unauth (LAN).
 *
 * Why a thin standalone client and not the bundled ollama provider adapter:
 * the ollama plugin lives behind plugins.entries.ollama and pulls in heavier
 * provider plumbing. Here we want a tight, focused embed call we can use from
 * Phase 1 ingest/recall paths and from the doctor reachability probe — without
 * cross-extension prod imports.
 */

export type EmbeddingApiFormat = "ollama" | "openai";

export type EmbeddingClientConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Wire format. `ollama` posts `/api/embed` with `{model, input}` and reads
   * `{embeddings: number[][]}`. `openai` posts `/v1/embeddings` with the
   * `{model, input}` shape and reads `{data: [{embedding: number[]}]}`.
   * Default: `ollama` (backward-compat with the original config).
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
  /** qwen3 supports an optional task prefix; recall uses it, ingest does not. */
  taskPrefix?: "query" | null;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
  dims: number;
  latencyMs: number;
};

const QUERY_PREFIX = "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:";

function decoratedInputs(inputs: string[], taskPrefix: EmbedRequest["taskPrefix"]): string[] {
  if (taskPrefix !== "query") {return inputs;}
  return inputs.map((s) => `${QUERY_PREFIX}${s}`);
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
    const format: EmbeddingApiFormat = this.cfg.format ?? "ollama";
    const path = this.cfg.path ?? (format === "openai" ? "/v1/embeddings" : "/api/embed");
    // Concat directly — `new URL(path, base)` would replace the base's pathname
    // when `path` starts with `/`, which breaks proxy-prefixed endpoints like
    // `http://broker/v1/proxy/local-embed`.
    const baseTrimmed = this.cfg.baseUrl.replace(/\/+$/, "");
    const pathPrefixed = path.startsWith("/") ? path : `/${path}`;
    const url = `${baseTrimmed}${pathPrefixed}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      input: decoratedInputs(req.inputs, req.taskPrefix ?? null),
    });
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
      | { data?: Array<{ embedding?: number[]; index?: number }> };    // openai
    const embeddings = format === "openai"
      ? extractOpenAiEmbeddings(json as { data?: Array<{ embedding?: number[]; index?: number }> })
      : ((json as { embeddings?: number[][] }).embeddings ?? []);
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

export function buildEmbeddingClientFromConfig(cfg: {
  baseUrl?: string;
  model: string;
  apiKeyEnv?: string;
  format?: EmbeddingApiFormat;
  path?: string;
}): EmbeddingClient {
  const baseUrl = cfg.baseUrl ?? "http://127.0.0.1:11434";
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  return new EmbeddingClient({
    baseUrl,
    model: cfg.model,
    apiKey,
    format: cfg.format,
    path: cfg.path,
  });
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
