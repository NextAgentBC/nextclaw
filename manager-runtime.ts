/**
 * memory-postgres runtime: orchestrates the lifecycle of the memory manager.
 *
 * Loaded lazily from index.ts so the heavy pg dependency only enters the
 * graph when this plugin is actually slotted in.
 *
 * Responsibilities:
 *   - parse + resolve plugin config
 *   - bring up pg.Pool, run migrations
 *   - construct EmbeddingClient (qwen3 over ollama)
 *   - construct PostgresMemoryManager
 *   - export a MemoryPluginRuntime that core can call
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  resolveConfig,
  type MemoryPostgresConfig,
  type ResolvedMemoryPostgresConfig,
} from "./src/config.js";
import { buildEmbeddingClientFromConfig, type EmbeddingClient } from "./src/embedding/client.js";
import { PostgresMemoryManager } from "./src/manager.js";
import { migrate, ensureHnswIndex } from "./src/storage/migrate.js";
import { closePool, getPool, type PgPool, type ResolvedPoolConfig } from "./src/storage/pool.js";

type Bundle = {
  pool: PgPool;
  embedding: EmbeddingClient;
  manager: PostgresMemoryManager;
  cfg: ResolvedMemoryPostgresConfig;
  poolCfg: ResolvedPoolConfig;
};

const bundles = new Map<string, Bundle>();

function bundleKey(cfg: ResolvedMemoryPostgresConfig): string {
  return `${cfg.postgres.url}|${cfg.embedding.model}|${cfg.embedding.baseUrl ?? ""}`;
}

function pluginConfigOf(cfg: OpenClawConfig): MemoryPostgresConfig {
  // Defensive read; callers should validate upstream via openclaw.plugin.json.
  const entry = (cfg as unknown as {
    plugins?: { entries?: { "memory-postgres"?: { config?: MemoryPostgresConfig } } };
  }).plugins?.entries?.["memory-postgres"]?.config;
  if (!entry) {
    throw new Error(
      "[memory-postgres] config missing: plugins.entries.memory-postgres.config not set",
    );
  }
  return entry;
}

async function getOrCreateBundle(cfg: OpenClawConfig): Promise<Bundle> {
  const raw = pluginConfigOf(cfg);
  const resolved = resolveConfig(raw);
  const key = bundleKey(resolved);
  const existing = bundles.get(key);
  if (existing) {return existing;}

  const poolCfg: ResolvedPoolConfig = {
    url: resolved.postgres.url,
    poolMax: resolved.postgres.poolMax,
    statementTimeoutMs: resolved.postgres.statementTimeoutMs,
  };
  const pool = await getPool(poolCfg);
  await migrate(pool);

  const embedding = buildEmbeddingClientFromConfig({
    baseUrl: resolved.embedding.baseUrl,
    model: resolved.embedding.model,
    apiKeyEnv: resolved.embedding.apiKeyEnv,
    format: resolved.embedding.format,
    path: resolved.embedding.path,
  });
  const manager = new PostgresMemoryManager({ cfg: resolved, pool, embedding });

  // Try to bring up the HNSW index now if dims already known; otherwise the
  // first manager.search() will probe and migrate() will pick it up next time.
  await ensureHnswIndex(pool).catch(() => undefined);

  const bundle: Bundle = { pool, embedding, manager, cfg: resolved, poolCfg };
  bundles.set(key, bundle);
  return bundle;
}

export const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager({ cfg }) {
    try {
      const bundle = await getOrCreateBundle(cfg);
      return { manager: bundle.manager };
    } catch (error) {
      return {
        manager: null,
        error: (error as Error).message,
      };
    }
  },

  resolveMemoryBackendConfig() {
    return { backend: "builtin" };
  },

  async closeAllMemorySearchManagers() {
    const all = [...bundles.values()];
    bundles.clear();
    await Promise.all(
      all.map(async (b) => {
        try {
          await b.manager.close();
        } catch {
          /* ignore close errors */
        }
        try {
          await closePool(b.poolCfg);
        } catch {
          /* ignore close errors */
        }
      }),
    );
  },
};
