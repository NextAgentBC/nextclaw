/**
 * Worker tool registry — the "limbs" we hand the LLM.
 *
 * Leverage principle (memory: complementary-not-replacement):
 *   We DON'T decide when to call these — the model does. We only define
 *   the surface (what tools exist, what they take, what they return) and
 *   route the calls. A stronger LLM uses tools more cleverly; we get
 *   smarter answers for free, no code changes here.
 *
 * Roles are allowlisted at the role level (`worker_roles.tools`). A role
 * with `tools=[]` runs single-shot exactly like before — no regression
 * for older role rows. DEFAULT_ROLE intentionally has zero tools.
 *
 * Phase-E candidates (NOT in this MVP):
 *   - escalate_to_human({reason}) — DM the operator + pause scope
 *   - schedule_followup({delaySeconds, text}) — cron a future ping
 *   - kb_lookup({path}) — read a curated KB doc verbatim
 *   - record_correction({wrongAnswer, correctAnswer}) — explicit memory write
 */

import type { Pool } from "pg";
import type { EmbeddingClient } from "../embedding/client.js";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import { recall } from "../recall/router.js";
import type { ViewerScope } from "../recall/viewer-scope.js";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export type ToolCall = { name: string; args: Record<string, unknown> };
export type ToolResult = { name: string; content: string };

export type ToolRuntimeDeps = {
  pool: Pool;
  embedding: EmbeddingClient;
  cfg: ResolvedMemoryPostgresConfig;
  agentId: string;
  viewer: ViewerScope | undefined;
};

/* ------------------------------- definitions ------------------------------ */

const MEMORY_SEARCH: ToolDefinition = {
  name: "memory_search",
  description:
    "Search the agent's long-term memory store for relevant chunks. " +
    "Returns up to N highest-scoring text passages, each with a source label. " +
    "Use when the user's question references prior conversations, established facts, " +
    "or domain knowledge that may have been stored. Do NOT use for general world knowledge.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query in the same language as the user's question. Be specific.",
      },
      topic: {
        type: "string",
        description: "Optional topic filter (e.g. 'math.fractions', 'policy.returns'). Narrows results.",
      },
      max: {
        type: "number",
        description: "Max results to return. Default 5, hard cap 10.",
      },
    },
    required: ["query"],
  },
};

const WEB_SEARCH: ToolDefinition = {
  name: "web_search",
  description:
    "Search the public web via Tavily for current/recent information. " +
    "Use when the question is about news, recent events, public data, " +
    "or anything that may have changed after the model's knowledge cutoff. " +
    "Do NOT use for questions answerable from memory_search or general training knowledge. " +
    "Each result has {title, url, snippet}; cite the URL if you use the content.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Web search query. Be specific; include dates/years for time-sensitive questions.",
      },
      max: {
        type: "number",
        description: "Max results. Default 5, hard cap 8.",
      },
    },
    required: ["query"],
  },
};

/** Single source of truth — map[toolName] → ToolDefinition. */
const REGISTRY: Record<string, ToolDefinition> = {
  memory_search: MEMORY_SEARCH,
  web_search: WEB_SEARCH,
};

/** Returns tool defs for an allowlist (skips unknown names silently). */
export function resolveTools(toolNames: string[]): ToolDefinition[] {
  return toolNames
    .map((n) => REGISTRY[n])
    .filter((t): t is ToolDefinition => t !== undefined);
}

export function listAvailableToolNames(): string[] {
  return Object.keys(REGISTRY);
}

/* -------------------------------- executor -------------------------------- */

const MEMORY_SEARCH_MAX = 10;
const MEMORY_SEARCH_DEFAULT = 5;
const MAX_CHUNK_CHARS_IN_RESULT = 300;

/**
 * Execute one tool call. Errors are converted into ToolResult content
 * (never throw) so the LLM sees them in the next turn and can react.
 */
export async function executeTool(
  deps: ToolRuntimeDeps,
  call: ToolCall,
): Promise<ToolResult> {
  if (call.name === "memory_search") {
    return execMemorySearch(deps, call.args);
  }
  if (call.name === "web_search") {
    return execWebSearch(call.args);
  }
  return {
    name: call.name,
    content: JSON.stringify({ error: `unknown_tool: ${call.name}` }),
  };
}

