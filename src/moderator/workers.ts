/**
 * Worker dispatch — Phase D.
 *
 * Anthropic-orchestrator-worker pattern: the Moderator picks `answerTasks`,
 * we spawn ONE LLM call per task (parallel if `canParallel:true`), inject
 * relevant memory from the recall pipeline, return the answer text, and
 * write the (question → answer) pair back to cache.qa so the next identical
 * or near-identical question hits the pre-check and skips all this work.
 *
 * Design constraints (per "infra not reasoning" principle):
 *   - Role specs live in `moderator.worker_roles`. A missing role falls back
 *     to DEFAULT_ROLE — we don't crash if Moderator picks a new roleKey on
 *     the fly. New roleKeys auto-register on first use (Phase D does NOT
 *     auto-register yet; that's a Phase E concern — for now, missing role
 *     just uses DEFAULT_ROLE silently).
 *   - The worker system prompt is INTENTIONALLY thin. Add domain logic in
 *     the role's `system_prompt` column, NOT here. A stronger LLM should
 *     not see our hard-coded reasoning rules.
 *   - Cache write-back is fire-and-forget; failure does not break the user
 *     reply path.
 */

import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AnswerTask } from "./types.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { recall } from "../recall/router.js";
import type { ViewerScope } from "../recall/viewer-scope.js";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import { storeCachedAnswer } from "../cache/qa.js";
import { chatSingle, exportToolResultsAsHistory, type WorkerLlmClient } from "./worker-llm.js";
import { executeToolsBatch, resolveTools, type ToolCall } from "./worker-tools.js";

export type WorkerDeps = {
  pool: Pool;
  /** Tool-aware LLM client (uses Gemini's :generateContent endpoint). */
  workerLlm: WorkerLlmClient;
  embedding: EmbeddingClient;
  cfg: ResolvedMemoryPostgresConfig;
  agentId: string;
  logger: { info: (m: string) => void; warn: (m: string) => void };
};

export type RoleSpec = {
  roleKey: string;
  displayName: string;
  systemPrompt: string;
  /** Reserved for Phase E (currently ignored — workers don't have tools). */
  tools: string[];
  /** memory_scope filter hints for recall (topic/kind). */
  memoryScope: { topic?: string; kind?: string };
  /** Model identifier; advisory only for Phase D (we use the injected
   *  llm regardless). Phase E will respect this. */
  model: string;
};

/**
 * Minimal default role used when no DB row matches the Moderator's
 * `roleKey`. Keep the prompt short — domain logic belongs in DB rows.
 */
/**
 * "Swiss Army worker" — out-of-the-box tools so the worker isn't useless
 * when the Moderator falls back to it. Specialized roles can override by
 * passing a narrower `tools` list at registration time.
 *
 * Empty `tools` on a stored role row → INHERITS these defaults (see
 * loadRoleSpec). To get a genuinely tool-less role, register with
 * `tools=['__none__']` — resolveTools() filters unknowns to [].
 *
 * The systemPrompt here is intentionally MINIMAL — almost no formatting
 * rules. The user feedback "还是非常死板，不自由，限制了" came from a
 * verbose DEFAULT_ROLE prompt that mandated "3 段以内 / 简洁 / 不加
 * emoji". Each rule trims the model's degrees of freedom — the
 * cumulative effect is a corporate-sounding bullet-list robot. Letting
 * the model choose length and format from context produces more natural
 * answers. The baseline preamble (below) covers the essential
 * guarantees (language match, tool use); everything else is left to
 * the model's judgment.
 */
const DEFAULT_ROLE: RoleSpec = {
  roleKey: "default",
  displayName: "默认助手",
  systemPrompt:
    "你是一个能上网搜索、能回忆群里历史的助手。像跟朋友聊天那样自然地回答——长短、" +
    "口吻、要不要列点都看问题本身决定，不用套格式。",
  tools: ["memory_search", "web_search"],
  memoryScope: {},
  model: "gemini:gemini-2.5-flash",
};

/* --------------------------- role auto-register --------------------------- */

/**
 * Cap on agent-created roles per agent_id. Hard guard against a runaway
 * Moderator polluting the registry with garbage roleKeys. Operator-seeded
 * rows (created_by_scope IS NULL) don't count toward the limit.
 */
