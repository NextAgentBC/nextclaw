/**
 * Reflection worker — agent-active memory consolidation.
 *
 * Borrows the MemGPT/Karpathy "agent's wiki / sleep cycle" idea: once a
 * day, ask an LLM to read the last 24h of conversation chunks for each
 * agent_id and emit:
 *   - a one-paragraph reflection chunk (`kind='reflection'`) that serves
 *     as a high-level "what happened" entry the agent can recall later
 *   - optionally, a refreshed agent profile chunk (`kind='profile'`) that
 *     gets primed into T0 on every subsequent recall
 *
 * Deterministic stages of the ingest pipeline never call LLMs. This is
 * the FIRST LLM call in nextclaw's hot path. Two design choices keep it
 * sane:
 *   - Runs in the background (worker), never in a recall path
 *   - Default cadence is `enabled: false` — opt-in, not auto-on
 *   - Caps input tokens; if there's too much, takes the most recent slice
 *
 * Per-agent isolation: every read + write is `WHERE agent_id = $X` and
 * each agent's reflection is independent. A reflection over `agent:club`
 * never sees `agent:main` chunks.
 */

import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import pgvector from "pgvector/pg";
import type { ResolvedReflectionConfig } from "../config.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { buildReflectionClientFromConfig, type ReflectionClient } from "../embedding/reflection-client.js";

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MAX_INPUT_CHARS = 8000;

const SYSTEM_PROMPT = `You are a memory-consolidation worker for a long-lived AI assistant.
You receive a chronological dump of recent conversation chunks for ONE agent + ONE user.
Your job is to produce a short, structured summary of what changed in the user's
life, work, projects, or preferences in this window.

Output exactly two sections, separated by a blank line:

REFLECTION:
A 2-4 sentence factual summary in the user's primary language. No prose flourishes.
Focus on durable changes: new facts, decisions, plans, problems-and-resolutions.
Skip greetings, small talk, debugging chatter that won't matter next week.

PROFILE_DELTA:
A flat list of bullets, one per line, of facts that should LIVE in the agent's
profile of this user. Use this format:
- <fact category>: <fact>
Examples:
- preference: 用户偏好简洁的中文回复，不要客套
- project: maintains nextclaw memory plugin (Postgres + pgvector)
- person: child name is Mason, ~8 years old, learning English

Skip PROFILE_DELTA entirely if nothing durable changed.`;

export type ReflectionDeps = {
  pool: Pool;
  embedding: EmbeddingClient;
  /** Reflection LLM client (lazily built from config). */
  llm: ReflectionClient;
  /** Resolved reflection config from config.ts. */
  cfg: ResolvedReflectionConfig;
};

export type ReflectionOutcome = {
  agentId: string;
  ok: boolean;
  reflectionChunkId?: string;
  profileChunksWritten?: number;
  chunksConsidered: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
};

export async function runReflectionForAllAgents(
  deps: ReflectionDeps,
): Promise<ReflectionOutcome[]> {
  // Find which agents have new material in the lookback window.
  const lookbackHours = deps.cfg.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const rows = await deps.pool.query<{ agent_id: string; n: number }>(
    `SELECT agent_id, count(*)::int AS n
       FROM semantic.chunks
      WHERE created_at > now() - ($1 || ' hours')::interval
        AND retention_class IN ('standard', 'pinned')
        AND kind NOT IN ('reflection', 'profile')
      GROUP BY agent_id`,
    [String(lookbackHours)],
  );
  const out: ReflectionOutcome[] = [];
  for (const r of rows.rows) {
    out.push(await runReflectionForAgent(deps, r.agent_id, r.n));
  }
  return out;
}

export async function runReflectionForAgent(
  deps: ReflectionDeps,
  agentId: string,
  expectedChunks?: number,
): Promise<ReflectionOutcome> {
  const start = Date.now();
  const lookbackHours = deps.cfg.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const maxChars = deps.cfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

  // Load the most recent N chunks for this agent within the window.
  // ORDER BY created_at DESC + LIMIT so we always grab the freshest if
  // there are too many; the prompt cap is char-based.
  const rows = await deps.pool.query<{
    id: string; text: string; source: string; created_at: Date; kind: string;
  }>(
    `SELECT id, text, source, created_at, kind
       FROM semantic.chunks
      WHERE agent_id = $1
        AND created_at > now() - ($2 || ' hours')::interval
        AND retention_class IN ('standard', 'pinned')
        AND kind NOT IN ('reflection', 'profile')
      ORDER BY created_at DESC
      LIMIT 500`,
    [agentId, String(lookbackHours)],
  );

  if (rows.rowCount === 0) {
    return {
      agentId,
      ok: true,
      chunksConsidered: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - start,
    };
  }

  // Build a chronological dump (oldest first inside the cap).
  const ordered = rows.rows.toReversed();
  let dump = "";
  let considered = 0;
  for (const c of ordered) {
    const line = `[${c.created_at.toISOString()}] (${c.source}) ${c.text}\n`;
    if (dump.length + line.length > maxChars) {break;}
    dump += line;
    considered += 1;
  }

  const userPrompt = `Agent id: ${agentId}\nWindow: last ${lookbackHours} hours.\nChunks (chronological):\n\n${dump}`;
  const llmResult = await deps.llm.chat({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxOutputTokens: 800,
    temperature: 0.3,
  });

  if (!llmResult.ok) {
    return {
      agentId,
      ok: false,
      chunksConsidered: considered,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - start,
      error: llmResult.error,
    };
  }

  // Parse the response into REFLECTION + PROFILE_DELTA sections.
  const { reflection, profileBullets } = parseReflectionOutput(llmResult.text);

  if (!reflection) {
    return {
      agentId,
      ok: true,
      chunksConsidered: considered,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      latencyMs: Date.now() - start,
    };
  }

  // Write the reflection chunk (kind='reflection').
  const reflectionId = await writeChunk(deps, {
    agentId,
    text: reflection,
    kind: "reflection",
    source: "reflection-worker",
    retentionClass: "standard",
    importance: 0.6,
  });

  // Upsert profile chunks (one per bullet). Each becomes a pinned T0
  // resident. Future reflection runs add more or refresh older ones via
  // dedup-on-text-hash (the unique index on (text_hash, source) means
  // identical bullets coalesce naturally).
  let profileWritten = 0;
  for (const bullet of profileBullets) {
    const trimmed = bullet.replace(/^[-*]\s*/, "").trim();
    if (trimmed.length < 8) {continue;}
    const id = await writeChunk(deps, {
      agentId,
      text: trimmed,
      kind: "profile",
      source: "reflection-worker",
      retentionClass: "pinned",
      importance: 0.9,
    });
    if (id) {profileWritten += 1;}
  }

  return {
    agentId,
    ok: true,
    reflectionChunkId: reflectionId ?? undefined,
    profileChunksWritten: profileWritten,
    chunksConsidered: considered,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    latencyMs: Date.now() - start,
  };
}

