/**
 * Agent tools exposed by memory-postgres: `memory_search`, `memory_get`,
 * `memory_store`, `memory_update`, `memory_forget`.
 *
 * These are thin wrappers over the recall router, ingest pipeline, and
 * single-chunk edit ops so the agent can read/write long-term memory in turn.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, validateConfig } from "./config.js";
import { buildEmbeddingClientFromConfig } from "./embedding/client.js";
import { forgetChunk, getChunk, updateChunk } from "./edit/operations.js";
import { ingestOne } from "./ingest/pipeline.js";
import { recall } from "./recall/router.js";
import { getActiveCommitmentsByChunk } from "./structured/commitments.js";
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
    viewerUserId: {
      type: "string",
      description:
        "Advanced. The human asking. In multi-user groups, set this to scope recall to chunks visible to that specific user (per-user-global facts + group-public facts). Auto-derived from session key for DMs.",
    },
    viewerChatId: {
      type: "string",
      description:
        "Advanced. The chat the question was asked in (telegram chat id). Used together with viewerUserId for group privacy filtering. Omit for DM.",
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
  viewerUserId?: string;
  viewerChatId?: string;
};

/**
 * Best-effort viewer extraction from session keys.
 *
 *   agent:<aid>:telegram:direct:<userId>       → DM, viewer = userId
 *   agent:<aid>:telegram:group:<chatId>        → group, viewer.chatId only
 *   agent:<aid>:telegram:group:<chat>:topic:<t> → forum, chatId only
 *   agent:<aid>:main                            → legacy, no viewer
 *
 * Returns undefined fields when the session key doesn't encode them. The
 * caller (memory_search tool body) merges explicit params on top of these
 * inferences so Moderator-style callers can override.
 */
function viewerFromSessionKey(sessionKey: string | undefined): {
  userId?: string;
  chatId?: string;
} {
  if (!sessionKey) {return {};}
  // DM: agent:<aid>:<channel>:direct:<userId>
  const dm = /^agent:[^:]+:[^:]+:direct:([^:]+)/.exec(sessionKey);
  if (dm) {return { userId: dm[1] };}
  // Group: agent:<aid>:<channel>:group:<chatId>(:topic:<t>)?
  const grp = /^agent:[^:]+:[^:]+:group:([^:]+)/.exec(sessionKey);
  if (grp) {return { chatId: grp[1] };}
  return {};
}

type StoreParams = {
  text: string;
  importance?: number;
  pinned?: boolean;
  cwd?: string;
  branch?: string;
  pr?: string;
  file?: string;
};

const UPDATE_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["chunkId"],
  properties: {
    chunkId: { type: "string", description: "ID of the chunk to update (from prior memory_search result)." },
    text: { type: "string", minLength: 1, description: "Replacement text. When set, the chunk is re-embedded." },
    importance: { type: "number", minimum: 0, maximum: 1, description: "Override importance (0..1)." },
    pinned: { type: "boolean", description: "When true → retention_class='pinned' (never decays). When false → 'standard'." },
    reason: { type: "string", description: "Why you're updating this — recorded in the audit row." },
  },
} as const;

const FORGET_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["chunkId"],
  properties: {
    chunkId: { type: "string", description: "ID of the chunk to forget (from prior memory_search result)." },
    hardDelete: { type: "boolean", description: "When true, fully delete (breaks cold-gist back-references). When false (default), soft-trash so it stops appearing in recall but can be audited." },
    reason: { type: "string", description: "Why you're forgetting this — recorded in the audit row." },
  },
} as const;

type UpdateParams = {
  chunkId: string;
  text?: string;
  importance?: number;
  pinned?: boolean;
  reason?: string;
};

type ForgetParams = {
  chunkId: string;
  hardDelete?: boolean;
  reason?: string;
};

const GET_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["chunkId"],
  properties: {
    chunkId: { type: "string", description: "ID of the chunk to fetch in full (from a prior memory_search result)." },
  },
} as const;

type GetParams = {
  chunkId: string;
};

