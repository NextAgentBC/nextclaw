/**
 * Phase 4 live e2e: recall tier-walk + parallel routes + cache.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  EmbeddingClient,
  type EmbedRequest,
  type EmbedResult,
} from "../src/embedding/client.js";
import { ingestOne } from "../src/ingest/pipeline.js";
import { recall } from "../src/recall/router.js";
import { migrate, ensureHnswIndex, recordEmbeddingDims } from "../src/storage/migrate.js";
import { closeAllPools, getPool } from "../src/storage/pool.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;

class StubEmbeddingClient extends EmbeddingClient {
  callCount = 0;
  constructor() {
    super({ baseUrl: "http://stub", model: "stub-embed:16" });
  }
  override async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.callCount += 1;
    const embeddings = req.inputs.map((s) => {
      const v = Array.from({ length: 16 }, () => 0);
      for (let i = 0; i < s.length; i += 1) {v[i % 16] += s.charCodeAt(i) / 1024;}
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { embeddings, model: "stub-embed:16", dims: 16, latencyMs: 0 };
  }
  override async probe(): Promise<{ ok: true; dims: number; latencyMs: number }> {
    return { ok: true, dims: 16, latencyMs: 0 };
  }
}

const fixedNow = new Date("2026-05-02T08:00:00Z");

describeLive("memory-postgres recall tier-walk (live PG)", () => {
  const cfg = resolveConfig({
    postgres: { url: PG_URL ?? "postgres://x" },
    embedding: { provider: "stub", model: "stub-embed:16" },
  });

  beforeAll(async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
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

    // Seed: ingest several chunks across anchors / time buckets / entities.
    const embedding = new StubEmbeddingClient();
    await ingestOne(
      { cfg, pool, embedding },
      {
        text: "今天和 @shadow 在 openclaw/openclaw 改了 PR #1234，午饭吃了 1800 卡",
        source: "session",
        agentSessionId: "session-A",
        anchors: { cwd: "/tmp/test-repo", branch: "main" },
        now: fixedNow,
      },
    );
    await ingestOne(
      { cfg, pool, embedding },
      {
        text: "OpenClaw uses pgvector for storing embeddings and supports hybrid search",
        source: "manual",
        anchors: { cwd: "/tmp/test-repo" },
        now: fixedNow,
      },
    );
    await ingestOne(
      { cfg, pool, embedding },
      {
        text: "yesterday I ran 5 公里 around the lake",
        source: "session",
        agentSessionId: "session-A",
        now: new Date("2026-05-01T18:00:00Z"),
      },
    );
  }, 60_000);

  afterAll(async () => {
    await closeAllPools();
  });

  it("anchor-only recall hits T2_anchor without embedding the query", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const before = embedding.callCount;
    const result = await recall(
      { cfg, pool, embedding },
      {
        query: "anything",
        maxResults: 5,
        anchors: { cwd: "/tmp/test-repo" },
      },
    );
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.zeroCostHit).toBe(true);
    expect(result.embedCalls).toBe(0);
    expect(embedding.callCount).toBe(before); // never embedded
    expect(result.hitTier).toBe("t2_anchor");
    expect(result.routesRun).toContain("anchor");
  });

  it("semantic recall runs when no anchors are provided", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const result = await recall(
      { cfg, pool, embedding },
      { query: "hybrid search pgvector", maxResults: 5 },
    );
    expect(result.embedCalls).toBe(1);
    expect(result.routesRun).toContain("semantic");
    expect(result.hitTier).toBe("t2_hybrid");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it("cache hit on second identical recall returns 0-cost T1", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const r1 = await recall(
      { cfg, pool, embedding },
      { query: "lake run", maxResults: 5 },
    );
    expect(r1.fromCache).toBe(false);
    const before = embedding.callCount;
    const r2 = await recall(
      { cfg, pool, embedding },
      { query: "lake run", maxResults: 5 },
    );
    expect(r2.fromCache).toBe(true);
    expect(r2.hitTier).toBe("t1");
    expect(r2.embedCalls).toBe(0);
    expect(r2.llmTokensUsed).toBe(0);
    expect(embedding.callCount).toBe(before);
  });

  it("cache.hot_chunks gets populated after recall hits", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    await recall(
      { cfg, pool, embedding },
      { query: "openclaw uses", maxResults: 3 },
    );
    const hot = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM cache.hot_chunks",
    );
    expect(Number(hot.rows[0].n)).toBeGreaterThanOrEqual(1);
  });

  it("audit row records hit_tier + score for every recall", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    await recall(
      { cfg, pool, embedding },
      { query: "memory router unique audit query", maxResults: 3 },
    );
    const row = await pool.query<{
      hit_tier: string;
      score: number;
      embed_calls: number;
    }>(
      `SELECT hit_tier, score, embed_calls
         FROM audit.recall_decisions
         WHERE query_text = 'memory router unique audit query'
         ORDER BY ts DESC LIMIT 1`,
    );
    expect(row.rowCount).toBe(1);
    expect(["t1", "t2_anchor", "t2_hybrid"]).toContain(row.rows[0].hit_tier);
    expect(row.rows[0].score).toBeGreaterThan(0);
  });
});
