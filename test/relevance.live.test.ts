/**
 * Recall relevance loop (P0#2) — audit.recall_decisions.relevance_estimate is
 * filled from a real downstream signal (a citation follow-up) instead of a
 * hardcoded guess. recall records returned_chunk_ids; a later memory_get on a
 * recalled chunk credits the recall that surfaced it.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveConfig } from "../src/config.js";
import { EmbeddingClient, type EmbedRequest, type EmbedResult } from "../src/embedding/client.js";
import { getPool, closeAllPools } from "../src/storage/pool.js";
import { migrate } from "../src/storage/migrate.js";
import { recall } from "../src/recall/router.js";
import { recordCitationFollowup } from "../src/recall/relevance.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;

class StubEmbed extends EmbeddingClient {
  constructor() { super({ baseUrl: "http://stub", model: "stub-embed:16" }); }
  override async embed(req: EmbedRequest): Promise<EmbedResult> {
    const embeddings = req.inputs.map((s) => {
      const v = Array.from({ length: 16 }, () => 0);
      for (let i = 0; i < s.length; i += 1) { v[i % 16] += s.charCodeAt(i) / 1024; }
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
    return { embeddings, model: "stub-embed:16", dims: 16, latencyMs: 0 };
  }
  override async probe() { return { ok: true as const, dims: 16, latencyMs: 0 }; }
}

describeLive("recall relevance loop (live PG)", () => {
  const cfg = resolveConfig({ postgres: { url: PG_URL ?? "postgres://x" }, embedding: { provider: "stub", model: "stub-embed:16" } });
  const emb = new StubEmbed();

  beforeAll(async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    await pool.query(`DROP SCHEMA IF EXISTS semantic CASCADE; DROP SCHEMA IF EXISTS structured CASCADE;
      DROP SCHEMA IF EXISTS cache CASCADE; DROP SCHEMA IF EXISTS cold CASCADE; DROP SCHEMA IF EXISTS audit CASCADE;`);
    await migrate(pool);
  }, 60_000);

  afterAll(async () => { await closeAllPools(); });

  it("records returned_chunk_ids and fills relevance_estimate on a citation follow-up", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    const text = "unique relevance marker token alpha";
    const [e] = (await emb.embed({ inputs: [text] })).embeddings;
    const X = randomUUID();
    await pool.query(
      `INSERT INTO semantic.chunks (id,source,kind,text,text_hash,embedding,embedding_model,agent_id,retention_class,importance)
       VALUES ($1,'manual','fact',$2,$3,$4::vector,'stub-embed:16','main','standard',0.5)`,
      [X, text, "hash_" + X, "[" + e.join(",") + "]"]);

    const r = await recall({ cfg, pool, embedding: emb }, { query: text, maxResults: 5, agentId: "main" });
    expect(r.results.some((c) => c.chunkId === X)).toBe(true);

    const rd = (await pool.query<{ id: string; relevance_estimate: number | null; returned_chunk_ids: string[] | null }>(
      `SELECT id, relevance_estimate, returned_chunk_ids FROM audit.recall_decisions ORDER BY ts DESC LIMIT 1`)).rows[0];
    expect(rd.relevance_estimate).toBeNull();
    expect(rd.returned_chunk_ids ?? []).toContain(X);

    await recordCitationFollowup(pool, "main", X, 3_600_000);

    const after = (await pool.query<{ relevance_estimate: number | null }>(
      `SELECT relevance_estimate FROM audit.recall_decisions WHERE id=$1`, [rd.id])).rows[0];
    expect(Number(after.relevance_estimate)).toBe(1.0);
  });
});
