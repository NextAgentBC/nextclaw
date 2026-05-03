/**
 * Phase 7 live e2e: dashboard endpoints + SSE stream.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  EmbeddingClient,
  type EmbedRequest,
  type EmbedResult,
} from "../src/embedding/client.js";
import { ingestOne } from "../src/ingest/pipeline.js";
import { migrate, ensureHnswIndex, recordEmbeddingDims } from "../src/storage/migrate.js";
import { closeAllPools, getPool } from "../src/storage/pool.js";
import { startDashboardServer, type DashboardServer } from "../src/dashboard/server.js";
import { startTail } from "../src/cli/tail.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;

class StubEmbeddingClient extends EmbeddingClient {
  constructor() {
    super({ baseUrl: "http://stub", model: "stub-embed:16" });
  }
  override async embed(req: EmbedRequest): Promise<EmbedResult> {
    const embeddings = req.inputs.map((s) => {
      const v = Array.from({ length: 16 }, () => 0);
      for (let i = 0; i < s.length; i += 1) {
        v[i % 16] += s.charCodeAt(i) / 1024;
      }
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { embeddings, model: "stub-embed:16", dims: 16, latencyMs: 0 };
  }
  override async probe(): Promise<{ ok: true; dims: number; latencyMs: number }> {
    return { ok: true, dims: 16, latencyMs: 0 };
  }
}

describeLive("memory-postgres dashboard + tail (live PG)", () => {
  const cfg = resolveConfig({
    postgres: { url: PG_URL ?? "postgres://x" },
    embedding: { provider: "stub", model: "stub-embed:16" },
    dashboard: { enabled: true, host: "127.0.0.1", port: 8769 },
  });
  const pgCfg = { url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 };

  let server: DashboardServer | null = null;

  beforeAll(async () => {
    const pool = await getPool(pgCfg);
    await pool.query(`
      DROP SCHEMA IF EXISTS semantic CASCADE;
      DROP SCHEMA IF EXISTS structured CASCADE;
      DROP SCHEMA IF EXISTS cache CASCADE;
      DROP SCHEMA IF EXISTS cold CASCADE;
      DROP SCHEMA IF EXISTS audit CASCADE;
    `);
    await migrate(pool);
    await recordEmbeddingDims(pool, 16, "stub-embed:16");
    await ensureHnswIndex(pool);

    // Some events to populate /api/recent + /api/stats.
    const embedding = new StubEmbeddingClient();
    await ingestOne({ cfg, pool, embedding }, { text: "Sure!", source: "session" });
    await ingestOne(
      { cfg, pool, embedding },
      { text: "Working on memory dashboard with shadow", source: "session" },
    );

    server = await startDashboardServer(pool, cfg);
  }, 60_000);

  afterAll(async () => {
    if (server) {await server.close();}
    await closeAllPools();
  });

  it("/api/stats returns 24h rollups", async () => {
    const resp = await fetch(`${server!.url}api/stats`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      hourly: unknown[];
      ingestCounts: Record<string, string> | null;
      recallTiers: Array<{ hit_tier: string; n: string }>;
    };
    expect(json.ingestCounts).not.toBeNull();
    expect(Number(json.ingestCounts?.rejected ?? "0") + Number(json.ingestCounts?.accepted ?? "0"))
      .toBeGreaterThanOrEqual(2);
  });

  it("/api/recent returns the last ingest + recall rows", async () => {
    const resp = await fetch(`${server!.url}api/recent`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ingests: unknown[]; recalls: unknown[] };
    expect(Array.isArray(json.ingests)).toBe(true);
    expect(json.ingests.length).toBeGreaterThanOrEqual(2);
  });

  it("serves the dashboard html shell", async () => {
    const resp = await fetch(server!.url);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("OpenClaw Memory Dashboard");
  });

  it("memory tail receives events via LISTEN/NOTIFY", async () => {
    const pool = await getPool(pgCfg);
    const lines: string[] = [];
    const handle = await startTail(pool, {
      filter: "ingest",
      out: (line) => lines.push(line),
    });
    try {
      const embedding = new StubEmbeddingClient();
      await ingestOne(
        { cfg, pool, embedding },
        { text: "Tail subscribed and watching for new accepts", source: "session" },
      );
      // Give pg_notify a moment to fan out.
      const deadline = Date.now() + 2000;
      while (lines.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toMatch(/ACCEPT|REJECT|MERGE|QUAR/);
    } finally {
      await handle.stop();
    }
  });
});