const MAX_AGENT_CREATED_ROLES = 200;

/**
 * Insert a new worker role if it doesn't already exist. Operator-seeded
 * rows (with no `created_by_scope`) always win — if a row exists for
 * this (agent_id, role_key), we DO NOT overwrite. Returns true if a row
 * was actually inserted.
 *
 * Why first-write-wins for agent rows: the Moderator's first design for
 * a roleKey is the canonical one. If a later decision proposes a
 * different prompt for the SAME key, that's a sign the model is
 * confused — better to use the original than churn the registry.
 */
export async function upsertWorkerRole(
  pool: Pool,
  agentId: string,
  roleKey: string,
  spec: NonNullable<import("./types.js").AnswerTask["newRoleSpec"]>,
  createdByScope: string,
): Promise<boolean> {
  // Soft cap — refuse silently if the agent has too many roles already.
  const cnt = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM moderator.worker_roles
     WHERE agent_id = $1 AND created_by_scope IS NOT NULL`,
    [agentId],
  );
  if (Number.parseInt(cnt.rows[0]?.n ?? "0", 10) >= MAX_AGENT_CREATED_ROLES) {
    return false;
  }
  // Whitelist: only allow tool names that actually exist in the registry.
  // We never trust the LLM-supplied tool name verbatim — a typo or
  // hallucinated tool would silently never run, but at least we don't
  // store garbage in the DB.
  const { listAvailableToolNames } = await import("./worker-tools.js");
  const known = new Set(listAvailableToolNames());
  const requestedTools = Array.isArray(spec.tools)
    ? spec.tools.filter((t): t is string => typeof t === "string" && known.has(t))
    : [];

  const r = await pool.query(
    `INSERT INTO moderator.worker_roles
       (id, agent_id, role_key, display_name, system_prompt, tools,
        memory_scope, model, created_by_scope)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::text[],
             $6::jsonb, $7, $8)
     ON CONFLICT (agent_id, role_key) DO NOTHING
     RETURNING id`,
    [
      agentId,
      roleKey,
      spec.displayName ?? roleKey,
      spec.systemPrompt,
      requestedTools,
      JSON.stringify(spec.memoryScope ?? {}),
      DEFAULT_ROLE.model, // model preference inherits default; can be tuned per-row later
      createdByScope,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/* ----------------------------- role loading ------------------------------- */

export async function loadRoleSpec(
  pool: Pool,
  agentId: string,
  roleKey: string,
): Promise<RoleSpec> {
  const r = await pool.query<{
    role_key: string;
    display_name: string | null;
    system_prompt: string;
    tools: string[];
    memory_scope: Record<string, unknown>;
    model: string;
  }>(
    `SELECT role_key, display_name, system_prompt, tools, memory_scope, model
     FROM moderator.worker_roles
     WHERE agent_id = $1 AND role_key = $2 AND active = TRUE
     LIMIT 1`,
    [agentId, roleKey],
  );
  const row = r.rows[0];
  if (!row) {
    return { ...DEFAULT_ROLE, roleKey }; // keep the requested key for traceability
  }
  // Tool resolution: DEFAULT_ROLE.tools is the FLOOR. Stored tools can
  // ADD specialized tools (kb_lookup, escalate_to_human, ...) but cannot
  // strip the baseline kit. This was learned the hard way: a Moderator-
  // coined `general_knowledge_explainer` role wrote `tools=['memory_search']`
  // (no web_search) and the worker then replied "I cannot browse the
  // internet" to a research question — even though the runtime had the
  // tool registered. By unioning, we guarantee web_search is always at
  // least available; the model still decides whether to call it.
  const storedTools = row.tools ?? [];
  const effectiveTools = Array.from(new Set([...DEFAULT_ROLE.tools, ...storedTools]));
  return {
    roleKey: row.role_key,
    displayName: row.display_name ?? row.role_key,
    systemPrompt: row.system_prompt,
    tools: effectiveTools,
    memoryScope: (row.memory_scope ?? {}) as { topic?: string; kind?: string },
    model: row.model,
  };
}

/* --------------------------- single-task dispatch ------------------------- */

export type WorkerResult = {
  taskId: string;
  roleKey: string;
  ok: boolean;
  answer: string;
  /** Verbatim user question text (mention-stripped) used for cache key + log. */
  questionText: string;
  /** topic_tag we'll store with the cache row (for taxonomy + future filters). */
  topicTag: string | undefined;
  llm: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  };
  /** How many memory chunks were merged into the prompt (proactive recall, NOT tool). */
  recallCount: number;
  /** Tool calls the model invoked during this dispatch (if any). */
  toolCalls?: ToolCall[];
  errors: string[];
};

const MAX_RECALL_CHUNKS = 5;
const MAX_CHUNK_CHARS = 400;
// Loosened from 800 → 1500 so the model can stretch when a question
// warrants depth; the preamble tells it to be concise when not warranted.
const WORKER_MAX_OUTPUT_TOKENS = 1500;
// Loosened from 0.4 → 0.7 — at 0.4 the model fell into a corporate
// bullet-list rut. 0.7 gets more natural prose without veering into
// unreliable territory.
const WORKER_TEMPERATURE = 0.7;

/**
 * Strips Telegram @-mentions and collapses whitespace so the cache key
 * stays clean. Mirrors `cleanQuestionText` in cache-precheck.ts — KEEP
 * THE TWO IN SYNC or cache writes won't match precheck reads.
 */
export function cleanQuestionText(text: string): string {
  return text
    .replace(/@[A-Za-z0-9_]{3,32}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function dispatchWorker(
  deps: WorkerDeps,
  task: AnswerTask,
  viewer: ViewerScope | undefined,
  /** Raw question text from the user (pre-cleaning). */
  userQuestion: string,
  /** Scope key the Moderator is acting in, e.g. `tg:chat:-100...`. Used to
   *  attribute newly-registered roles so we can audit which scope coined them. */
  scopeKey: string,
): Promise<WorkerResult> {
  // If the Moderator declared a new specialist inline, persist it BEFORE
  // loading the role spec. First-write-wins via ON CONFLICT DO NOTHING,
  // so a race between two parallel tasks for the same brand-new key is
  // safe — both insert attempts coalesce, both subsequent loads see the
  // same row. Failure to upsert (e.g. cap reached) just falls back to
  // DEFAULT_ROLE, mirroring the pre-leverage behavior.
  if (task.newRoleSpec) {
    try {
      const created = await upsertWorkerRole(
        deps.pool,
        deps.agentId,
        task.roleKey,
        task.newRoleSpec,
        scopeKey,
      );
      if (created) {
        deps.logger.info(
          `worker[${task.taskId}]: registered new role '${task.roleKey}' (${task.newRoleSpec.systemPrompt.length} chars)`,
        );
      }
    } catch (e) {
      deps.logger.warn(`worker[${task.taskId}]: role upsert failed: ${(e as Error).message}`);
    }
  }
  const role = await loadRoleSpec(deps.pool, deps.agentId, task.roleKey);
  const cleanedQ = cleanQuestionText(userQuestion);
  const topicTag = task.memoryScope?.topic ?? role.memoryScope.topic;

  // --- Memory recall (best-effort; failures don't block the answer) ---
  let recallText = "";
  let recallCount = 0;
  try {
    const rr = await recall(
      { cfg: deps.cfg, pool: deps.pool, embedding: deps.embedding },
      {
        query: cleanedQ,
        maxResults: MAX_RECALL_CHUNKS,
        agentId: deps.agentId,
        viewer,
        conceptTags: topicTag ? [topicTag] : undefined,
      },
    );
    if (rr.results.length > 0) {
      recallCount = rr.results.length;
      const lines = rr.results
        .slice(0, MAX_RECALL_CHUNKS)
        .map((c, i) => {
          const text = (c.text ?? "").slice(0, MAX_CHUNK_CHARS);
          return `[m${i + 1}] ${text}`;
        });
      recallText = lines.join("\n");
    }
  } catch (e) {
    deps.logger.warn(`worker[${task.taskId}]: recall failed: ${(e as Error).message}`);
  }

  // --- Build prompt ---
  // Include BOTH the user's verbatim message (preserves tone, slang,
  // language register) AND the Moderator's formal taskPrompt (if it
  // differs). Without the verbatim version the Moderator's typical
  // rewrite ("Please research and summarize...") makes the worker
  // answer in formal English-summary style even when the user wrote
  // a casual Chinese one-liner.
  const userPromptParts: string[] = [];
  if (recallText) {
    userPromptParts.push(`## 相关记忆\n${recallText}`);
  }
  userPromptParts.push(`## 用户原话\n${cleanedQ}`);
  // Only include the Moderator's reframing if it actually says something
  // different (avoid duplication when Moderator just passes the user's
  // text through as taskPrompt).
  const taskRewrite = (task.taskPrompt ?? "").trim();
  if (taskRewrite && taskRewrite !== cleanedQ) {
    userPromptParts.push(
      `## Moderator 的任务说明（供参考，回答时按用户原话的口吻和语言）\n${taskRewrite}`,
    );
  }
  const userPrompt = userPromptParts.join("\n\n");

  // --- LLM call ---
  // Two paths:
  //   - No tools allowlisted → single-shot (current behavior, zero regression)
  //   - Tools available     → one round of tool-call → execute → final answer
  const tools = resolveTools(role.tools);
  // Minimal baseline guarantees prepended to every role's systemPrompt:
  //   - language match (Moderator-coined roles sometimes have English
  //     systemPrompts → English replies to Chinese users)
  //   - permit tool use (a sloppy role prompt sometimes makes the model
  //     claim "I can't browse"; the floor tools are always present so
  //     this nudge unlocks them)
  //   - explicit anti-formality (the model's default mode on Gemini is
  //     bullet-list-with-bold-headers; users on this deployment said it
  //     felt 死板; let it write prose unless the question is literally
  //     a list)
  // The role's own prompt still drives persona / scope / topic focus.
  const WORKER_BASELINE_PREAMBLE =
    "用用户的语言回答；需要实时信息就调 web_search，需要群里历史就调 memory_search。" +
    "口吻自然，能用整段话说清的就别堆 ** 加粗标题和项目符号。\n\n---\n\n";
  const effectiveSystemPrompt = WORKER_BASELINE_PREAMBLE + role.systemPrompt;
  const totals = { inputTokens: 0, outputTokens: 0, model: undefined as string | undefined };
  const startLatency = Date.now();
  let toolCallsExecuted: ToolCall[] = [];

  if (tools.length === 0) {
    // ----- single-shot path -----
    const res = await chatSingle(deps.workerLlm, effectiveSystemPrompt, userPrompt, WORKER_MAX_OUTPUT_TOKENS);
    if (!res.ok) {
      return failureResult(task, role, cleanedQ, topicTag, recallCount, res.error);
    }
    totals.inputTokens = res.inputTokens ?? 0;
    totals.outputTokens = res.outputTokens ?? 0;
    totals.model = res.model;
    return successResult(task, role, res.text, cleanedQ, topicTag, recallCount, totals, Date.now() - startLatency, toolCallsExecuted);
  }

  // ----- tool-call path: one round max -----
  const turn1 = await deps.workerLlm.chat({
    systemPrompt: effectiveSystemPrompt,
    history: [{ role: "user", text: userPrompt }],
    tools,
    maxOutputTokens: WORKER_MAX_OUTPUT_TOKENS,
    temperature: WORKER_TEMPERATURE,
  });
  if (!turn1.ok) {
    return failureResult(task, role, cleanedQ, topicTag, recallCount, turn1.error);
  }
  totals.inputTokens += turn1.inputTokens ?? 0;
  totals.outputTokens += turn1.outputTokens ?? 0;
  totals.model = turn1.model;

  // Model didn't call any tool — accept the text it returned (this is the
  // expected path when the question is trivial).
  if (!turn1.toolCalls || turn1.toolCalls.length === 0) {
    return successResult(task, role, turn1.text, cleanedQ, topicTag, recallCount, totals, Date.now() - startLatency, toolCallsExecuted);
  }

  // Execute the tools, then ask for the final answer.
  toolCallsExecuted = turn1.toolCalls;
  deps.logger.info(
    `worker[${task.taskId}]: model invoked ${turn1.toolCalls.length} tool(s): ${turn1.toolCalls.map((c) => c.name).join(",")}`,
  );
  const toolResults = await executeToolsBatch(
    {
      pool: deps.pool,
      embedding: deps.embedding,
      cfg: deps.cfg,
      agentId: deps.agentId,
      viewer,
      // Pulled from cfg.credbroker.tavilyUrl when set; falls back to env
      // / hardcoded default in worker-tools.resolveWebSearchEndpoint.
      webSearchUrl: deps.cfg.credbroker?.tavilyUrl ?? null,
    },
    turn1.toolCalls,
  );
  const turn2 = await deps.workerLlm.chat({
    systemPrompt: effectiveSystemPrompt,
    history: [
      { role: "user", text: userPrompt },
      ...exportToolResultsAsHistory(turn1.toolCalls, toolResults),
    ],
    tools, // still present in case model wants to refuse another call cleanly
    maxOutputTokens: WORKER_MAX_OUTPUT_TOKENS,
    temperature: WORKER_TEMPERATURE,
  });
  if (!turn2.ok) {
    return failureResult(task, role, cleanedQ, topicTag, recallCount, turn2.error);
  }
  totals.inputTokens += turn2.inputTokens ?? 0;
  totals.outputTokens += turn2.outputTokens ?? 0;
  // If the model tries to call MORE tools on the second turn we just take
  // whatever text it has — we don't go to a 3rd round (cost + latency).
  return successResult(task, role, turn2.text, cleanedQ, topicTag, recallCount, totals, Date.now() - startLatency, toolCallsExecuted);
}