function parseReflectionOutput(text: string): { reflection: string; profileBullets: string[] } {
  const parts = text.split(/\n\s*PROFILE_DELTA\s*:\s*\n/i);
  const headBody = parts[0] ?? "";
  const tail = parts[1] ?? "";
  // Strip "REFLECTION:" header if present.
  const reflection = headBody.replace(/^\s*REFLECTION\s*:\s*/i, "").trim();
  const profileBullets = tail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-") || l.startsWith("*"));
  return { reflection, profileBullets };
}

async function writeChunk(
  deps: ReflectionDeps,
  params: {
    agentId: string;
    text: string;
    kind: string;
    source: string;
    retentionClass: "standard" | "pinned";
    importance: number;
  },
): Promise<string | null> {
  // Embed; if it fails, skip writing rather than abort the whole reflection.
  const trimmed = params.text.slice(0, 4000);
  const embed = await deps.embedding.embed({ inputs: [trimmed] }).catch(() => null);
  if (!embed || embed.embeddings.length === 0) {return null;}

  const id = randomUUID();
  const textHash = createHash("sha256").update(trimmed, "utf8").digest();
  try {
    await deps.pool.query(
      `INSERT INTO semantic.chunks
         (id, source, source_ref, kind, text, text_hash, embedding,
          embedding_model, agent_session_id, agent_id, retention_class,
          importance, created_at)
       VALUES ($1, $2, null, $3, $4, $5, $6::vector,
               $7, null, $8, $9, $10, now())
       ON CONFLICT (text_hash, source) DO UPDATE
         SET importance = GREATEST(semantic.chunks.importance, EXCLUDED.importance),
             retention_class = CASE
                                 WHEN EXCLUDED.retention_class = 'pinned' THEN 'pinned'
                                 ELSE semantic.chunks.retention_class
                               END`,
      [
        id,
        params.source,
        params.kind,
        trimmed,
        textHash,
        pgvector.toSql(embed.embeddings[0] ?? []),
        embed.model,
        params.agentId,
        params.retentionClass,
        params.importance,
      ],
    );
    return id;
  } catch {
    return null;
  }
}

/* ----------------------- daemon (interval scheduling) ---------------------- */

export type ReflectionDaemonHandle = { stop: () => void };

export function startReflectionDaemon(args: {
  deps: ReflectionDeps;
  intervalMs: number;
  logger: { info: (m: string) => void; warn: (m: string) => void };
}): ReflectionDaemonHandle {
  // Run once 5 min after start so the first day isn't empty.
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) {return;}
    try {
      const outcomes = await runReflectionForAllAgents(args.deps);
      const anyWork = outcomes.some(
        (o) => (o.reflectionChunkId !== undefined) || (o.profileChunksWritten ?? 0) > 0,
      );
      if (anyWork) {
        const summary = outcomes
          .map((o) =>
            o.ok
              ? `${o.agentId}:${o.chunksConsidered}c/${o.profileChunksWritten ?? 0}p`
              : `${o.agentId}:err(${o.error})`,
          )
          .join(" ");
        args.logger.info(`memory-postgres: reflection tick — ${summary}`);
      }
    } catch (err) {
      args.logger.warn(`memory-postgres: reflection tick failed: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(() => void tick(), args.intervalMs);
  timer.unref?.();
  const initialTimer = setTimeout(() => void tick(), 5 * 60_000);
  initialTimer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(initialTimer);
    },
  };
}

/** Convenience for index.ts: instantiate the LLM client from resolved config. */
export function buildReflectionClient(cfg: ResolvedReflectionConfig): ReflectionClient {
  return buildReflectionClientFromConfig({
    baseUrl: cfg.model.baseUrl,
    model: cfg.model.model,
    format: cfg.model.format,
    apiKeyEnv: cfg.model.apiKeyEnv,
  });
}