/**
 * Expected sessionKey shape: `agent:<agentId>:<sessionId>` (or longer with
 * trailing colons for channel-scoped keys). Pull out `<agentId>` so
 * memory_search / memory_store called from the `club` agent can never see
 * the `main` agent's chunks (and vice versa).
 *
 * Fail-closed: if the sessionKey is present but does NOT match the expected
 * shape, throw. Silently falling back to "main" was the original behavior,
 * but it means a future openclaw release that changes session-key formatting
 * could collapse multiple agents' memory namespaces into a single "main"
 * pool without anyone noticing — a privacy/isolation regression that's hard
 * to debug after the fact.
 *
 * An ABSENT sessionKey (undefined) still resolves to "main" because some
 * callers (manual ingest scripts, doctor probes) legitimately have no
 * session and the historical behavior treats those as the default agent.
 */
export function agentIdFromSessionKey(sessionKey: string | undefined): string {
  if (sessionKey === undefined || sessionKey === "") {return "main";}
  const m = /^agent:([^:]+):/.exec(sessionKey);
  if (!m) {
    throw new Error(
      `[memory-postgres] unrecognised sessionKey shape: ${JSON.stringify(sessionKey)} ` +
        `(expected 'agent:<agentId>:<sessionId>'). Refusing to fall back to ` +
        `'main' to avoid silent cross-agent memory leakage.`,
    );
  }
  return m[1];
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
  // Surface HNSW build failures (see index.ts service start for rationale).
  await ensureHnswIndex(pool).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[memory-postgres] HNSW index not built (T2 hybrid degrades to seq scan): ${
        (err as Error).message
      }`,
    );
  });
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
      // Viewer inference: start from session key, let explicit params override.
      const inferredViewer = viewerFromSessionKey(args.sessionKey);
      const viewer = {
        userId: p.viewerUserId ?? inferredViewer.userId,
        chatId: p.viewerChatId ?? inferredViewer.chatId,
      };
      const agentId = agentIdFromSessionKey(args.sessionKey);
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
          agentId,
          // Only attach viewer when we actually have something to filter on;
          // an empty viewer object signals "no filtering" to the router.
          viewer: viewer.userId || viewer.chatId ? viewer : undefined,
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

      // Action-sensitive flags: a recalled directive the agent might ACT on is
      // marked so it won't fire on a stray remark. Agent-scoped (isolation).
      const commitmentList = await getActiveCommitmentsByChunk(
        pool, result.results.map((c) => c.chunkId), agentId,
      );
      const commitmentByChunk = new Map<string, (typeof commitmentList)[number]>();
      for (const cm of commitmentList) {
        if (!commitmentByChunk.has(cm.chunkId)) {commitmentByChunk.set(cm.chunkId, cm);}
      }

      const lines = result.results.map((c, i) => {
        const tier = c.hits.join("+");
        const cm = commitmentByChunk.get(c.chunkId);
        const flag = cm
          ? cm.requiresConfirmation
            ? ` ⚠ ${cm.kind}: confirm with the user before acting`
            : ` ⚑ ${cm.kind}`
          : "";
        // Inline citation (full chunkId) so the model can attribute a claim and
        // re-fetch the complete text via memory_get. Same handle as
        // details.results[].citation below.
        return `${i + 1}. [${tier}]${flag} ${c.text.slice(0, 220)}\n   ↳ pg://${c.source}/${c.chunkId}`;
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
            citation: `pg://${c.source}/${c.chunkId}`,
            text: c.text,
            score: c.combinedScore,
            hits: c.hits,
            commitment: commitmentByChunk.get(c.chunkId) ?? null,
          })),
        },
      };
    },
  };
  return tool as unknown as AnyAgentTool;
}

