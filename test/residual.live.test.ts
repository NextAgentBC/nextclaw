/**
 * Confidence-gated LLM residual (P2#6) — Stage 4 deep extraction fires when the
 * deterministic extractors are weak by COMBINED CONFIDENCE (not just empty),
 * bounded by a per-chunk char cap and a daily token budget.
 *
 * NOTE: inert in production until a residual model is bound to deps.llmResidual;
 * this exercises the gate with a mock.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { resolveConfig } from "../src/config.js";
import { EmbeddingClient, type EmbedRequest, type EmbedResult } from "../src/embedding/client.js";
import { getPool, closeAllPools } from "../src/storage/pool.js";
import { migrate } from "../src/storage/migrate.js";
import { ingestOne, _residualInternal } from "../src/ingest/pipeline.js";
import type { ExtractorResult } from "../src/structured/types.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;

class StubEmbed extends EmbeddingClient {
  constructor() { super({ baseUrl: "http://stub", model: "stub-embed:16" }); }
  override async embed(req: EmbedRequest): Promise<EmbedResult> {
    return { embeddings: req.inputs.map(() => Array.from({ length: 16 }, (_, i) => (i + 1) / 16)), model: "stub-embed:16", dims: 16, latencyMs: 0 };
  }
  override async probe() { return { ok: true as const, dims: 16, latencyMs: 0 }; }
}
const residualResult = (): ExtractorResult =>
  ({ entities: [], events: [], preferences: [], metrics: [], relations: [], commitments: [], extractorVersion: "residual" });

describe("residual confidence gate (unit)", () => {
  it("combinedConfidence averages candidate confidences, 0 when empty", () => {
    const cc = _residualInternal.combinedConfidence;
    expect(cc({ entities: [{ confidence: 0.8 }], events: [], preferences: [], metrics: [], relations: [] } as unknown as ExtractorResult)).toBe(0.8);
    expect(cc({ entities: [], events: [], preferences: [], metrics: [], relations: [] } as unknown as ExtractorResult)).toBe(0);
  });
});

describeLive("residual gating (live PG)", () => {
  const cfg = resolveConfig({ postgres: { url: PG_URL ?? "postgres://x" }, embedding: { provider: "stub", model: "stub-embed:16" } });
  const emb = new StubEmbed();
  const weakText = "The afternoon discussion wandered across several unrelated subjects without reaching any firm conclusion.";

  beforeAll(async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    await pool.query(`DROP SCHEMA IF EXISTS semantic CASCADE; DROP SCHEMA IF EXISTS structured CASCADE;
      DROP SCHEMA IF EXISTS cache CASCADE; DROP SCHEMA IF EXISTS cold CASCADE; DROP SCHEMA IF EXISTS audit CASCADE;`);
    await migrate(pool);
  }, 60_000);

  afterAll(async () => { await closeAllPools(); });

  it("fires the residual on a low-confidence chunk", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    let calls = 0;
    const out = await ingestOne(
      { cfg, pool, embedding: emb, llmResidual: async () => { calls += 1; return { result: residualResult(), tokensUsed: 120 }; } },
      { text: weakText, source: "manual", now: new Date("2026-06-12T09:00:00Z") });
    expect(out.decision).toBe("accepted");
    expect(calls).toBe(1);
    expect(out.ingestPath).toBe("llm_residual");
  });

  it("skips the residual when the daily token budget is exceeded", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    await pool.query(
      `INSERT INTO audit.ingest_decisions (id, ts, source, decision, routes, ingest_path, llm_tokens_used, agent_id, scored_at)
       VALUES (gen_random_uuid(), now(), 'test', 'accepted', '{}'::text[], 'llm_residual', 60000, 'main', now())`);
    let calls = 0;
    const out = await ingestOne(
      { cfg, pool, embedding: emb, llmResidual: async () => { calls += 1; return { result: residualResult(), tokensUsed: 120 }; } },
      { text: weakText + " A slightly different wording to dodge dedup entirely here.", source: "manual", now: new Date("2026-06-12T09:01:00Z") });
    expect(calls).toBe(0);
    expect(out.ingestPath).not.toBe("llm_residual");
  });
});
