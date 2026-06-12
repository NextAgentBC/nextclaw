/**
 * Supersede down-weight (P1#3) — when a later chunk asserts a fact that
 * contradicts an earlier one (a preference value change), the earlier chunk is
 * marked `superseded_by` and recall down-weights it so the current truth wins,
 * while the old chunk stays recallable for audit.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveConfig } from "../src/config.js";
import { EmbeddingClient, type EmbedRequest, type EmbedResult } from "../src/embedding/client.js";
import { getPool, closeAllPools } from "../src/storage/pool.js";
import { migrate } from "../src/storage/migrate.js";
import { reconcile } from "../src/structured/reconcile.js";
import { recall } from "../src/recall/router.js";
import type { ExtractorResult } from "../src/structured/types.js";

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

const ER = (prefs: ExtractorResult["preferences"]): ExtractorResult =>
  ({ entities: [], events: [], preferences: prefs, metrics: [], relations: [], commitments: [], extractorVersion: "test-1" });

describeLive("supersede down-weight (live PG)", () => {
  const cfg = resolveConfig({ postgres: { url: PG_URL ?? "postgres://x" }, embedding: { provider: "stub", model: "stub-embed:16" } });
  const emb = new StubEmbed();

  beforeAll(async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    await pool.query(`DROP SCHEMA IF EXISTS semantic CASCADE; DROP SCHEMA IF EXISTS structured CASCADE;
      DROP SCHEMA IF EXISTS cache CASCADE; DROP SCHEMA IF EXISTS cold CASCADE; DROP SCHEMA IF EXISTS audit CASCADE;`);
    await migrate(pool);
  }, 60_000);

  afterAll(async () => { await closeAllPools(); });

  it("marks the old chunk superseded and ranks the current fact above it", async () => {
    const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 20_000 });
    const textA = "favorite database extension is pgvector specialmarker";
    const textB = "favorite database extension is pgtrgm specialmarker";
    const [eA] = (await emb.embed({ inputs: [textA] })).embeddings;
    const [eB] = (await emb.embed({ inputs: [textB] })).embeddings;
    const A = randomUUID(), B = randomUUID();
    const ins = (id: string, text: string, vec: number[], hash: string) => pool.query(
      `INSERT INTO semantic.chunks (id,source,kind,text,text_hash,embedding,embedding_model,agent_id,retention_class,importance)
       VALUES ($1,'manual','fact',$2,$3,$4::vector,'stub-embed:16','main','standard',0.5)`,
      [id, text, hash, "[" + vec.join(",") + "]"]);
    await ins(A, textA, eA, "hA");
    await ins(B, textB, eB, "hB");

    await reconcile(pool, { chunkId: A, rawExcerpt: textA, result: ER([{ scope: "global", key: "fav_ext", value: "pgvector", confidence: 0.9 }]), agentId: "main" });
    const supBefore = (await pool.query<{ superseded_by: string | null }>(`SELECT superseded_by FROM semantic.chunks WHERE id=$1`, [A])).rows[0].superseded_by;
    expect(supBefore).toBeNull();

    await reconcile(pool, { chunkId: B, rawExcerpt: textB, result: ER([{ scope: "global", key: "fav_ext", value: "pgtrgm", confidence: 0.9 }]), agentId: "main" });
    const supAfter = (await pool.query<{ superseded_by: string | null }>(`SELECT superseded_by FROM semantic.chunks WHERE id=$1`, [A])).rows[0].superseded_by;
    expect(supAfter).toBe(B);

    const r = await recall({ cfg, pool, embedding: emb }, { query: "favorite database extension specialmarker", maxResults: 5 });
    const ids = r.results.map((c) => c.chunkId);
    const idxA = ids.indexOf(A), idxB = ids.indexOf(B);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA === -1 || idxB < idxA).toBe(true);
  });
});
