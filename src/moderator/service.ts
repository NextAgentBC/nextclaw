/**
 * Moderator service — hooks openclaw's `message_received` event for
 * Telegram messages, runs ONE Moderator decision cycle (gpt-5.5 by
 * default), and dispatches the resulting side effects.
 *
 * Concurrency model (matches Anthropic's orchestrator-worker pattern):
 *   1. message_received fires inside openclaw's per-chat sequentialize
 *      lock. We fire-and-forget so the lock releases immediately,
 *      letting different students in the same group fan out across
 *      Moderator workers in parallel (this is the workaround for
 *      openclaw's single-chat lock that we deferred from Phase A).
 *   2. Per (scope_key) we hold an in-memory mutex that serializes
 *      cycle execution for that scope — so a single student's burst
 *      of messages flows through the decision loop in order, but
 *      different scopes run concurrently.
 *   3. Telegram side effects (placeholder, edit, action) happen
 *      synchronously inside the cycle; memory writes are non-blocking;
 *      worker dispatch (Phase D) is fully async.
 *
 * Per-user debounce 1.5s window: when a student sends multiple lines
 * within 1.5s, we wait for the buffer to settle, then concatenate them
 * into ONE trigger message before calling runOneCycle. Saves LLM
 * round-trips on burst inputs.
 */

import type { Pool } from "pg";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { tryCachePrecheck } from "./cache-precheck.js";
import { logDecision, loadModeratorState, saveModeratorState } from "./state.js";
import { runOneCycle, type ModeratorLlm } from "./runner.js";
import { executeDecision } from "./side-effects.js";
import { TelegramBotApi } from "./telegram-api.js";
import type { RecentMessage } from "./types.js";
import { runWorkersForDecision, writeAnswerToCache } from "./workers.js";

export type ModeratorServiceConfig = {
  enabled: boolean;
  /** LLM client (typically built via `buildModeratorLlm`). */
  llm: ModeratorLlm;
  /** Embedding client — needed for cache.qa L2 semantic lookup before
   *  the Moderator decision. Skips Gemini entirely on cache hits. */
  embedding: EmbeddingClient;
  /** Telegram bot token, from openclaw `channels.telegram.botToken`. */
  telegramBotToken: string;
  /** Bot owner user id (for escalation), from `commands.ownerAllowFrom[0]`. */
  ownerUserId?: string;
  /** Dashboard /api/ingest URL + token, for memoryWrites. */
  ingestUrl: string;
  ingestToken: string;
  /** Resolved nextclaw config (mostly for agentId, pool). */
  cfg: ResolvedMemoryPostgresConfig;
  pool: Pool;
  /** Logger; the api.logger from openclaw works. */
  logger: { info: (m: string) => void; warn: (m: string) => void };
  /** Per-user debounce window in ms. Default 1500. */
  debounceMs?: number;
};

export type ModeratorServiceHandle = {
  /** Forward a `message_received` event from openclaw's plugin SDK
   *  into the Moderator pipeline. Returns immediately; the cycle runs
   *  asynchronously. */
  onMessageReceived(event: PluginMessageEvent, ctx: PluginMessageContext): void;
  /** Stop the service (cancel pending debounces; close timers). */
  stop(): void;
};

/** Event shape matches openclaw's plugin SDK (see thread-ownership for
 *  the same surface). We don't import the openclaw types directly so
 *  this module can be unit-tested without the SDK on the path. */
export type PluginMessageEvent = {
  from?: string;
  content?: string;
  timestamp?: string;
  threadId?: string | number;
  messageId?: string | number;
  senderId?: string;
  metadata?: {
    senderName?: string;
    senderUsername?: string;
    threadId?: string | number;
    chatType?: "private" | "group" | "supergroup" | "channel";
  };
};
export type PluginMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
};

