/**
 * Agent tools exposed by memory-postgres: `memory_search` and `memory_store`.
 *
 * These are thin wrappers over the recall router and ingest pipeline so the
 * agent can read/write the long-term memory in turn.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, validateConfig } from "./config.js";
import { buildEmbeddingClientFromConfig } from "./embedding/client.js";
import { ingestOne } from "./ingest/pipeline.js";
import { recall } from "./recall/router.js";
import { ensureHnswIndex, migrate } from "./storage/migrate.js";
import { getPool } from "./storage/pool.js";

const SEARCH_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", description: "What you want to remember about." },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 20,
      description: "Max results to return (default 5).",
    },
    cwd: {
      type: "string",
      description:
        "Optional cwd anchor; e.g. the user's project root. When set, anchor route fires first.",
    },
    branch: { type: "string", description: "Optional git branch anchor." },
    pr: { type: "string", description: "Optional PR number anchor." },
    timeBucket: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Optional ISO date YYYY-MM-DD to filter by.",
    },
  },
} as const;

const STORE_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: {
      type: "string",
      minLength: 8,
      description:
        "Information to remember. Concrete facts, decisions, or preferences work best.",
    },
    importance: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Importance 0-1 (default 0.5). Use 1.0 for pinned facts.",
    },
    pinned: {
      type: "boolean",
      description: "If true, mark as retention_class='pinned' so it never decays.",
    },
    cwd: { type: "string", description: "Optional cwd anchor." },
    branch: { type: "string", description: "Optional branch anchor." },
    pr: { type: "string", description: "Optional PR number anchor." },
    file: { type: "string", description: "Optional file path anchor." },
  },
} as const;

type SearchParams = {
  query: string;
  limit?: number;
  cwd?: string;
  branch?: string;
  pr?: string;
  timeBucket?: string;
};

type StoreParams = {
  text: string;
  importance?: number;
  pinned?: boolean;
  cwd?: string;
  branch?: string;
  pr?: string;
  file?: string;
};

/**
 * sessionKey shape is `agent:<agentId>:<sessionId>`. Pull out the agentId so
 * memory_search / memory_store called from the `club` agent can never see
 * the `main` agent's chunks (and vice versa). Falls back to "main" so DM
 * sessions and any caller without a sessionKey keep the historical default.
 */
function agentIdFromSessionKey(sessionKey: string | undefined): string {
  if (!sessionKey) {return "main";}
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m ? m[1] : "main";
}

function pluginConfigOf(cfg: OpenClawConfig): unknown {
  const entry = (cfg as unknown as {
    plugins?: { entries?: { "memory-postgres"?: { config?: unknown } } };
  }).plugins?.entries?.["memory-postgres"]?.config;
  if (!entry) {
    throw new Error("memory-postgres: plugin config missing");
  }
  validateConfig(entry);
  return entry;
}

async function setup(config: unknown) {
  const raw = config as Parameters<typeof resolveConfig>[0];
  const cfg = resolveConfig(raw);
  const pool = await getPool({
    url: cfg.postgres.url,
    poolMax: cfg.postgres.poolMax,
    statementTimeoutMs: cfg.postgres.statementTimeoutMs,
  });
  // First-time call brings up the schema; subsequent calls are idempotent.
  await migrate(pool);
  await ensureHnswIndex(pool).catch(() => undefined);
  const embedding = buildEmbeddingClientFromConfig({
    baseUrl: cfg.embedding.baseUrl,
    model: cfg.embedding.model,
    apiKeyEnv: cfg.embedding.apiKeyEnv,
    format: cfg.embedding.format,
    path: cfg.embedding.path,
  });
  return { cfg, pool, embedding };
}

/**
 * Returns the static descriptors used by `api.registerTool` factories.
 * The actual `execute` body resolves config + pool lazily so each call sees
 * the current runtime config.
 */
