/**
 * End-to-end memory-postgres test against a real local Postgres.
 *
 * Requires a Postgres reachable at OPENCLAW_MEMORY_PG_URL. The repo provides
 * a docker-compose under `extensions/memory-postgres/dev/` (host port 55432).
 *
 * Skipped silently when the env var is unset so CI without Docker still passes.
 *
 * Embedding side: we don't require a live qwen3 here. The test injects a fake
 * EmbeddingClient that returns deterministic 16-dim vectors so the migration's
 * HNSW index and the manager's search SQL exercise pgvector end to end.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  EmbeddingClient,
  type EmbedRequest,
  type EmbedResult,
} from "../src/embedding/client.js";
import { PostgresMemoryManager, writeChunk } from "../src/manager.js";
import { migrate, ensureHnswIndex, recordEmbeddingDims } from "../src/storage/migrate.js";
import { closeAllPools, getPool } from "../src/storage/pool.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;

class StubEmbeddingClient extends EmbeddingClient {
  constructor() {
    super({ baseUrl: "http://stub", model: "stub-embed:16" });
  }
  override async embed(req: EmbedRequest): Promise<EmbedResult> {
    // Deterministic 16-dim "embedding" derived from input string char codes.
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

describeLive("memory-postgres e2e (live PG)", () => {
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
    // Drop our schemas if a previous run left them, then re-migrate. Keeps
    // the test deterministic without a separate teardown step.
    await pool.query(`
      DROP SCHEMA IF EXISTS semantic CASCADE;
      DROP SCHEMA IF EXISTS structured CASCADE;
      DROP SCHEMA IF EXISTS cache CASCADE;
      DROP SCHEMA IF EXISTS cold CASCADE;
      DROP SCHEMA IF EXISTS audit CASCADE;
    `);
    const result = await migrate(pool);
    expect(result.applied.length).toBeGreaterThanOrEqual(4);
    // HNSW deferred until we know dims; record + bring up.
    await recordEmbeddingDims(pool, 16, "stub-embed:16");
    const indexed = await ensureHnswIndex(pool);
    expect(indexed).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await closeAllPools();
  });

  it("runs migrations idempotently", async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(4);
  });

  it("writes a chunk + multi-key indexes and searches via hybrid SQL", async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
    const embedding = new StubEmbeddingClient();

    const w1 = await writeChunk(pool, embedding, {
      text: "今天和 Shadow 在 Carbon 仓库改了 PR #1234 午饭吃了 1800 卡",
      source: "session",
      sourceRef: "session-abc",
      kind: "fact",
      agentSessionId: "session-abc",
    });
    expect(w1.written).toBe(true);

    // Duplicate write returns same id, written=false.
    const w1dup = await writeChunk(pool, embedding, {
      text: "今天和 Shadow 在 Carbon 仓库改了 PR #1234 午饭吃了 1800 卡",
      source: "session",
      agentSessionId: "session-abc",
    });
    expect(w1dup.written).toBe(false);
    expect(w1dup.id).toBe(w1.id);

    await writeChunk(pool, embedding, {
      text: "OpenClaw 是一个本地优先的 AI 助手",
      source: "session",
      sourceRef: "session-abc",
      kind: "doc",
      agentSessionId: "session-abc",
    });

    // Verify chunk_indexes were attached (time_bucket + anchor_session).
    const idxRows = await pool.query<{ kind: string; n: string }>(
      "SELECT kind, count(*)::text AS n FROM semantic.chunk_indexes GROUP BY kind ORDER BY kind",
    );
    const kinds = new Map(idxRows.rows.map((r) => [r.kind, Number(r.n)]));
    expect(kinds.get("time_bucket")).toBeGreaterThanOrEqual(2);
    expect(kinds.get("anchor_session")).toBeGreaterThanOrEqual(2);

    // Search exercises pgvector + tsvector + hybrid scoring.
    const manager = new PostgresMemoryManager({ cfg, pool, embedding });
    const results = await manager.search("Shadow Carbon PR", { maxResults: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].snippet).toMatch(/Shadow|Carbon|PR/);

    // Audit row should exist with a non-null score.
    const audit = await pool.query<{ score: number; hit_tier: string; returned: number }>(
      "SELECT score, hit_tier, returned FROM audit.recall_decisions ORDER BY ts DESC LIMIT 1",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].hit_tier).toBe("t2_hybrid");
    expect(audit.rows[0].returned).toBeGreaterThanOrEqual(1);
    expect(typeof audit.rows[0].score).toBe("number");
    expect(audit.rows[0].score).toBeGreaterThan(0);
    expect(audit.rows[0].score).toBeLessThanOrEqual(100);
  });

  it("LISTEN/NOTIFY fires on audit insert", async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
    const client = await pool.connect();
    try {
      const events: string[] = [];
      const onNotify = (msg: { channel: string; payload?: string }) => {
        if (msg.channel === "audit_events" && msg.payload) {events.push(msg.payload);}
      };
      client.on("notification", onNotify);
      await client.query("LISTEN audit_events");

      // Trigger an event through the manager search path.
      const manager = new PostgresMemoryManager({
        cfg,
        pool,
        embedding: new StubEmbeddingClient(),
      });
      await manager.search("anything", { maxResults: 1 });

      // Give the audit-write fire-and-forget Promise + NOTIFY time to land.
      const deadline = Date.now() + 3000;
      while (events.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await client.query("UNLISTEN audit_events");
      client.removeListener("notification", onNotify);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(events[0]) as { table: string; hit_tier?: string };
      expect(payload.table).toBe("recall_decisions");
      expect(payload.hit_tier).toBe("t2_hybrid");
    } finally {
      client.release();
    }
  });
});