function successResult(
  task: AnswerTask,
  role: RoleSpec,
  rawText: string,
  cleanedQ: string,
  topicTag: string | undefined,
  recallCount: number,
  totals: { inputTokens: number; outputTokens: number; model: string | undefined },
  latencyMs: number,
  toolCallsExecuted: ToolCall[],
): WorkerResult {
  const answer = (rawText ?? "").trim();
  const ok = answer.length > 0 && !answer.startsWith(`{"action":"ignore"`); // sentinel guard
  return {
    taskId: task.taskId,
    roleKey: role.roleKey,
    ok,
    answer: ok ? answer : "（生成失败）",
    questionText: cleanedQ,
    topicTag,
    llm: {
      model: totals.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      latencyMs,
    },
    recallCount,
    toolCalls: toolCallsExecuted.length > 0 ? toolCallsExecuted : undefined,
    errors: ok ? [] : ["empty-or-fallback-llm-output"],
  };
}

function failureResult(
  task: AnswerTask,
  role: RoleSpec,
  cleanedQ: string,
  topicTag: string | undefined,
  recallCount: number,
  errorMsg: string,
): WorkerResult {
  return {
    taskId: task.taskId,
    roleKey: role.roleKey,
    ok: false,
    answer: "",
    questionText: cleanedQ,
    topicTag,
    llm: {},
    recallCount,
    errors: [`llm-call-failed: ${errorMsg}`],
  };
}

