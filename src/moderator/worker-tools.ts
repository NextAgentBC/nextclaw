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

/** Single source of truth — map[toolName] → ToolDefinition. */
const REGISTRY: Record<string, ToolDefinition> = {
  memory_search: MEMORY_SEARCH,
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