export async function executeToolsBatch(
  deps: ToolRuntimeDeps,
  calls: ToolCall[],
): Promise<ToolResult[]> {
  // Parallel — independent calls.
  return Promise.all(calls.map((c) => executeTool(deps, c)));
}

async function execMemorySearch(
  deps: ToolRuntimeDeps,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length < 2) {
    return {
      name: "memory_search",
      content: JSON.stringify({ error: "query required (>=2 chars)" }),
    };
  }
  const topic = typeof args.topic === "string" ? args.topic : undefined;
  const maxRaw = typeof args.max === "number" ? args.max : MEMORY_SEARCH_DEFAULT;
  const max = Math.min(MEMORY_SEARCH_MAX, Math.max(1, Math.floor(maxRaw)));
  try {
    const rr = await recall(
      { cfg: deps.cfg, pool: deps.pool, embedding: deps.embedding },
      {
        query,
        maxResults: max,
        agentId: deps.agentId,
        viewer: deps.viewer,
        conceptTags: topic ? [topic] : undefined,
      },
    );
    const results = rr.results.map((c, i) => ({
      idx: i + 1,
      source: c.source ?? "memory",
      text: (c.text ?? "").slice(0, MAX_CHUNK_CHARS_IN_RESULT),
      score: Number(c.combinedScore?.toFixed(3) ?? 0),
    }));
    return {
      name: "memory_search",
      content: JSON.stringify({
        query,
        topic,
        count: results.length,
        results,
      }),
    };
  } catch (e) {
    return {
      name: "memory_search",
      content: JSON.stringify({ error: `recall_failed: ${(e as Error).message}` }),
    };
  }
}

/* -------------------------- web_search (Tavily) --------------------------- */

const WEB_SEARCH_MAX = 8;
const WEB_SEARCH_DEFAULT = 5;
const WEB_SEARCH_TIMEOUT_MS = 12_000;
const WEB_SEARCH_SNIPPET_CHARS = 400;

/**
 * Resolve the Tavily endpoint:
 *   1. If `NEXTCLAW_WEB_SEARCH_URL` env is set, use it (full URL).
 *   2. Else if `TAVILY_API_KEY` env is set, hit api.tavily.com directly.
 *   3. Else default to the credbroker proxy URL (Tailscale-only, no key needed).
 *
 * Order matters: explicit env override > direct API > broker default. The
 * broker fallback lets the existing Oracle box keep working unchanged.
 */
function resolveWebSearchEndpoint(): { url: string; apiKey?: string } {
  const explicit = process.env.NEXTCLAW_WEB_SEARCH_URL;
  if (explicit) {
    return { url: explicit, apiKey: process.env.TAVILY_API_KEY };
  }
  const directKey = process.env.TAVILY_API_KEY;
  if (directKey) {
    return { url: "https://api.tavily.com/search", apiKey: directKey };
  }
  return { url: "http://100.79.97.110:8800/v1/proxy/tavily/search" };
}

async function execWebSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length < 2) {
    return {
      name: "web_search",
      content: JSON.stringify({ error: "query required (>=2 chars)" }),
    };
  }
  const maxRaw = typeof args.max === "number" ? args.max : WEB_SEARCH_DEFAULT;
  const max = Math.min(WEB_SEARCH_MAX, Math.max(1, Math.floor(maxRaw)));
  const { url, apiKey } = resolveWebSearchEndpoint();
  const body: Record<string, unknown> = { query, max_results: max };
  if (apiKey) {body.api_key = apiKey;}
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        name: "web_search",
        content: JSON.stringify({ error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` }),
      };
    }
    const json = (await resp.json()) as {
      results?: Array<{ url?: string; title?: string; content?: string; score?: number }>;
      answer?: string | null;
    };
    const results = (json.results ?? []).map((r, i) => ({
      idx: i + 1,
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.content ?? "").slice(0, WEB_SEARCH_SNIPPET_CHARS),
      score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
    }));
    return {
      name: "web_search",
      content: JSON.stringify({
        query,
        count: results.length,
        // Tavily sometimes pre-summarizes the answer — pass through if present
        // so the model can use it as a starting point.
        synthesized_answer: json.answer ?? null,
        results,
      }),
    };
  } catch (e) {
    return {
      name: "web_search",
      content: JSON.stringify({ error: `web_search_failed: ${(e as Error).message}` }),
    };
  } finally {
    clearTimeout(timer);
  }
}