/* --------------------------- many-task orchestrator ----------------------- */

/**
 * Runs all answer tasks. Tasks marked `canParallel:true` run concurrently;
 * sequential-only tasks run in declaration order AFTER the parallel batch
 * (Phase D doesn't yet support dependency graphs — `canParallel:false`
 * means "run last", not "depend on a specific other task").
 */
export async function runWorkersForDecision(
  deps: WorkerDeps,
  tasks: AnswerTask[],
  viewer: ViewerScope | undefined,
  userQuestion: string,
  scopeKey: string,
): Promise<WorkerResult[]> {
  if (tasks.length === 0) {return [];}
  const parallel = tasks.filter((t) => t.canParallel !== false);
  const serial = tasks.filter((t) => t.canParallel === false);

  const parResults = await Promise.all(
    parallel.map((t) => dispatchWorker(deps, t, viewer, userQuestion, scopeKey)),
  );
  const serResults: WorkerResult[] = [];
  for (const t of serial) {
    serResults.push(await dispatchWorker(deps, t, viewer, userQuestion, scopeKey));
  }
  return [...parResults, ...serResults];
}

/* ------------------------------ cache write-back -------------------------- */

const CACHE_TTL_DAYS_DEFAULT = 90;

/**
 * Heuristics for "the worker said it doesn't know". We must NOT write
 * these to cache.qa — otherwise the L2 semantic precheck happily serves
 * "I don't know" forever to anyone asking a similar question, blocking
 * the worker (and thus web_search) from ever running again. This bug
 * was seen live: an "openclaw latest update" question got cached as
 * "记忆里没有信息" → next semantically-close question hit that row at
 * sim=0.95 and the user got the stale non-answer.
 *
 * The patterns intentionally err on the side of OVER-rejecting (better
 * to cache nothing than to cache a non-answer). Real answers that
 * legitimately contain "我不知道" as part of a longer response (rare)
 * will be skipped — that's acceptable.
 */
