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
import { buildSearchTool, buildStoreTool } from "./src/tools.js";
import { compactCold } from "./src/workers/compactor.js";
import { startGitWatcherDaemon, type GitWatcherHandle } from "./src/workers/git-watcher.js";
import { startTranscriptWatcherDaemon, type TranscriptWatcherHandle } from "./src/workers/transcript-watcher.js";
import { startShadowComparator } from "./src/workers/shadow-comparator.js";
import { evaluateGuards, runDailyAnalyzer } from "./src/workers/tuning.js";

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
        return buildStoreTool({ config, sessionKey: ctx.sessionKey });
      },
      { names: ["memory_store"] },
    );

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
          await ensureHnswIndex(pool).catch(() => undefined);
        } catch (err) {
          api.logger.warn(
            `memory-postgres: schema migrate failed (will retry on first op): ${(err as Error).message}`,
          );
        }

        // Dashboard.
        if (cfg.dashboard.enabled) {
          try {
            const pool = await getPool(activePoolCfg);
            server = await startDashboardServer(pool, cfg);
            api.logger.info(`memory-postgres: dashboard listening at ${server.url}`);
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
            api.logger.info(
              `memory-postgres: transcript-watcher started — id=${watcher.id} `
                + `dir=${watcher.dir} interval=${watcher.intervalMs}ms`,
            );
          }
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
        + "(memory_search, memory_store, dashboard, tuning, compactor)",
    );
  },
});
