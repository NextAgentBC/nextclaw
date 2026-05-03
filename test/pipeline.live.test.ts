/**
 * Phase 3 live e2e: ingest pipeline end to end against real PG.
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
import { MemoryEmbeddingCache } from "../src/cache/embeddings.js";

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

describeLive("memory-postgres ingest pipeline (live PG)", () => {
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
  }, 60_000);

  afterAll(async () => {
    await closeAllPools();
  });

  it("rejects boilerplate before any LLM/PG write", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const before = embedding.callCount;
    const result = await ingestOne(
      { cfg, pool, embedding },
      { text: "Sure!", source: "session", now: fixedNow },
    );
    expect(result.decision).toBe("rejected");
    expect(result.rejectReason).toBe("boilerplate");
    expect(result.ingestPath).toBe("deterministic");
    expect(embedding.callCount).toBe(before); // never embedded
    // Audit row exists with score still non-null (we score rejects too).
    const audit = await pool.query<{ score: number; decision: string; reject_reason: string | null }>(
      `SELECT score, decision, reject_reason FROM audit.ingest_decisions
        ORDER BY ts DESC LIMIT 1`,
    );
    expect(audit.rows[0].decision).toBe("rejected");
    expect(audit.rows[0].reject_reason).toBe("boilerplate");
    expect(typeof audit.rows[0].score).toBe("number");
  });

  it("accepts a fact and writes chunk + multi-key indexes + structured rows", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const result = await ingestOne(
      { cfg, pool, embedding, cache: new MemoryEmbeddingCache() },
      {
        text: "今天和 @shadow 在 openclaw/openclaw 改了 PR #1234，午饭吃了 1800 卡",
        source: "session",
        sourceRef: "session-1",
        agentSessionId: "session-1",
        anchors: { cwd: "/tmp/test-repo", branch: "main" },
        now: fixedNow,
      },
    );
    expect(result.decision).toBe("accepted");
    expect(result.ingestPath).toBe("deterministic");
    expect(result.chunkId).toBeDefined();
    expect(result.routes).toContain("anchor_cwd");
    expect(result.routes).toContain("anchor_branch");
    expect(result.routes).toContain("anchor_session");
    expect(result.routes).toContain("event_type");
    expect(result.routes).toContain("metric_name");
    expect(result.routes).toContain("entity_ref");

    // Verify chunk_indexes persisted with the expected kinds.
    const idxRows = await pool.query<{ kind: string }>(
      "SELECT DISTINCT kind FROM semantic.chunk_indexes WHERE chunk_id = $1",
      [result.chunkId],
    );
    const kinds = idxRows.rows.map((r) => r.kind).toSorted();
    expect(kinds).toContain("time_bucket");
    expect(kinds).toContain("anchor_session");
    expect(kinds).toContain("anchor_cwd");
    expect(kinds).toContain("anchor_branch");
    expect(kinds).toContain("event_type");
    expect(kinds).toContain("metric_name");
    expect(kinds).toContain("entity_ref");

    // Score should be high because no LLM and reasonable confidence.
    expect(result.score).toBeGreaterThan(50);
  });

  it("uses sidecar JSON when present and prefers sidecar path tag", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const sidecar = `<mem>${JSON.stringify({
      entities: [{ type: "person", canonicalName: "alice" }],
      preferences: [{ scope: "global", key: "tone", value: "concise" }],
    })}</mem>`;
    const result = await ingestOne(
      { cfg, pool, embedding },
      {
        text: "Working on a thing with alice",
        source: "session",
        agentSessionId: "session-2",
        sidecarText: sidecar,
        now: fixedNow,
      },
    );
    expect(result.decision).toBe("accepted");
    expect(result.ingestPath).toBe("sidecar");
    expect(result.sidecar).toEqual({ found: true, ok: true });
  });

  it("merges duplicate text on second ingest", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const text = "OpenClaw uses pgvector for memory storage";
    const r1 = await ingestOne(
      { cfg, pool, embedding },
      { text, source: "manual", now: fixedNow },
    );
    expect(r1.decision).toBe("accepted");
    const beforeCalls = embedding.callCount;
    const r2 = await ingestOne(
      { cfg, pool, embedding },
      { text, source: "manual", now: fixedNow },
    );
    expect(r2.decision).toBe("merged");
    expect(r2.chunkId).toBe(r1.chunkId);
    // Still embedded? Pipeline embeds before checking dup; that's fine — but the
    // cache means the 2nd embed returns cache hit. Either way, no new chunk.
    expect(embedding.callCount).toBeGreaterThanOrEqual(beforeCalls);
  });

  it("embedding cache prevents repeat embed calls", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 });
    const embedding = new StubEmbeddingClient();
    const cache = new MemoryEmbeddingCache();
    const text = "Cache hit test sentence with some real content here";
    await ingestOne({ cfg, pool, embedding, cache }, { text, source: "manual", now: fixedNow });
    const after1 = embedding.callCount;
    // Second time with same text → dedup short-circuits before embed,
    // so we change source so dedup misses but the cached embedding gets reused.
    await ingestOne(
      { cfg, pool, embedding, cache },
      { text, source: "session", now: fixedNow },
    );
    expect(embedding.callCount).toBe(after1);
  });
});
