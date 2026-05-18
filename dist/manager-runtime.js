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
import { resolveConfig, } from "./src/config.js";
import { buildEmbeddingClientFromConfig } from "./src/embedding/client.js";
import { PostgresMemoryManager } from "./src/manager.js";
import { migrate, ensureHnswIndex } from "./src/storage/migrate.js";
import { closePool, getPool } from "./src/storage/pool.js";
const bundles = new Map();
function bundleKey(cfg) {
    return `${cfg.postgres.url}|${cfg.embedding.model}|${cfg.embedding.baseUrl ?? ""}`;
}
function pluginConfigOf(cfg) {
    // Defensive read; callers should validate upstream via openclaw.plugin.json.
    const entry = cfg.plugins?.entries?.["memory-postgres"]?.config;
    if (!entry) {
        throw new Error("[memory-postgres] config missing: plugins.entries.memory-postgres.config not set");
    }
    return entry;
}
async function getOrCreateBundle(cfg) {
    const raw = pluginConfigOf(cfg);
    const resolved = resolveConfig(raw);
    const key = bundleKey(resolved);
    const existing = bundles.get(key);
    if (existing) {
        return existing;
    }
    const poolCfg = {
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
    // We do NOT swallow this silently — a failed HNSW build on a populated
    // database means T2 hybrid recall silently falls back to seq scan, which
    // is the kind of perf regression users only notice when latency goes from
    // 250ms to multi-second. Logging keeps the failure observable without
    // bringing down the rest of the plugin.
    await ensureHnswIndex(pool).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[memory-postgres] HNSW index not built (T2 hybrid degrades to seq scan): ${err.message}`);
    });
    const bundle = { pool, embedding, manager, cfg: resolved, poolCfg };
    bundles.set(key, bundle);
    return bundle;
}
export const memoryRuntime = {
    async getMemorySearchManager({ cfg }) {
        try {
            const bundle = await getOrCreateBundle(cfg);
            return { manager: bundle.manager };
        }
        catch (error) {
            return {
                manager: null,
                error: error.message,
            };
        }
    },
    resolveMemoryBackendConfig() {
        return { backend: "builtin" };
    },
    async closeAllMemorySearchManagers() {
        const all = [...bundles.values()];
        bundles.clear();
        await Promise.all(all.map(async (b) => {
            try {
                await b.manager.close();
            }
            catch {
                /* ignore close errors */
            }
            try {
                await closePool(b.poolCfg);
            }
            catch {
                /* ignore close errors */
            }
        }));
    },
};
