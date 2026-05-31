/**
 * OpenClaw memory-postgres plugin entry.
 *
 * Wires:
 *   - registerMemoryCapability({ runtime, promptBuilder })
 *       — runtime gives core the MemorySearchManager
 *       — promptBuilder injects "use memory_search/store + emit <mem>" into agent system prompt
 *   - registerTool memory_search / memory_store (agent-callable tools)
 *   - registerService("memory-postgres-dashboard"):
 *       — starts the HTTP dashboard server when the gateway boots
 *       — schedules daily tuning analyzer + compactor as setInterval timers
 *       — stops them all on plugin unload
 *
 * Heavy modules (pg, pgvector, migrations, embedding HTTP) live behind
 * manager-runtime.ts and the lazy `setup()` helper inside tools.ts so they
 * only enter the import graph when an operation actually runs.
 */

import { definePluginEntry } from "./api.js";
import { memoryRuntime } from "./manager-runtime.js";
import { resolveConfig, validateConfig } from "./src/config.js";
import { buildEmbeddingClientFromConfig } from "./src/embedding/client.js";
import { startDashboardServer, type DashboardServer } from "./src/dashboard/server.js";
import { buildPromptSection } from "./src/prompt-section.js";
import { migrate, ensureHnswIndex } from "./src/storage/migrate.js";
import { closePool, getPool, type ResolvedPoolConfig } from "./src/storage/pool.js";
import {
  buildForgetTool,
  buildGetTool,
  buildSearchTool,
  buildStoreTool,
  buildUpdateTool,
} from "./src/tools.js";
import { compactCold } from "./src/workers/compactor.js";
import { startGitWatcherDaemon, type GitWatcherHandle } from "./src/workers/git-watcher.js";
import {
  buildReflectionClient,
  startReflectionDaemon,
  type ReflectionDaemonHandle,
} from "./src/workers/reflection.js";
import { buildModeratorLlm } from "./src/moderator/llm-client.js";
import { startModeratorService, type ModeratorServiceHandle } from "./src/moderator/service.js";

/**
 * Module-level handle for the moderator service. `api.on(...)` hook
 * handlers and the registerService start() callback may be invoked in
 * DIFFERENT register(api) closures (cli-metadata pass / tool-discovery
 * pass / real runtime pass), so the closure-captured variable approach
 * doesn't reliably let the hook see the handle the service installs.
 * Module-level state side-steps that.
 */
let MODULE_MODERATOR_HANDLE: ModeratorServiceHandle | null = null;
/** Module-level handles for the event-driven hooks (after_compaction,
 *  session_end). Same closure-isolation rationale as above. */
let MODULE_TRANSCRIPT_WATCHERS: TranscriptWatcherHandle[] = [];
let MODULE_REFLECTION_HANDLE: ReflectionDaemonHandle | null = null;
let MODULE_INGEST_DEPS: import("./src/ingest/pipeline.js").IngestDeps | null = null;
/** Set on service start when we have what /dashboard needs (bot token,
 *  owner allowlist, public URL). Cleared on stop. */
type DashboardCommandCtx = {
  telegram: import("./src/moderator/telegram-api.js").TelegramBotApi;
  publicUrl: string;
  ownerIds: Set<string>;
};
let MODULE_DASHBOARD_CMD: DashboardCommandCtx | null = null;

/**
 * Handle `/dashboard` text from a Telegram user. Replies with an
 * inline-keyboard WebApp button that opens the dashboard inside Telegram.
 * Owner-only (checked against `commands.ownerAllowFrom`). Returns true
 * when the message was handled (caller should claim); false to let
 * normal routing continue.
 */