export function startModeratorService(config: ModeratorServiceConfig): ModeratorServiceHandle {
  const tg = new TelegramBotApi({ botToken: config.telegramBotToken });
  const debounceMs = config.debounceMs ?? 1500;

  // Per-scope serial queue: one in-flight cycle per scopeKey at a time.
  const scopeMutex = new Map<string, Promise<void>>();
  // Per (scope, user) debounce buffers.
  const buffers = new Map<string, { messages: RecentMessage[]; timer: NodeJS.Timeout; chatId: string; messageThreadId?: number }>();

  function bufferKey(scopeKey: string, userId: string): string {
    return `${scopeKey}::${userId}`;
  }

  function processBufferFor(key: string): void {
    const buf = buffers.get(key);
    if (!buf) {return;}
    buffers.delete(key);
    const messages = buf.messages;
    if (messages.length === 0) {return;}
    // Concat into ONE trigger. Preserve the most recent timestamp + id.
    const flat = messages.map((m) => m.text).join("\n");
    const last = messages[messages.length - 1];
    const trigger: RecentMessage = {
      ...last,
      text: flat,
    };
    const [scopeKey, userId] = key.split("::");
    void runScopeCycle(scopeKey, userId, trigger, buf.chatId, buf.messageThreadId);
  }

  function enqueueScopeCycle(
    scopeKey: string,
    userId: string,
    trigger: RecentMessage,
    chatId: string,
    messageThreadId: number | undefined,
  ): void {
    const prev = scopeMutex.get(scopeKey) ?? Promise.resolve();
    const next = prev.then(() => runScopeCycleInner(scopeKey, userId, trigger, chatId, messageThreadId));
    scopeMutex.set(scopeKey, next.finally(() => {
      if (scopeMutex.get(scopeKey) === next) {scopeMutex.delete(scopeKey);}
    }));
  }

  async function runScopeCycle(
    scopeKey: string,
    userId: string,
    trigger: RecentMessage,
    chatId: string,
    messageThreadId: number | undefined,
  ): Promise<void> {
    enqueueScopeCycle(scopeKey, userId, trigger, chatId, messageThreadId);
  }

  async function runScopeCycleInner(
    scopeKey: string,
    senderUserId: string,
    trigger: RecentMessage,
    chatId: string,
    messageThreadId: number | undefined,
  ): Promise<void> {
    try {
      // 1. Load state (or init).
      const state = await loadModeratorState(config.pool, config.cfg ? "main" : "main", scopeKey);

      // 2. Skip if scope is paused (operator did /takeover).
      const status = await readScopeStatus(config.pool, scopeKey);
      if (status === "paused" || status === "archived") {
        config.logger.info(`moderator: scope ${scopeKey} is ${status}, skipping`);
        return;
      }

      // 2.5. Cache pre-check (L0 in-process / L1 PG exact / L2 PG semantic).
      //      On hit: send the cached answer directly and SKIP the LLM call.
      //      The bulk of repeat-question savings lives here (~50ms vs 6s,
      //      0 vs 1500 Gemini tokens).
      const precheck = await tryCachePrecheck(
        { pool: config.pool, embedding: config.embedding, agentId: "main" },
        {
          scopeKey,
          questionText: trigger.text,
          viewer: { userId: senderUserId, chatId },
        },
      );
      if (precheck.hit) {
        config.logger.info(
          `moderator: scope=${scopeKey} CACHE HIT (${precheck.hitKind} sim=${precheck.similarity.toFixed(2)}) ` +
            `latency=${precheck.latencyMs}ms — skipping LLM`,
        );
        // Send the cached answer.
        const sendRes = await tg.sendMessage({
          chatId,
          text: precheck.answer,
          messageThreadId,
        });
        if (!sendRes.ok) {
          config.logger.warn(`moderator: cache-hit send failed: ${sendRes.error}`);
        }
        // Persist the inbound + a synthetic "cache-hit" decision row for audit.
        await saveModeratorState(config.pool, "main", scopeKey, {
          ...state,
          recentMessages: [...state.recentMessages, trigger].slice(-50),
          messagesSinceLastReview: state.messagesSinceLastReview + 1,
        }, {
          bumpMessageCount: 1,
          bumpDecisionCount: 0, // cache-hit isn't a "decision" — no LLM ran
          lastMessageAt: new Date(),
        });
        await logDecision(config.pool, {
          agentId: "main",
          scopeKey,
          triggerKind: "message",
          triggerUserId: senderUserId,
          triggerText: trigger.text,
          decision: {
            action: "answer-direct",
            rationale: `cache hit (${precheck.hitKind}, sim=${precheck.similarity.toFixed(2)}, id=${precheck.cacheId})`,
          },
          model: `cache:${precheck.hitKind}`,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: precheck.latencyMs,
          workersSpawned: 0,
        });
        return;
      }

      // 3. Run one cycle.
      const out = await runOneCycle(state, { kind: "message", message: trigger }, config.llm);

      config.logger.info(
        `moderator: scope=${scopeKey} action=${out.decision.action} ` +
          `tokens=${out.llm.inputTokens ?? "?"}→${out.llm.outputTokens ?? "?"} ` +
          `latency=${out.llm.latencyMs ?? "?"}ms`,
      );

      // 4. Execute side effects.
      const fx = await executeDecision(out.decision, out.state, {
        pool: config.pool,
        telegram: tg,
        chatId,
        messageThreadId,
        ownerUserId: config.ownerUserId,
        ingestUrl: config.ingestUrl,
        ingestToken: config.ingestToken,
        triggerSenderUserId: senderUserId,
        agentId: "main",
        logger: config.logger,
      });

      // 5. Splice placeholder message_ids back into activeWorkers.
      const updatedState = { ...out.state };
      if (fx.placeholders.length > 0) {
        updatedState.activeWorkers = updatedState.activeWorkers.map((w) => {
          const ph = fx.placeholders.find((p) => p.taskId === w.taskId);
          return ph ? { ...w, placeholderMessageId: ph.messageId } : w;
        });
      }

      // 5.5. Phase D — dispatch workers, edit placeholders with answers,
      //      write answers back to cache.qa.
      const tasks = out.decision.answerTasks ?? [];
      if (tasks.length > 0) {
        const wkDeps = {
          pool: config.pool,
          llm: config.llm,
          embedding: config.embedding,
          cfg: config.cfg,
          agentId: "main",
          logger: config.logger,
        };
        const viewer = { userId: senderUserId, chatId };
        const results = await runWorkersForDecision(wkDeps, tasks, viewer, trigger.text, scopeKey);
        for (const r of results) {
          // Find the placeholder message_id for this task: first try
          // fx.placeholders (this cycle), fall back to activeWorkers
          // (in case Phase E adds across-cycle workers).
          const phMessageId =
            fx.placeholders.find((p) => p.taskId === r.taskId)?.messageId ??
            updatedState.activeWorkers.find((w) => w.taskId === r.taskId)?.placeholderMessageId ??
            null;
          if (phMessageId) {
            const editRes = await tg.editMessageText({
              chatId,
              messageId: phMessageId,
              text: r.answer.slice(0, 4000), // Telegram cap
            });
            if (!editRes.ok) {
              config.logger.warn(`moderator: edit_placeholder task=${r.taskId} failed: ${editRes.error}`);
            }
          } else if (r.ok) {
            // No placeholder existed — send the answer as a fresh message.
            await tg.sendMessage({ chatId, text: r.answer.slice(0, 4000), messageThreadId });
          }
          // Mark the worker done in state.
          updatedState.activeWorkers = updatedState.activeWorkers.map((w) =>
            w.taskId === r.taskId
              ? { ...w, status: r.ok ? "completed" : "failed", result: r.answer.slice(0, 200) }
              : w,
          );
          // Cache write-back (fire-and-forget — never block the reply).
          if (r.ok) {
            const task = tasks.find((t) => t.taskId === r.taskId);
            if (task) {
              void writeAnswerToCache(wkDeps, r, task).then((id) => {
                if (id) {
                  config.logger.info(
                    `moderator: scope=${scopeKey} cached answer id=${id} task=${r.taskId} topic=${r.topicTag ?? "-"}`,
                  );
                }
              });
            }
          }
          config.logger.info(
            `moderator: worker task=${r.taskId} role=${r.roleKey} ok=${r.ok} ` +
              `tokens=${r.llm.inputTokens ?? "?"}→${r.llm.outputTokens ?? "?"} ` +
              `latency=${r.llm.latencyMs ?? "?"}ms recall=${r.recallCount}`,
          );
        }
      }

      // 6. Save state. If escalation asked to pause the scope, flip status.
      await saveModeratorState(config.pool, "main", scopeKey, updatedState, {
        bumpMessageCount: 1,
        bumpDecisionCount: 1,
        lastMessageAt: new Date(),
        status: fx.shouldPauseScope ? "paused" : undefined,
        pausedBy: fx.shouldPauseScope ? "auto-escalation" : undefined,
        pausedReason: fx.shouldPauseScope ? out.decision.escalation?.reason : undefined,
      });

      // 7. Decision audit log.
      await logDecision(config.pool, {
        agentId: "main",
        scopeKey,
        triggerKind: "message",
        triggerUserId: senderUserId,
        triggerText: trigger.text,
        decision: out.decision,
        model: out.llm.model,
        inputTokens: out.llm.inputTokens,
        outputTokens: out.llm.outputTokens,
        latencyMs: out.llm.latencyMs,
        workersSpawned: out.decision.answerTasks?.length ?? 0,
        errors: [...out.parseErrors, ...fx.errors],
      });
    } catch (err) {
      config.logger.warn(`moderator: scope ${scopeKey} cycle failed: ${(err as Error).message}`);
    }
  }

  return {
    onMessageReceived(event, ctx) {
      if (!config.enabled) {return;}
      if (ctx.channelId !== "telegram") {return;}
      const text = event.content?.trim();
      if (!text) {return;}

      // Resolve chat id + scope. Telegram conversation ids look like
      // "tg-1001234567890" or raw numbers; normalise to plain string.
      const rawChatId = stripChannelPrefix(ctx.conversationId ?? "");
      if (!rawChatId) {return;}

      // Resolve sender. Telegram per-user id might be senderId raw or
      // prefixed with "user:". We strip prefixes; otherwise default
      // to the "from" field.
      const senderUserId = stripChannelPrefix(event.senderId ?? ctx.senderId ?? event.from ?? "");
      if (!senderUserId) {return;}

      const chatType = event.metadata?.chatType ?? inferChatTypeFromId(rawChatId);
      const isGroup = chatType === "group" || chatType === "supergroup";
      // SAFETY: only intercept group messages. DMs continue through the
      // existing openclaw per-DM agent path; if the Moderator also fired
      // on DMs we'd get duplicate replies. Group ownership of the
      // conversation moves to the Moderator; DMs stay with the codex agent.
      if (!isGroup) {return;}
      const scopeKey = `tg:chat:${rawChatId}`;

      const messageThreadId = toIntOrUndef(event.metadata?.threadId ?? event.threadId);
      const messageId = toIntOrUndef(event.messageId);
      const message: RecentMessage = {
        // event.timestamp may arrive as ISO string, Date, or unix number
        // depending on the channel. Normalise to ISO string so all later
        // formatting (which calls `ts.slice`) is type-safe.
        ts: coerceIsoString(event.timestamp),
        fromUserId: senderUserId,
        fromLabel: event.metadata?.senderName ?? event.metadata?.senderUsername,
        text,
        messageId,
        isAddressed: looksAddressed(text, isGroup),
      };

      // Debounce per (scope, user).
      const key = bufferKey(scopeKey, senderUserId);
      const existing = buffers.get(key);
      if (existing) {
        existing.messages.push(message);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => processBufferFor(key), debounceMs);
        existing.timer.unref?.();
      } else {
        const timer = setTimeout(() => processBufferFor(key), debounceMs);
        timer.unref?.();
        buffers.set(key, {
          messages: [message],
          timer,
          chatId: rawChatId,
          messageThreadId,
        });
      }
    },
    stop() {
      for (const buf of buffers.values()) {
        clearTimeout(buf.timer);
      }
      buffers.clear();
      scopeMutex.clear();
    },
  };
}