export function buildUpdateTool(args: { config: OpenClawConfig; sessionKey?: string }): AnyAgentTool {
  const tool = {
    name: "memory_update",
    label: "Memory Update",
    description:
      "Rewrite or re-classify a chunk you previously stored. Use when you "
      + "learn the fact has changed (Yao's preferred language switched), when "
      + "you want to pin something important (importance=1.0 + pinned=true), or "
      + "when an earlier write was incorrect. Pass the chunkId from a recent "
      + "memory_search result. Per-agent isolation enforced.",
    parameters: UPDATE_PARAMS as unknown as AnyAgentTool["parameters"],
    async execute(this: void, _toolCallId: string, params: unknown): Promise<{ content: unknown; details: unknown }> {
      const p = params as UpdateParams;
      const { cfg, pool, embedding } = await setup(pluginConfigOf(args.config));
      const agentId = agentIdFromSessionKey(args.sessionKey);
      const outcome = await updateChunk(
        { cfg, pool, embedding },
        {
          chunkId: p.chunkId,
          agentId,
          text: p.text,
          importance: p.importance ?? (p.pinned === true ? 1.0 : undefined),
          retentionClass:
            p.pinned === true ? "pinned" : p.pinned === false ? "standard" : undefined,
          reason: p.reason,
        },
      );

      if (!outcome.ok) {
        return {
          content: [{ type: "text", text: `Update failed: ${outcome.reason}.` }],
          details: { decision: "rejected", reason: outcome.reason },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Updated chunk ${outcome.chunkId}${outcome.reEmbedded ? " (re-embedded)" : ""}.`,
          },
        ],
        details: { decision: "updated", chunkId: outcome.chunkId, reEmbedded: outcome.reEmbedded },
      };
    },
  };
  return tool as unknown as AnyAgentTool;
}

export function buildGetTool(args: { config: OpenClawConfig; sessionKey?: string }): AnyAgentTool {
  const tool = {
    name: "memory_get",
    label: "Memory Get",
    description:
      "Fetch one memory chunk in full by its id (the chunkId from a prior "
      + "memory_search result). Use when a search snippet was truncated and you "
      + "need the complete text plus provenance (source / citation). Read-only. "
      + "Per-agent isolation enforced — a chunk owned by another agent reads as not found.",
    parameters: GET_PARAMS as unknown as AnyAgentTool["parameters"],
    async execute(this: void, _toolCallId: string, params: unknown): Promise<{ content: unknown; details: unknown }> {
      const p = params as GetParams;
      const { cfg, pool, embedding } = await setup(pluginConfigOf(args.config));
      const agentId = agentIdFromSessionKey(args.sessionKey);
      const outcome = await getChunk({ cfg, pool, embedding }, { chunkId: p.chunkId, agentId });

      if (!outcome.ok) {
        return {
          content: [{ type: "text", text: `No memory chunk ${p.chunkId} (${outcome.reason}).` }],
          details: { found: false, reason: outcome.reason },
        };
      }
      const c = outcome.chunk;
      const cm = (await getActiveCommitmentsByChunk(pool, [c.chunkId], agentId))[0] ?? null;
      const flag = cm?.requiresConfirmation
        ? `\n⚠ action-sensitive (${cm.kind}) — confirm with the user before acting on this.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Memory chunk [${c.kind}, ${c.retentionClass}] — ${c.citation}\n${c.text}${flag}`,
          },
        ],
        details: { found: true, ...c, commitment: cm },
      };
    },
  };
  return tool as unknown as AnyAgentTool;
}

export function buildForgetTool(args: { config: OpenClawConfig; sessionKey?: string }): AnyAgentTool {
  const tool = {
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Mark a chunk as trash so it stops appearing in recall. Use for "
      + "outdated facts, mistaken writes, or anything the user explicitly "
      + "asks you to forget. Default is soft (retention_class='trash') — "
      + "the chunk still exists for audit but won't surface. Pass "
      + "hardDelete=true only if the user asks for true deletion. "
      + "Per-agent isolation enforced.",
    parameters: FORGET_PARAMS as unknown as AnyAgentTool["parameters"],
    async execute(this: void, _toolCallId: string, params: unknown): Promise<{ content: unknown; details: unknown }> {
      const p = params as ForgetParams;
      const { cfg, pool, embedding } = await setup(pluginConfigOf(args.config));
      const agentId = agentIdFromSessionKey(args.sessionKey);
      const outcome = await forgetChunk(
        { cfg, pool, embedding },
        {
          chunkId: p.chunkId,
          agentId,
          hardDelete: p.hardDelete === true,
          reason: p.reason,
        },
      );

      if (!outcome.ok) {
        return {
          content: [{ type: "text", text: `Forget failed: ${outcome.reason}.` }],
          details: { decision: "rejected", reason: outcome.reason },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Forgot chunk ${outcome.chunkId} (mode=${outcome.mode}).`,
          },
        ],
        details: {
          decision: outcome.mode === "tombstone" ? "tombstoned" : "trashed",
          chunkId: outcome.chunkId,
          mode: outcome.mode,
          deletedRow: outcome.deletedRow,
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