async function handleDashboardCommand(
  api: { logger: { info: (m: string) => void; warn: (m: string) => void } },
  ctxObj: { conversationId?: string; senderId?: string },
): Promise<boolean> {
  const cmd = MODULE_DASHBOARD_CMD;
  if (!cmd) {
    api.logger.warn("dashboard cmd: not configured (publicUrl + telegram bot token both required)");
    return false;
  }
  const senderRaw = (ctxObj.senderId ?? "").replace(
    /^(?:channel:|chat:|user:|tg-?|telegram:|slack:|discord:|whatsapp:)/,
    "",
  );
  if (!cmd.ownerIds.has(senderRaw)) {
    api.logger.info(`dashboard cmd: rejecting non-owner sender=${senderRaw}`);
    // Reply with a polite refusal (still consume the message).
    const chatId = (ctxObj.conversationId ?? "").replace(
      /^(?:channel:|chat:|user:|tg-?|telegram:|slack:|discord:|whatsapp:)/,
      "",
    );
    if (chatId) {
      await cmd.telegram.sendMessage({
        chatId,
        text: "Dashboard 仅限运营者使用。",
      }).catch(() => undefined);
    }
    return true;
  }
  const chatId = (ctxObj.conversationId ?? "").replace(
    /^(?:channel:|chat:|user:|tg-?|telegram:|slack:|discord:|whatsapp:)/,
    "",
  );
  if (!chatId) {return false;}
  // WebApp button: when tapped, Telegram opens the URL inside its
  // in-app browser AND injects window.Telegram.WebApp.initData which
  // the dashboard JS exchanges for a session token at
  // /api/auth/telegram. No URL token leakage.
  await cmd.telegram.sendMessage({
    chatId,
    text: "📊 OpenClaw Memory Dashboard\n\n点下面的按钮，dashboard 在 Telegram 内部打开（自动鉴权，只有你看得到）。",
    replyMarkup: {
      inline_keyboard: [[{
        text: "📈 Open Dashboard",
        web_app: { url: cmd.publicUrl },
      }]],
    },
  });
  api.logger.info(`dashboard cmd: sent WebApp button to sender=${senderRaw}`);
  return true;
}

import { startTranscriptWatcherDaemon, type TranscriptWatcherHandle } from "./src/workers/transcript-watcher.js";
import { startShadowComparator } from "./src/workers/shadow-comparator.js";
import { evaluateGuards, runDailyAnalyzer } from "./src/workers/tuning.js";
import { ingestCompactionSummary } from "./src/workers/compaction-ingest.js";

const SERVICE_ID = "memory-postgres-dashboard";

const DAY_MS = 24 * 60 * 60 * 1000;

