/**
 * Shadow model comparator.
 *
 * For each gpt-5.5 turn observed in the agent's `<sessionId>.trajectory.jsonl`,
 * replays the same prompt against a challenger chat endpoint (qwen3.6 by
 * default) and stores both sides in `audit.model_comparisons`. Lets the operator see
 * side-by-side cost/latency/output without affecting the live Discord reply.
 *
 *   poll → for each new turn → load prompt.submitted + model.completed
 *        → POST messages to challenger → store both sides
 *
 * Idempotent: per-trajectory byte offset is persisted in `audit.plugin_meta`,
 * and a (run_id, ch_model) UNIQUE constraint stops double-inserts on retry.
 *
 * Best-effort: a 5xx from the challenger or a malformed trajectory line just
 * advances the offset and logs to ch_error; never blocks the live agent.
 */

import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { ResolvedShadowComparator } from "../config.js";
import { buildChatClient, type ChatMessage } from "../embedding/chat-client.js";

/* --------------------------------- types --------------------------------- */

type TrajectoryEvent = {
  type?: string;
  ts?: string;
  runId?: string;
  sessionId?: string;
  modelId?: string;
  data?: Record<string, unknown>;
};

type Turn = {
  runId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  promptSubmittedAt?: string;
  modelCompletedAt?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  userPrompt?: string;
  modelId?: string;
  baseLatencyMs?: number;
  baseInputTokens?: number;
  baseOutputTokens?: number;
  baseCacheRead?: number;
  baseToolCount?: number;
  baseOutput?: string;
  /** Final byte offset where this turn's events end in the file. */
  endOffset: number;
};

export type ShadowDeps = {
  pool: Pool;
  comparator: ResolvedShadowComparator;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
};

export type ShadowTickResult = {
  comparatorId: string;
  filesScanned: number;
  turnsSeen: number;
  shadowsRun: number;
  shadowsFailed: number;
  errors: string[];
};

/* --------------------------------- helpers -------------------------------- */

const META_KEY = (cid: string, sessionId: string): string =>
  `shadow_comparator.${cid}.${sessionId}.offset`;