/* ----------------------------- small helpers ------------------------------ */

function stripChannelPrefix(value: string): string {
  // openclaw conversation/sender ids arrive prefixed in a few ways depending
  // on the channel: `channel:<id>`, `chat:<id>`, `user:<id>`, `tg-<id>`,
  // or the channel name itself like `telegram:<id>` / `slack:<id>` etc.
  // Strip whichever prefix we find. Telegram group ids are negative so
  // after stripping we want a clean `-100...` so the downstream chat-type
  // inferrer works.
  return value.replace(/^(?:channel:|chat:|user:|tg-?|telegram:|slack:|discord:|whatsapp:)/, "");
}

function inferChatTypeFromId(rawChatId: string): "private" | "group" | "supergroup" {
  // Group ids are negative; supergroup ids start with -100. We can't
  // reliably distinguish group from supergroup without metadata, so
  // call all negative ids "supergroup" (the more common modern shape).
  if (rawChatId.startsWith("-")) {return "supergroup";}
  return "private";
}

function looksAddressed(text: string, isGroup: boolean): boolean {
  if (!isGroup) {return true;} // DMs are always addressed
  return /@\w+_bot|@bot\b|^\/(start|ask|help)/i.test(text);
}

function coerceIsoString(v: unknown): string {
  if (typeof v === "string" && v.length > 0) {return v;}
  if (v instanceof Date) {return v.toISOString();}
  if (typeof v === "number" && Number.isFinite(v)) {
    // Telegram delivers unix seconds; multiply if it looks like seconds.
    const ms = v < 10_000_000_000 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function toIntOrUndef(v: string | number | undefined | null): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {return v;}
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) {return n;}
  }
  return undefined;
}

async function readScopeStatus(pool: Pool, scopeKey: string): Promise<string | null> {
  const r = await pool.query<{ status: string }>(
    `SELECT status FROM moderator.state WHERE agent_id = 'main' AND scope_key = $1`,
    [scopeKey],
  );
  return r.rows[0]?.status ?? null;
}