export default definePluginEntry({
  id: "memory-postgres",
  name: "Memory (Postgres + pgvector)",
  description:
    "Postgres + pgvector memory plugin with 4-tier recall, multi-key indexing, scoring and self-tuning",
  kind: "memory",

  register(api) {
    api.registerMemoryCapability({
      runtime: memoryRuntime,
      promptBuilder: buildPromptSection,
    });

    api.registerTool(
      (ctx) => {
        const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!config) {
          throw new Error("memory-postgres: no runtime config available in tool context");
        }
        return buildSearchTool({ config, sessionKey: ctx.sessionKey });
      },
      { names: ["memory_search"] },
    );

    api.registerTool(
      (ctx) => {
        const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!config) {
          throw new Error("memory-postgres: no runtime config available in tool context");
        }
        return buildGetTool({ config, sessionKey: ctx.sessionKey });
      },
      { names: ["memory_get"] },
    );

    api.registerTool(
      (ctx) => {
        const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!config) {
          throw new Error("memory-postgres: no runtime config available in tool context");
        }
        return buildStoreTool({ config, sessionKey: ctx.sessionKey });
      },
      { names: ["memory_store"] },
    );

    api.registerTool(
      (ctx) => {
        const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!config) {
          throw new Error("memory-postgres: no runtime config available in tool context");
        }
        return buildUpdateTool({ config, sessionKey: ctx.sessionKey });
      },
      { names: ["memory_update"] },
    );

    api.registerTool(
      (ctx) => {
        const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!config) {
          throw new Error("memory-postgres: no runtime config available in tool context");
        }
        return buildForgetTool({ config, sessionKey: ctx.sessionKey });
      },
      { names: ["memory_forget"] },
    );

    // Moderator suppression hook — `before_dispatch` (NOT `inbound_claim`).
    //
    // Why before_dispatch and not inbound_claim:
    //   - inbound_claim only fires for conversations that have a
    //     PluginConversationBinding linking the chat to a specific plugin
    //     (see dispatch-CvimgVpK.js: runInboundClaimForPluginOutcome is
    //     only called inside `if (pluginOwnedBinding)`). Our telegram
    //     chats are bound to codex (the default agent), not to
    //     memory-postgres, so our inbound_claim handler would silently
    //     never fire — the previous attempt failed exactly here.
    //   - before_dispatch is unconditional: `if (hookRunner?.hasHooks
    //     ("before_dispatch"))` then run, no binding required. Returning
    //     `{handled: true}` short-circuits the dispatcher before codex
    //     gets the message.
    //
    // The companion observer hook below (message_received) is what actually
    // forwards the inbound event into the Moderator pipeline; before_dispatch
    // only decides whether to suppress codex.
    api.on("before_dispatch", async (event, hookCtx) => {
      const ctxObj = hookCtx as { channelId?: string; conversationId?: string; senderId?: string };
      if (ctxObj?.channelId !== "telegram") {return;}
      const ev = event as { content?: string; isGroup?: boolean };
      const content = (ev.content ?? "").trim();

      // 0. /dashboard command — open the dashboard WebApp inline. Owner
      //    only. Works in both DM and group. Always claims (the response
      //    is sent below).
      if (/^\/dashboard(?:@\w+_bot)?(?:\s|$)/i.test(content)) {
        const handled = await handleDashboardCommand(api, ctxObj);
        if (handled) {return { handled: true };}
        // If we couldn't handle (missing publicUrl, etc.), fall through
        // and let normal routing take over so the user sees SOMETHING.
      }

      // event.isGroup is set directly by the dispatcher (see
      // hook-types: PluginHookBeforeDispatchEvent), preferred over
      // re-parsing the conversation id.
      const isGroup = ev.isGroup === true ||
        (ctxObj.conversationId ?? "")
          .replace(/^(?:channel:|chat:|user:|tg-?|telegram:|slack:|discord:|whatsapp:)/, "")
          .startsWith("-");
      if (!isGroup) {return;} // DMs continue to codex
      const addressed = /@\w+_bot|@bot\b|^\/(start|ask|help)/i.test(content);
      if (!addressed) {return;} // group chatter not for the bot — codex won't reply anyway
      api.logger.info(
        `[moderator/hook] before_dispatch CLAIMED: conv=${ctxObj.conversationId} ` +
          `(group + mention — codex suppressed; Moderator replies out-of-band)`,
      );
      return { handled: true };
    });

    // Observer hook — runs after before_dispatch (whether or not codex was
    // suppressed) so the Moderator's state machine sees every telegram
    // event. DM filtering happens inside the service.
    api.on("message_received", async (event, hookCtx) => {
      const ctxObj = hookCtx as { channelId?: string };
      if (ctxObj?.channelId !== "telegram") {return;}
      if (!MODULE_MODERATOR_HANDLE) {return;}
      try {
        MODULE_MODERATOR_HANDLE.onMessageReceived(
          event as Parameters<ModeratorServiceHandle["onMessageReceived"]>[0],
          hookCtx as Parameters<ModeratorServiceHandle["onMessageReceived"]>[1],
        );
      } catch (err) {
        api.logger.warn(`memory-postgres: moderator message_received hook threw: ${(err as Error).message}`);
      }
    });

    /**
     * after_compaction — codex just folded N messages into one LLM-driven
     * summary in this session's JSONL. We promote that summary into
     * `semantic.chunks` with kind='compaction', retention='pinned' so
     * recall can find it later. Without this hook the summary lives only
     * in the session file. Best-effort; failure logged.
     */
    api.on("after_compaction", async (event, hookCtx) => {
      const ev = event as { messageCount?: number; tokenCount?: number; compactedCount?: number; sessionFile?: string };
      if (!ev?.sessionFile || !ev.compactedCount) {return;}
      const agentId = (hookCtx as { agentId?: string })?.agentId ?? "main";
      const agentSessionId = (hookCtx as { sessionKey?: string; sessionId?: string })?.sessionId
        ?? (hookCtx as { sessionKey?: string })?.sessionKey;
      if (!MODULE_INGEST_DEPS) {return;}
      void ingestCompactionSummary(
        { ...MODULE_INGEST_DEPS, logger: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) } },
        {
          sessionFile: ev.sessionFile,
          agentId,
          agentSessionId,
          messageCount: ev.messageCount ?? 0,
          tokenCount: ev.tokenCount,
          compactedCount: ev.compactedCount,
        },
      ).catch(() => undefined);
    });

    /**
     * session_end — codex just finished a session. Two synergies:
     *   1. Flush the transcript watcher NOW (don't wait ~10s for next
     *      tick) so the session's tail lines land in memory immediately.
     *   2. Trigger per-agent reflection (throttled per agent so a burst
     *      of session-ends doesn't run 10 reflections in a row).
     */
    api.on("session_end", async (event, hookCtx) => {
      const ev = event as { sessionId?: string; sessionKey?: string; reason?: string };
      const ctxAgent = (hookCtx as { agentId?: string })?.agentId ?? "main";
      // (1) immediate transcript flush for ALL watchers (cheap; each only
      // re-reads new lines since its last offset cursor).
      for (const w of MODULE_TRANSCRIPT_WATCHERS) {
        w.flushNow().catch((err) =>
          api.logger.warn(`session_end transcript flush failed (${w.watcherId}): ${(err as Error).message}`),
        );
      }
      // (2) event-driven reflection. We only trigger for "natural" end
      // reasons that imply a chunk of completed work — not for shutdown
      // / restart (those are infra noise).
      const productiveReasons = new Set(["new", "reset", "idle", "daily", "compaction"]);
      const reason = typeof ev?.reason === "string" ? ev.reason : "unknown";
      if (MODULE_REFLECTION_HANDLE && productiveReasons.has(reason)) {
        void MODULE_REFLECTION_HANDLE.triggerForAgent(ctxAgent, `session_end:${reason}`)
          .catch((err) =>
            api.logger.warn(`session_end reflection trigger failed: ${(err as Error).message}`),
          );
      }
    });

    /**
     * Background service: dashboard + scheduled workers.
     *
     * The plugin manifest deliberately keeps these off `runtime` (which is
     * lazy/per-recall) so the gateway can boot the long-running pieces
     * exactly once at startup and shut them down on reload.
     */
    let server: DashboardServer | null = null;
    let tuningTimer: NodeJS.Timeout | null = null;
    let compactorTimer: NodeJS.Timeout | null = null;
    let gitWatcherHandles: GitWatcherHandle[] = [];
    let transcriptWatcherHandles: TranscriptWatcherHandle[] = [];
    let shadowHandles: Array<{ stop: () => void }> = [];
    let reflectionHandle: ReflectionDaemonHandle | null = null;
    let moderatorHandle: ModeratorServiceHandle | null = null;
    let moderatorEventUnsub: (() => void) | null = null;
    let activePoolCfg: ResolvedPoolConfig | null = null;

    api.registerService({
      id: SERVICE_ID,
      async start(ctx) {
        const rawCfg = ctx.config as unknown as {
          plugins?: { entries?: { "memory-postgres"?: { config?: unknown } } };
        };
        const raw = rawCfg.plugins?.entries?.["memory-postgres"]?.config;
        if (!raw) {
          api.logger.warn(
            "memory-postgres: service start aborted — plugin config missing",
          );
          return;
        }
        try {
          validateConfig(raw);
        } catch (err) {
          api.logger.warn(
            `memory-postgres: service start aborted — config invalid: ${(err as Error).message}`,
          );
          return;
        }
        const cfg = resolveConfig(raw);

        activePoolCfg = {
          url: cfg.postgres.url,
          poolMax: cfg.postgres.poolMax,
          statementTimeoutMs: cfg.postgres.statementTimeoutMs,
        };

        // Bring up the schema once — idempotent, safe to call every boot.
        try {
          const pool = await getPool(activePoolCfg);
          await migrate(pool);
          // HNSW build can legitimately fail on a fresh install (no embeddings
          // yet → no known dim → no index). It can also fail in ways that
          // silently degrade T2 hybrid recall to seq scan (pgvector version
          // mismatch, OOM during build, etc). Surface either reason — the
          // first case is informational, the second is the user's only signal.
          await ensureHnswIndex(pool).catch((err) =>
            api.logger.warn(
              `memory-postgres: HNSW index not built (T2 hybrid will fall back to seq scan): ${
                (err as Error).message
              }`,
            ),
          );
        } catch (err) {
          api.logger.warn(
            `memory-postgres: schema migrate failed (will retry on first op): ${(err as Error).message}`,
          );
        }

        // Dashboard.
        if (cfg.dashboard.enabled) {
          try {
            const pool = await getPool(activePoolCfg);
            // Pull Telegram bot token + owner allowlist so the dashboard
            // can authenticate WebApp users via initData. When either is
            // missing, the dashboard falls back to global-token only.
            const liveCfg = ctx.config as unknown as {
              channels?: { telegram?: { botToken?: string } };
              commands?: { ownerAllowFrom?: string[] };
            };
            const tgBotToken = liveCfg.channels?.telegram?.botToken;
            const allowedTgIds = new Set<string>(
              (liveCfg.commands?.ownerAllowFrom ?? [])
                .filter((s): s is string => typeof s === "string" && s.startsWith("telegram:"))
                .map((s) => s.replace(/^telegram:/, "")),
            );
            server = await startDashboardServer(pool, cfg, {
              telegramBotToken: tgBotToken,
              allowedTelegramUserIds: allowedTgIds.size > 0 ? allowedTgIds : undefined,
            });
            api.logger.info(
              `memory-postgres: dashboard listening at ${server.url}` +
                (tgBotToken && allowedTgIds.size > 0
                  ? ` (telegram-webapp-auth: ${allowedTgIds.size} allowed user(s))`
                  : ""),
            );
            // Wire `/dashboard` Telegram command iff we have everything:
            // a publicly reachable HTTPS URL + bot token + owner allowlist.
            if (cfg.dashboard.publicUrl && tgBotToken && allowedTgIds.size > 0) {
              const { TelegramBotApi: TgApi } = await import("./src/moderator/telegram-api.js");
              MODULE_DASHBOARD_CMD = {
                telegram: new TgApi({ botToken: tgBotToken }),
                publicUrl: cfg.dashboard.publicUrl,
                ownerIds: allowedTgIds,
              };
              api.logger.info(
                `memory-postgres: /dashboard command armed → publicUrl=${cfg.dashboard.publicUrl}`,
              );
            } else if (cfg.dashboard.publicUrl) {
              api.logger.warn(
                "memory-postgres: dashboard.publicUrl set but missing telegram bot token or ownerAllowFrom — /dashboard command not armed",
              );
            }
          } catch (err) {
            api.logger.warn(
              `memory-postgres: dashboard failed to start: ${(err as Error).message}`,
            );
          }
        } else {
          api.logger.info("memory-postgres: dashboard disabled by config");
        }

        // Daily tuning analyzer + 24h guard. setInterval is good enough; the
        // analyzer is cheap (deterministic SQL) and idempotent.
        const tuningTick = async (): Promise<void> => {
          try {
            if (!activePoolCfg) {return;}
            const pool = await getPool(activePoolCfg);
            const analyzer = await runDailyAnalyzer(pool);
            const guards = await evaluateGuards(pool);
            if (analyzer.proposalIds.length > 0 || guards.evaluated > 0) {
              api.logger.info(
                `memory-postgres: tuning tick — proposals=${analyzer.proposalIds.length} `
                  + `guards_evaluated=${guards.evaluated} guards_reverted=${guards.reverted}`,
              );
            }
          } catch (err) {
            api.logger.warn(
              `memory-postgres: tuning tick failed: ${(err as Error).message}`,
            );
          }
        };
        tuningTimer = setInterval(() => void tuningTick(), DAY_MS);
        // Run once 5 minutes after start so the first day isn't empty.
        setTimeout(() => void tuningTick(), 5 * 60_000);

        // Compactor: aggregate stale chunks into cold gists. Cheap to run more
        // often than its eligibility window — the SQL filter is what actually
        // gates work. Daily is fine; the compactor itself only acts on
        // chunks > minAgeDays.
        const compactorTick = async (): Promise<void> => {
          try {
            if (!activePoolCfg) {return;}
            const pool = await getPool(activePoolCfg);
            const embedding = buildEmbeddingClientFromConfig({
              baseUrl: cfg.embedding.baseUrl,
              model: cfg.embedding.model,
              apiKeyEnv: cfg.embedding.apiKeyEnv,
              format: cfg.embedding.format,
              path: cfg.embedding.path,
            });
            const outcome = await compactCold(pool, embedding);
            if (outcome.gistsWritten > 0 || outcome.chunksDemoted > 0) {
              api.logger.info(
                `memory-postgres: compactor — clusters=${outcome.clustersFound} `
                  + `gists=${outcome.gistsWritten} demoted=${outcome.chunksDemoted}`,
              );
            }
          } catch (err) {
            api.logger.warn(
              `memory-postgres: compactor tick failed: ${(err as Error).message}`,
            );
          }
        };
        compactorTimer = setInterval(() => void compactorTick(), DAY_MS);

        // Git watchers — plugin-internal cron. Each watcher polls a local
        // repo on its own interval, ingests new commits, and bumps last_sha.
        // Fully deterministic, no agent involvement.
        if (cfg.gitWatchers.length > 0) {
          const pool = await getPool(activePoolCfg);
          const embedding = buildEmbeddingClientFromConfig({
            baseUrl: cfg.embedding.baseUrl,
            model: cfg.embedding.model,
            apiKeyEnv: cfg.embedding.apiKeyEnv,
            format: cfg.embedding.format,
            path: cfg.embedding.path,
          });
          for (const watcher of cfg.gitWatchers) {
            const handle = startGitWatcherDaemon({
              cfg,
              pool,
              embedding,
              watcher,
              logger: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
            });
            gitWatcherHandles.push(handle);
            api.logger.info(
              `memory-postgres: git-watcher started — id=${watcher.id} `
                + `path=${watcher.path} branch=${watcher.branch} interval=${watcher.intervalMs}ms`,
            );
          }
        }

        // Transcript watchers — every user / assistant message line in a
        // session JSONL gets ingested deterministically. This is what makes
        // the system actually "user-invisible" — you say something to the
        // bot and it lands in memory whether the agent thought to call
        // memory_store or not.
        if (cfg.transcriptWatchers.length > 0) {
          const pool = await getPool(activePoolCfg);
          const embedding = buildEmbeddingClientFromConfig({
            baseUrl: cfg.embedding.baseUrl,
            model: cfg.embedding.model,
            apiKeyEnv: cfg.embedding.apiKeyEnv,
            format: cfg.embedding.format,
            path: cfg.embedding.path,
          });
          for (const watcher of cfg.transcriptWatchers) {
            const handle = startTranscriptWatcherDaemon({
              cfg,
              pool,
              embedding,
              watcher,
              logger: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
            });
            transcriptWatcherHandles.push(handle);
            // Publish to module-level state so the session_end /
            // after_compaction hooks (registered at top-level register())
            // can invoke flushNow without crossing closures.
            MODULE_TRANSCRIPT_WATCHERS.push(handle);
            // Capture ingest deps once so the after_compaction hook can
            // build a CompactionContext without duplicating wiring.
            MODULE_INGEST_DEPS = { cfg, pool, embedding };
            api.logger.info(
              `memory-postgres: transcript-watcher started — id=${watcher.id} `
                + `dir=${watcher.dir} interval=${watcher.intervalMs}ms`,
            );
          }
        }

        // Reflection worker — daily LLM pass that produces a `kind='reflection'`
        // summary chunk per agent plus optional `kind='profile'` bullets that
        // get primed into T0 on every subsequent recall. Opt-in: stays off
        // unless `reflection.enabled` AND a model endpoint is configured.
        if (cfg.reflection.enabled && cfg.reflection.model.baseUrl) {
          try {
            const pool = await getPool(activePoolCfg);
            const embedding = buildEmbeddingClientFromConfig({
              baseUrl: cfg.embedding.baseUrl,
              model: cfg.embedding.model,
              apiKeyEnv: cfg.embedding.apiKeyEnv,
              format: cfg.embedding.format,
              path: cfg.embedding.path,
            });
            const llm = buildReflectionClient(cfg.reflection);
            reflectionHandle = startReflectionDaemon({
              deps: { pool, embedding, llm, cfg: cfg.reflection },
              intervalMs: cfg.reflection.intervalMs,
              logger: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
            });
            // Publish module-level so session_end hook can trigger
            // event-driven reflection (throttled inside the daemon).
            MODULE_REFLECTION_HANDLE = reflectionHandle;
            api.logger.info(
              `memory-postgres: reflection daemon started — ` +
                `format=${cfg.reflection.model.format} model=${cfg.reflection.model.model} ` +
                `intervalMs=${cfg.reflection.intervalMs}`,
            );
          } catch (err) {
            api.logger.warn(
              `memory-postgres: reflection daemon failed to start: ${(err as Error).message}`,
            );
          }
        } else if (cfg.reflection.enabled) {
          api.logger.warn(
            "memory-postgres: reflection.enabled=true but model.baseUrl is empty — daemon NOT started.",
          );
        }

        // Moderator service (Phase C) — hooks Telegram message_received and
        // runs the orchestrator-worker decision loop per (chat, user) with
        // 1.5s debounce. Off by default; opt in via config.moderator.enabled.
        if (cfg.moderator.enabled && cfg.moderator.model.baseUrl) {
          try {
            const pool = await getPool(activePoolCfg);
            const llm = buildModeratorLlm({
              format: cfg.moderator.model.format,
              baseUrl: cfg.moderator.model.baseUrl,
              model: cfg.moderator.model.model,
              apiKeyEnv: cfg.moderator.model.apiKeyEnv,
            });
            // Pull live config for telegram token + ownerAllowFrom.
            const live = ctx.config as unknown as {
              channels?: { telegram?: { botToken?: string } };
              commands?: { ownerAllowFrom?: string[] };
              gateway?: { auth?: { token?: string } };
              plugins?: {
                entries?: {
                  tavily?: {
                    enabled?: boolean;
                    config?: { webSearch?: { apiKey?: string; apiKeyEnv?: string } };
                  };
                };
              };
            };
            const botToken = live.channels?.telegram?.botToken ?? "";
            const ownerEntry = (live.commands?.ownerAllowFrom ?? [])
              .find((s) => typeof s === "string" && s.startsWith("telegram:"));
            const ownerUserId = ownerEntry ? ownerEntry.replace(/^telegram:/, "") : undefined;
            const dashTokenEnv = cfg.dashboard.tokenEnv;
            const ingestToken = dashTokenEnv ? (process.env[dashTokenEnv] ?? "") : "";

            // Reuse OpenClaw's tavily plugin credential when the operator
            // has already configured it for codex — saves them configuring
            // the same key twice. Resolution: inline apiKey wins; otherwise
            // apiKeyEnv → env lookup; otherwise undefined (worker falls
            // through to TAVILY_API_KEY env / credbroker / null).
            const openclawTavily = live.plugins?.entries?.tavily;
            let tavilyApiKey: string | undefined;
            if (openclawTavily?.enabled !== false && openclawTavily?.config?.webSearch) {
              const ws = openclawTavily.config.webSearch;
              if (typeof ws.apiKey === "string" && ws.apiKey.length > 0) {
                tavilyApiKey = ws.apiKey;
              } else if (typeof ws.apiKeyEnv === "string") {
                const v = process.env[ws.apiKeyEnv];
                if (v && v.length > 0) {tavilyApiKey = v;}
              }
            }

            if (!botToken) {
              api.logger.warn(
                "memory-postgres: moderator.enabled=true but channels.telegram.botToken empty — service NOT started.",
              );
            } else if (!ingestToken) {
              api.logger.warn(
                "memory-postgres: moderator.enabled=true but dashboard.tokenEnv unresolved — service NOT started (memory-writes would fail).",
              );
            } else {
              // Embedding client for cache.qa L2 semantic lookup (pre-Moderator)
              const embeddingClient = buildEmbeddingClientFromConfig({
                baseUrl: cfg.embedding.baseUrl,
                model: cfg.embedding.model,
                apiKeyEnv: cfg.embedding.apiKeyEnv,
                format: cfg.embedding.format,
                path: cfg.embedding.path,
              });
              // Worker LLM: reuses the moderator's model config but routes
              // through the tool-aware transport (Gemini :generateContent
              // with tool calls; OpenAI single-shot fallback only).
              const { buildWorkerLlmFromConfig } = await import("./src/moderator/worker-llm.js");
              const workerLlm = buildWorkerLlmFromConfig({
                format: cfg.moderator.model.format,
                baseUrl: cfg.moderator.model.baseUrl,
                model: cfg.moderator.model.model,
                apiKeyEnv: cfg.moderator.model.apiKeyEnv,
              });
              moderatorHandle = startModeratorService({
                enabled: true,
                llm,
                workerLlm,
                embedding: embeddingClient,
                telegramBotToken: botToken,
                ownerUserId,
                ingestUrl: `http://${cfg.dashboard.host}:${cfg.dashboard.port}/api/ingest`,
                ingestToken,
                cfg,
                pool,
                agentId: cfg.moderator.agentId,
                tavilyApiKey,
                logger: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
                debounceMs: cfg.moderator.debounceMs,
              });
              // Publish to module-level state so the top-level api.on
              // hook (which may live in a DIFFERENT register() closure)
              // can forward events to us.
              MODULE_MODERATOR_HANDLE = moderatorHandle;
              api.logger.info(
                `memory-postgres: moderator service started — model=${cfg.moderator.model.format}:${cfg.moderator.model.model} ` +
                  `debounceMs=${cfg.moderator.debounceMs} owner=${ownerUserId ?? "(none)"}`,
              );
            }
          } catch (err) {
            api.logger.warn(
              `memory-postgres: moderator service failed to start: ${(err as Error).message}`,
            );
          }
        } else if (cfg.moderator.enabled) {
          api.logger.warn(
            "memory-postgres: moderator.enabled=true but model.baseUrl is empty — service NOT started.",
          );
        }

        // Shadow comparators — for every gpt-5.5 turn we observe in the
        // trajectory, replay the same prompt against a challenger model
        // (qwen3.6-35B by default) and store both sides side-by-side. Lets
        // the dashboard show real cost/latency/quality data without
        // touching the live Discord reply.
        if (cfg.shadowComparators.length > 0) {
          const pool = await getPool(activePoolCfg);
          for (const comparator of cfg.shadowComparators) {
            const handle = startShadowComparator({
              pool,
              comparator,
              logger: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
            });
            shadowHandles.push(handle);
            api.logger.info(
              `memory-postgres: shadow-comparator started — id=${comparator.id} ` +
                `model=${comparator.model} interval=${comparator.intervalMs}ms`,
            );
          }
        }
      },

      async stop() {
        if (tuningTimer) {clearInterval(tuningTimer);}
        if (compactorTimer) {clearInterval(compactorTimer);}
        if (reflectionHandle) {
          try { reflectionHandle.stop(); } catch { /* ignore */ }
          reflectionHandle = null;
        }
        MODULE_REFLECTION_HANDLE = null;
        if (moderatorHandle) {
          try { moderatorHandle.stop(); } catch { /* ignore */ }
          moderatorHandle = null;
        }
        MODULE_MODERATOR_HANDLE = null;
        MODULE_INGEST_DEPS = null;
        MODULE_DASHBOARD_CMD = null;
        if (moderatorEventUnsub) {
          try { moderatorEventUnsub(); } catch { /* ignore */ }
          moderatorEventUnsub = null;
        }
        tuningTimer = null;
        compactorTimer = null;
        for (const h of gitWatcherHandles) {
          try { h.stop(); } catch { /* ignore */ }
        }
        gitWatcherHandles = [];
        for (const h of transcriptWatcherHandles) {
          try { h.stop(); } catch { /* ignore */ }
        }
        transcriptWatcherHandles = [];
        MODULE_TRANSCRIPT_WATCHERS = [];
        for (const h of shadowHandles) {
          try { h.stop(); } catch { /* ignore */ }
        }
        shadowHandles = [];
        if (server) {
          try {
            await server.close();
          } catch {
            /* swallow */
          }
          server = null;
        }
        if (activePoolCfg) {
          try {
            await closePool(activePoolCfg);
          } catch {
            /* swallow */
          }
          activePoolCfg = null;
        }
      },
    });

    api.logger.info(
      "memory-postgres: capability + tools registered "
        + "(memory_search, memory_get, memory_store, memory_update, memory_forget; "
        + "services: dashboard, tuning, compactor, reflection)",
    );
  },
});
