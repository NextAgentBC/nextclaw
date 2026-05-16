/**
 * Centralised pg.Pool wrapper. All SQL in memory-postgres goes through this.
 *
 * Responsibilities:
 *   - Single Pool per (url, statementTimeoutMs) combo
 *   - Lazy registration of pgvector type parser
 *   - Healthcheck for the doctor / dashboard
 *   - Graceful shutdown when the plugin unloads
 */

import pg from "pg";
import pgvector from "pgvector/pg";

const { Pool } = pg;
type PgPool = pg.Pool;
type PoolConfig = pg.PoolConfig;

export type PoolKey = string;

export type ResolvedPoolConfig = {
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
};

const POOLS = new Map<PoolKey, PgPool>();

function makeKey(cfg: ResolvedPoolConfig): PoolKey {
  return `${cfg.url}|${cfg.poolMax}|${cfg.statementTimeoutMs}`;
}

function buildPoolConfig(cfg: ResolvedPoolConfig): PoolConfig {
  return {
    connectionString: cfg.url,
    max: cfg.poolMax,
    statement_timeout: cfg.statementTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: "openclaw-memory-postgres",
  };
}

let pgvectorRegistered = false;

async function ensurePgvectorTypes(pool: PgPool): Promise<void> {
  if (pgvectorRegistered) {return;}
  // pgvector ships a registerType helper that asks the server for the
  // pgvector OID and installs a parser into pg's TypeOverrides.
  // It is keyed off the pool's first client; subsequent acquisitions reuse
  // the registered parser.
  const client = await pool.connect();
  try {
    await pgvector.registerType(client);
    pgvectorRegistered = true;
  } finally {
    client.release();
  }
}

export async function getPool(cfg: ResolvedPoolConfig): Promise<PgPool> {
  const key = makeKey(cfg);
  let pool = POOLS.get(key);
  if (!pool) {
    pool = new Pool(buildPoolConfig(cfg));
    pool.on("error", (err) => {
      // pg pool surfaces idle-connection errors here; we log but don't crash.
      // Real query errors are still thrown to callers.
      console.warn("[memory-postgres] pool error:", err.message);
    });
    POOLS.set(key, pool);
  }
  await ensurePgvectorTypes(pool);
  return pool;
}

export async function closePool(cfg: ResolvedPoolConfig): Promise<void> {
  const key = makeKey(cfg);
  const pool = POOLS.get(key);
  if (!pool) {return;}
  POOLS.delete(key);
  await pool.end();
}

export async function closeAllPools(): Promise<void> {
  const pools = [...POOLS.values()];
  POOLS.clear();
  await Promise.all(pools.map(async (p) => p.end()));
}

export type HealthResult = {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  pgvectorVersion?: string;
  pgTrgmVersion?: string;
  btreeGinVersion?: string;
  error?: string;
};

export async function healthcheck(cfg: ResolvedPoolConfig): Promise<HealthResult> {
  const start = Date.now();
  try {
    const pool = await getPool(cfg);
    const versionRow = await pool.query<{ server_version: string }>(
      "SHOW server_version",
    );
    const ext = await pool.query<{ extname: string; extversion: string }>(
      "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm','btree_gin')",
    );
    const exts = new Map<string, string>(ext.rows.map((r) => [r.extname, r.extversion]));
    return {
      ok: true,
      latencyMs: Date.now() - start,
      serverVersion: versionRow.rows[0]?.server_version,
      pgvectorVersion: exts.get("vector"),
      pgTrgmVersion: exts.get("pg_trgm"),
      btreeGinVersion: exts.get("btree_gin"),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

export type { PgPool };