const NON_ANSWER_PATTERNS: RegExp[] = [
  /没有.{0,20}(信息|记录|资料|内容|结果)/,
  /(知识库|记忆|材料|历史).{0,8}(没有|不包含|找不到)/,
  /(暂无|没找到|查不到|没有找到|未找到).{0,20}/,
  /(无法|不能).{0,10}提供.{0,20}/,
  /我不知道|不太清楚|无从得知/,
  /\bI (don'?t|do not) (know|have)\b/i,
  /\b(no|not) (information|data|results?) (available|found)\b/i,
  /\bcannot (provide|find|access|fulfill|browse|search|help)\b/i,
  /\bI(?:'?m|\s+am)\s+sorry,?\s+but\b/i,
  /\b(unable to|not able to)\s+(browse|search|access|fulfill|provide)\b/i,
  /\bmy (current )?capabilities? (do not|don'?t) allow\b/i,
];

function looksLikeNonAnswer(text: string): boolean {
  const t = text.trim();
  // Very short replies are likely non-answers ("不知道。" / "Unknown").
  if (t.length < 12) {return true;}
  return NON_ANSWER_PATTERNS.some((p) => p.test(t));
}

/**
 * Persist a successful worker answer into cache.qa so the next equivalent
 * question hits the pre-check. Fire-and-forget — failure is logged but
 * doesn't block the user reply.
 *
 * Visibility rules (intentionally simple — extend in Phase E):
 *   - default `public` (T0 global): the answer is reusable across viewers
 *   - if `task.memoryScope.viewerUserId` is set → `private` (TA scoped)
 *   - chat-scoped public not yet emitted by Moderator decisions
 */
export async function writeAnswerToCache(
  deps: WorkerDeps,
  result: WorkerResult,
  task: AnswerTask,
): Promise<string | null> {
  if (!result.ok || !result.answer || result.answer.length < 2) {return null;}
  // Don't cache non-answers — see NON_ANSWER_PATTERNS rationale above.
  if (looksLikeNonAnswer(result.answer)) {
    deps.logger.info(
      `worker[${result.taskId}]: skipping cache write — answer looks like a non-answer`,
    );
    return null;
  }
  try {
    // Embed the CLEANED question (matches what precheck.ts hashes/embeds).
    // taskPrefix: null — we're embedding the *question* as a passage for
    // future lookups; the EmbeddingClient only differentiates "query" vs
    // null (= default/passage), matching the embed model's instruction set.
    const er = await deps.embedding.embed({
      inputs: [result.questionText],
      taskPrefix: null,
    });
    const visibility: "public" | "private" =
      task.memoryScope?.viewerUserId ? "private" : "public";
    const scope = task.memoryScope?.viewerUserId
      ? { senderId: task.memoryScope.viewerUserId, visibility }
      : { visibility };
    const id = await storeCachedAnswer(deps.pool, {
      agentId: deps.agentId,
      questionText: result.questionText,
      questionEmbedding: er.embeddings[0],
      embeddingModel: deps.cfg.embedding.model,
      answerText: result.answer,
      answerFormat: "plain",
      scope,
      topicTag: result.topicTag,
      source: "agent",
      ttlDays: CACHE_TTL_DAYS_DEFAULT,
    });
    return id || null;
  } catch (e) {
    deps.logger.warn(
      `worker[${result.taskId}]: cache write-back failed: ${(e as Error).message}`,
    );
    return null;
  }
}

// We mint task ids inside the runner when the LLM forgets to. Exported
// so the service can do the same on the rare same-cycle reuse path.
export function mintTaskId(): string {
  return `t_${randomUUID().slice(0, 8)}`;
}
