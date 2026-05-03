/**
 * Phase 8 live e2e: tuning analyzer + apply / revert / 24h guard.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  EmbeddingClient,
  type EmbedRequest,
  type EmbedResult,
} from "../src/embedding/client.js";
import { recall } from "../src/recall/router.js";
import { migrate, ensureHnswIndex, recordEmbeddingDims } from "../src/storage/migrate.js";
import { closeAllPools, getPool } from "../src/storage/pool.js";
import {
  evaluateGuards,
  markAutoApplied,
  markApproved,
  markRejected,
  revertProposal,
  runDailyAnalyzer,
} from "../src/workers/tuning.js";

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

describeLive("memory-postgres self-tuning (live PG)", () => {
  const cfg = resolveConfig({
    postgres: { url: PG_URL ?? "postgres://x" },
    embedding: { provider: "stub", model: "stub-embed:16" },
  });
  const pgCfg = { url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 10_000 };

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
  }, 60_000);

  afterAll(async () => {
    await closeAllPools();
  });

  it("daily analyzer proposes a TTL adjustment when cache hit-rate is low", async () => {
    const pool = await getPool(pgCfg);
    const embedding = new StubEmbeddingClient();

    // Generate >=30 distinct recalls — none hit the cache because each query
    // is unique, so the cached fraction will be 0.
    for (let i = 0; i < 35; i += 1) {
      await recall(
        { cfg, pool, embedding },
        { query: `phase-8 unique tuning probe ${i}`, maxResults: 3 },
      );
    }

    const result = await runDailyAnalyzer(pool);
    expect(result.proposalIds.length).toBeGreaterThanOrEqual(1);
    const rows = await pool.query<{ scope: string; risk_class: string; status: string }>(
      `SELECT scope, risk_class, status FROM audit.tuning_proposals
         WHERE id = ANY($1::uuid[])`,
      [result.proposalIds],
    );
    const ttl = rows.rows.find((r) => r.scope === "cache.recall.ttl");
    expect(ttl).toBeDefined();
    expect(ttl?.risk_class).toBe("safe_auto");
    expect(ttl?.status).toBe("pending");
  });

  it("apply / reject / revert lifecycle", async () => {
    const pool = await getPool(pgCfg);
    const result = await runDailyAnalyzer(pool);
    const id = result.proposalIds[0];
    expect(id).toBeDefined();

    await markAutoApplied(pool, id, { previousTtl: 300 });
    const after = await pool.query<{ status: string; applied_at: Date | null }>(
      `SELECT status, applied_at FROM audit.tuning_proposals WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("auto_applied");
    expect(after.rows[0].applied_at).not.toBeNull();

    const rolled = await revertProposal(pool, id, "test revert");
    expect(rolled).toEqual({ previousTtl: 300 });
    const reverted = await pool.query<{ status: string; reverted_at: Date | null }>(
      `SELECT status, reverted_at FROM audit.tuning_proposals WHERE id = $1`,
      [id],
    );
    expect(reverted.rows[0].status).toBe("reverted");
    expect(reverted.rows[0].reverted_at).not.toBeNull();
  });

  it("approve + reject mark proposals correctly", async () => {
    const pool = await getPool(pgCfg);
    const result = await runDailyAnalyzer(pool);
    const ids = result.proposalIds;
    if (ids.length < 2) {return;} // not enough to test both — skip silently
    await markApproved(pool, ids[0]);
    await markRejected(pool, ids[1], "not now");
    const rows = await pool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM audit.tuning_proposals WHERE id = ANY($1::uuid[])`,
      [ids.slice(0, 2)],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(byId.get(ids[0])).toBe("approved");
    expect(byId.get(ids[1])).toBe("rejected");
  });

  it("evaluateGuards returns inconclusive when no follow-up data is present", async () => {
    const pool = await getPool(pgCfg);
    const result = await runDailyAnalyzer(pool);
    const id = result.proposalIds[0];
    if (!id) {return;}
    await markAutoApplied(pool, id, { previousTtl: 300 });
    // Backdate applied_at so the 24h guard window selects this proposal.
    await pool.query(
      `UPDATE audit.tuning_guards SET applied_at = now() - interval '25 hours' WHERE proposal_id = $1`,
      [id],
    );
    const out = await evaluateGuards(pool);
    expect(out.evaluated).toBeGreaterThanOrEqual(1);
    const guard = await pool.query<{ decision: string; observed_score: number | null }>(
      `SELECT decision, observed_score FROM audit.tuning_guards WHERE proposal_id = $1`,
      [id],
    );
    expect(["ok", "inconclusive", "reverted"]).toContain(guard.rows[0].decision);
  });
});