export function buildSearchTool(args: { config: OpenClawConfig; sessionKey?: string }): AnyAgentTool {
  // Hand-rolled JSON schema is a structural superset of TSchema at runtime;
  // the Plugin SDK's AnyAgentTool type insists on TSchema for design-time
  // ergonomics, so we cast through unknown at the boundary.
  const tool = {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search long-term memory (Postgres + pgvector). Use to recall facts, preferences, "
      + "past events, files / projects / people the user has mentioned. "
      + "Pass `cwd`/`branch`/`pr`/`timeBucket` when you have anchor signals so the call stays sub-second and free.",
    parameters: SEARCH_PARAMS as unknown as AnyAgentTool["parameters"],
    async execute(this: void, _toolCallId: string, params: unknown): Promise<{ content: unknown; details: unknown }> {
      const p = params as SearchParams;
      const { cfg, pool, embedding } = await setup(pluginConfigOf(args.config));
      const result = await recall(
        { cfg, pool, embedding },
        {
          query: p.query,
          maxResults: p.limit ?? 5,
          anchors: {
            cwd: p.cwd,
            branch: p.branch,
            pr: p.pr,
          },
          timeBucket: p.timeBucket,
          agentSessionId: args.sessionKey,
          agentId: agentIdFromSessionKey(args.sessionKey),
        },
      );

      if (result.results.length === 0) {
        return {
          content: [{ type: "text", text: "No relevant memories found." }],
          details: {
            count: 0,
            hitTier: result.hitTier,
            embedCalls: result.embedCalls,
            latencyMs: result.latencyMs,
          },
        };
      }

      const lines = result.results.map((c, i) => {
        const tier = c.hits.join("+");
        return `${i + 1}. [${tier}] ${c.text.slice(0, 220)}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Found ${result.results.length} memory snippet(s):\n${lines.join("\n")}`,
          },
        ],
        details: {
          count: result.results.length,
          hitTier: result.hitTier,
          score: result.score,
          embedCalls: result.embedCalls,
          llmTokensUsed: result.llmTokensUsed,
          latencyMs: result.latencyMs,
          routesRun: result.routesRun,
          zeroCostHit: result.zeroCostHit,
          results: result.results.map((c) => ({
            chunkId: c.chunkId,
            source: c.source,
            text: c.text,
            score: c.combinedScore,
            hits: c.hits,
          })),
        },
      };
    },
  };
  return tool as unknown as AnyAgentTool;
}

export function buildStoreTool(args: { config: OpenClawConfig; sessionKey?: string }): AnyAgentTool {
  const tool = {
    name: "memory_store",
    label: "Memory Store",
    description:
      "Write a fact / preference / decision to long-term memory. Use sparingly: only "
      + "for things genuinely worth remembering across sessions (preferences, project facts, decisions). "
      + "Pass `cwd`/`branch`/`pr`/`file` anchors when relevant so future recall can find it instantly.",
    parameters: STORE_PARAMS as unknown as AnyAgentTool["parameters"],
    async execute(this: void, _toolCallId: string, params: unknown): Promise<{ content: unknown; details: unknown }> {
      const p = params as StoreParams;
      const { cfg, pool, embedding } = await setup(pluginConfigOf(args.config));
      const outcome = await ingestOne(
        { cfg, pool, embedding },
        {
          text: p.text,
          source: "manual",
          kind: "fact",
          agentSessionId: args.sessionKey,
          agentId: agentIdFromSessionKey(args.sessionKey),
          importance: p.importance ?? (p.pinned ? 1.0 : 0.5),
          retentionClass: p.pinned ? "pinned" : "standard",
          anchors: {
            cwd: p.cwd,
            branch: p.branch,
            pr: p.pr,
            file: p.file,
          },
        },
      );

      const summary = outcome.decision === "accepted"
        ? `Stored. id=${outcome.chunkId}, path=${outcome.ingestPath}, score=${outcome.score.toFixed(1)}.`
        : outcome.decision === "merged"
        ? `Already known (merged with existing chunk ${outcome.chunkId}). No new write.`
        : `Did not store: ${outcome.decision}${outcome.rejectReason ? ` (${outcome.rejectReason})` : ""}.`;

      return {
        content: [{ type: "text", text: summary }],
        details: {
          decision: outcome.decision,
          rejectReason: outcome.rejectReason,
          chunkId: outcome.chunkId,
          ingestPath: outcome.ingestPath,
          routes: outcome.routes,
          score: outcome.score,
          llmTokensUsed: outcome.llmTokensUsed,
          latencyMs: outcome.latencyMs,
        },
      };
    },
  };
  return tool as unknown as AnyAgentTool;
}