async function readOffset(pool: Pool, cid: string, sessionId: string): Promise<number> {
  const rows = await pool.query<{ value: { offset?: number } }>(
    "SELECT value FROM audit.plugin_meta WHERE key = $1",
    [META_KEY(cid, sessionId)],
  );
  const v = rows.rows[0]?.value?.offset;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

async function writeOffset(pool: Pool, cid: string, sessionId: string, offset: number): Promise<void> {
  await pool.query(
    `INSERT INTO audit.plugin_meta (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [META_KEY(cid, sessionId), JSON.stringify({ offset })],
  );
}

function hashMessages(msgs: ChatMessage[]): Buffer {
  const h = createHash("sha256");
  for (const m of msgs) {
    h.update(m.role);
    h.update("\0");
    h.update(m.content);
    h.update("\0");
  }
  return h.digest();
}

/** Best-effort coercion of an unknown messages payload into ChatMessage[]. */
function coerceMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {return [];}
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") {continue;}
    const obj = m as Record<string, unknown>;
    const role = String(obj["role"] ?? "user");
    const content = obj["content"];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // OpenAI-style content blocks: [{ type: "text", text: "..." }, ...]
      for (const part of content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p["text"] === "string") {text += p["text"];}
          else if (typeof p["content"] === "string") {text += p["content"];}
        } else if (typeof part === "string") {
          text += part;
        }
      }
    }
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {continue;}
    if (!text) {continue;}
    out.push({ role: role as ChatMessage["role"], content: text });
  }
  return out;
}

/* ------------------------- trajectory scanning --------------------------- */

async function readTurnsSinceOffset(
  filePath: string,
  startOffset: number,
): Promise<{ turns: Turn[]; finalOffset: number }> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return { turns: [], finalOffset: startOffset };
  }
  if (info.size <= startOffset) {return { turns: [], finalOffset: info.size }; }

  const handle = await open(filePath, "r");
  try {
    const len = info.size - startOffset;
    const buf = Buffer.allocUnsafe(len);
    await handle.read(buf, 0, len, startOffset);
    const text = buf.toString("utf8");

    // Group new events by runId.
    const byRun = new Map<string, Record<string, TrajectoryEvent>>();
    let consumedBytes = 0;
    let lastRunId: string | undefined;
    const lines = text.split("\n");

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // include the \n
      if (line) {
        try {
          const ev = JSON.parse(line) as TrajectoryEvent;
          const rid = ev.runId;
          if (rid) {
            let bucket = byRun.get(rid);
            if (!bucket) { bucket = {}; byRun.set(rid, bucket); }
            if (ev.type) {bucket[ev.type] = ev;}
            lastRunId = rid;
          }
        } catch {/* skip malformed line */}
      }
      consumedBytes += lineBytes;
    }
    // Only keep turns whose `session.ended` is present — skip the in-flight run.
    const turns: Turn[] = [];
    for (const [runId, evs] of byRun) {
      if (!evs["session.ended"] || !evs["model.completed"] || !evs["prompt.submitted"] || !evs["session.started"]) {continue;}
      const submitted = evs["prompt.submitted"];
      const completed = evs["model.completed"];
      const started = evs["session.started"];
      const ended = evs["session.ended"];
      const subData = (submitted.data ?? {}) as Record<string, unknown>;
      const compData = (completed.data ?? {}) as Record<string, unknown>;
      const usage = (compData["usage"] ?? {}) as Record<string, unknown>;
      const messages = coerceMessages(subData["messages"]);
      const userPrompt = typeof subData["prompt"] === "string" ? (subData["prompt"] as string) : undefined;
      const systemPrompt = typeof subData["systemPrompt"] === "string"
        ? (subData["systemPrompt"] as string)
        : undefined;
      // Build the message list used to prompt: system + history. Some
      // trajectories already include the system message in `messages`; if
      // not, prepend it ourselves.
      const finalMsgs: ChatMessage[] = [];
      if (systemPrompt && !messages.some((m) => m.role === "system")) {
        finalMsgs.push({ role: "system", content: systemPrompt });
      }
      finalMsgs.push(...messages);
      // If the trajectory captured the user prompt separately rather than as
      // the last message, append it.
      if (userPrompt && (finalMsgs.length === 0 || finalMsgs[finalMsgs.length - 1].role !== "user" || finalMsgs[finalMsgs.length - 1].content !== userPrompt)) {
        finalMsgs.push({ role: "user", content: userPrompt });
      }
      const lastUser = [...finalMsgs].reverse().find((m) => m.role === "user")?.content;
      const baseStart = submitted.ts ? Date.parse(submitted.ts) : 0;
      const baseEnd = completed.ts ? Date.parse(completed.ts) : 0;
      const baseLatencyMs = baseStart && baseEnd ? baseEnd - baseStart : undefined;
      const assistantTexts = compData["assistantTexts"];
      const baseOutput = Array.isArray(assistantTexts) ? assistantTexts.join("\n").slice(0, 4000) : "";
      const toolMetas = compData["toolMetas"];
      const baseToolCount = Array.isArray(toolMetas) ? toolMetas.length : 0;
      turns.push({
        runId,
        sessionId: started.sessionId ?? evs["session.ended"]?.sessionId ?? "",
        startedAt: started.ts ?? "",
        endedAt: ended.ts,
        promptSubmittedAt: submitted.ts,
        modelCompletedAt: completed.ts,
        messages: finalMsgs,
        systemPrompt,
        userPrompt: lastUser,
        modelId: typeof completed.modelId === "string" ? completed.modelId : undefined,
        baseLatencyMs,
        baseInputTokens: typeof usage["input"] === "number" ? (usage["input"] as number) : undefined,
        baseOutputTokens: typeof usage["output"] === "number" ? (usage["output"] as number) : undefined,
        baseCacheRead: typeof usage["cacheRead"] === "number" ? (usage["cacheRead"] as number) : undefined,
        baseToolCount,
        baseOutput,
        endOffset: startOffset + consumedBytes,
      });
    }
    void lastRunId;
    turns.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return { turns, finalOffset: startOffset + consumedBytes };
  } finally {
    await handle.close();
  }
}

/* --------------------------------- ingest -------------------------------- */

async function shadowExists(pool: Pool, runId: string, chModel: string): Promise<boolean> {
  const r = await pool.query(
    "SELECT 1 FROM audit.model_comparisons WHERE trajectory_run_id = $1 AND ch_model = $2",
    [runId, chModel],
  );
  return (r.rowCount ?? 0) > 0;
}

async function insertComparison(
  pool: Pool,
  row: {
    runId: string;
    sessionId: string;
    userMessage: string | undefined;
    promptHash: Buffer;
    baseModel: string;
    baseLatencyMs: number | undefined;
    baseInTokens: number | undefined;
    baseOutTokens: number | undefined;
    baseCacheRead: number | undefined;
    baseOutput: string | undefined;
    baseToolCount: number;
    chModel: string;
    chEndpoint: string;
    chLatencyMs: number | undefined;
    chInTokens: number | undefined;
    chOutTokens: number | undefined;
    chOutput: string | undefined;
    chError: string | undefined;
  },
): Promise<void> {
  const speedRatio = row.baseLatencyMs && row.chLatencyMs && row.chLatencyMs > 0
    ? row.baseLatencyMs / row.chLatencyMs
    : null;
  const outLenRatio = row.baseOutput && row.chOutput && row.chOutput.length > 0
    ? row.baseOutput.length / row.chOutput.length
    : null;
  await pool.query(
    `INSERT INTO audit.model_comparisons (
        id, trajectory_run_id, agent_session_id, user_message, prompt_hash,
        base_model, base_latency_ms, base_in_tokens, base_out_tokens,
        base_cache_read, base_output, base_tool_count,
        ch_model, ch_endpoint, ch_latency_ms, ch_in_tokens, ch_out_tokens,
        ch_output, ch_error,
        speed_ratio, out_len_ratio
     ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16, $17,
        $18, $19,
        $20, $21
     )
     ON CONFLICT (trajectory_run_id, ch_model) DO NOTHING`,
    [
      randomUUID(),
      row.runId, row.sessionId, row.userMessage ?? null, row.promptHash,
      row.baseModel, row.baseLatencyMs ?? null, row.baseInTokens ?? null, row.baseOutTokens ?? null,
      row.baseCacheRead ?? null, row.baseOutput ?? null, row.baseToolCount,
      row.chModel, row.chEndpoint, row.chLatencyMs ?? null, row.chInTokens ?? null, row.chOutTokens ?? null,
      row.chOutput ?? null, row.chError ?? null,
      speedRatio, outLenRatio,
    ],
  );
}

/* --------------------------------- entry ---------------------------------- */

export async function runShadowComparatorTick(deps: ShadowDeps): Promise<ShadowTickResult> {
  const out: ShadowTickResult = {
    comparatorId: deps.comparator.id,
    filesScanned: 0,
    turnsSeen: 0,
    shadowsRun: 0,
    shadowsFailed: 0,
    errors: [],
  };
  let entries: string[] = [];
  try {
    entries = await readdir(deps.comparator.trajectoryDir);
  } catch (err) {
    out.errors.push(`readdir failed: ${(err as Error).message}`);
    return out;
  }
  const files = entries.filter((e) => e.endsWith(".trajectory.jsonl"));
  const cutoff = Date.now() - deps.comparator.backfillWindowMs;
  const client = buildChatClient({
    baseUrl: deps.comparator.baseUrl,
    model: deps.comparator.model,
    apiKeyEnv: deps.comparator.apiKeyEnv,
    timeoutMs: deps.comparator.requestTimeoutMs,
  });

  for (const f of files) {
    out.filesScanned += 1;
    const sessionId = f.replace(".trajectory.jsonl", "");
    const filePath = path.join(deps.comparator.trajectoryDir, f);
    const offset = await readOffset(deps.pool, deps.comparator.id, sessionId);
    let scan: { turns: Turn[]; finalOffset: number };
    try {
      scan = await readTurnsSinceOffset(filePath, offset);
    } catch (err) {
      out.errors.push(`read ${sessionId}: ${(err as Error).message}`);
      continue;
    }
    out.turnsSeen += scan.turns.length;
    for (const turn of scan.turns) {
      // Backfill cutoff: ignore stale turns at startup.
      if (turn.startedAt && Date.parse(turn.startedAt) < cutoff) {continue;}
      // Min length gate (don't waste GPU on "ok"-style turns).
      if ((turn.userPrompt?.length ?? 0) < deps.comparator.minUserMessageChars) {continue;}
      if (!turn.messages || turn.messages.length === 0) {continue;}

      // Idempotency: skip if already shadowed.
      try {
        if (await shadowExists(deps.pool, turn.runId, client.model)) {continue;}
      } catch (err) {
        out.errors.push(`exists check ${turn.runId}: ${(err as Error).message}`);
        continue;
      }

      // Run the challenger.
      const chReq = {
        messages: turn.messages,
        maxTokens: deps.comparator.maxOutputTokens,
      };
      const resp = await client.chat(chReq);
      out.shadowsRun += 1;

      const promptHash = hashMessages(turn.messages);
      try {
        await insertComparison(deps.pool, {
          runId: turn.runId,
          sessionId: turn.sessionId,
          userMessage: turn.userPrompt,
          promptHash,
          baseModel: turn.modelId ?? "gpt-5.5",
          baseLatencyMs: turn.baseLatencyMs,
          baseInTokens: turn.baseInputTokens,
          baseOutTokens: turn.baseOutputTokens,
          baseCacheRead: turn.baseCacheRead,
          baseOutput: turn.baseOutput,
          baseToolCount: turn.baseToolCount ?? 0,
          chModel: client.model,
          chEndpoint: client.endpoint,
          chLatencyMs: resp.wallMs,
          chInTokens: resp.ok ? resp.inputTokens : undefined,
          chOutTokens: resp.ok ? resp.outputTokens : undefined,
          chOutput: resp.ok ? resp.content : undefined,
          chError: resp.ok ? undefined : resp.error,
        });
        if (!resp.ok) {out.shadowsFailed += 1;}
      } catch (err) {
        out.errors.push(`insert ${turn.runId}: ${(err as Error).message}`);
      }
    }
    if (scan.finalOffset !== offset) {
      try {
        await writeOffset(deps.pool, deps.comparator.id, sessionId, scan.finalOffset);
      } catch (err) {
        out.errors.push(`offset write ${sessionId}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

export function startShadowComparator(deps: ShadowDeps): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) {return;}
    try {
      const r = await runShadowComparatorTick(deps);
      if (r.shadowsRun > 0 || r.errors.length > 0) {
        deps.logger?.info(
          `[shadow:${deps.comparator.id}] turns=${r.turnsSeen} shadowed=${r.shadowsRun} ` +
            `failed=${r.shadowsFailed} errors=${r.errors.length}`,
        );
      }
    } catch (err) {
      deps.logger?.warn(`[shadow:${deps.comparator.id}] tick failed: ${(err as Error).message}`);
    }
    if (!stopped) {timer = setTimeout(tick, deps.comparator.intervalMs);}
  };
  // Defer first tick a few seconds so PG pool is ready and we don't race
  // the gateway boot.
  timer = setTimeout(tick, 5000);
  return {
    stop: () => {
      stopped = true;
      if (timer) {clearTimeout(timer);}
    },
  };
}
