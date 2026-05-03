/**
 * Phase 6 live e2e: cold compactor groups stale chunks into cold.gists and
 * demotes the originals while keeping audit / drill-down working.
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
import { compactCold, findGistsContainingChunk } from "../src/workers/compactor.js";

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

const longAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 200);

describeLive("memory-postgres compactor (live PG)", () => {
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

    // Seed: 4 stale chunks all sharing concept_tag 'cooking'. We backdate
    // last_recalled_at so the compactor sees them as eligible.
    const embedding = new StubEmbeddingClient();
    const seedTexts = [
      "Cooking pasta with garlic and olive oil tonight",
      "Roasted vegetables with thyme make a great dinner",
      "Cooking risotto requires constant stirring for creaminess",
      "Slow-roasted chicken with rosemary is a comfort meal",
    ];
    for (const text of seedTexts) {
      const r = await ingestOne({ cfg, pool, embedding }, { text, source: "manual" });
      if (r.chunkId) {
        // Force shared concept_tag + age out the chunk.
        await pool.query(
          `INSERT INTO semantic.chunk_indexes (chunk_id, kind, value)
             VALUES ($1, 'concept_tag', 'cooking') ON CONFLICT DO NOTHING`,
          [r.chunkId],
        );
        await pool.query(
          "UPDATE semantic.chunks SET created_at = $1, last_recalled_at = NULL WHERE id = $2",
          [longAgo, r.chunkId],
        );
      }
    }
  }, 60_000);

  afterAll(async () => {
    await closeAllPools();
  });

  it("emits a gist for the cooking cluster and demotes the originals", async () => {
    const pool = await getPool(pgCfg);
    const embedding = new StubEmbeddingClient();
    const outcome = await compactCold(pool, embedding, {
      minAgeDays: 90,
      minClusterSize: 2,
      maxClusters: 5,
    });
    expect(outcome.clustersFound).toBeGreaterThanOrEqual(1);
    expect(outcome.gistsWritten).toBeGreaterThanOrEqual(1);
    expect(outcome.chunksDemoted).toBeGreaterThanOrEqual(2);

    const gistRow = await pool.query<{ topic: string; n: string; summary_text: string }>(
      `SELECT topic, jsonb_array_length(to_jsonb(source_chunk_ids))::text AS n,
              summary_text
         FROM cold.gists
         WHERE topic = 'cooking'
         ORDER BY created_at DESC LIMIT 1`,
    );
    expect(gistRow.rowCount).toBe(1);
    expect(Number(gistRow.rows[0].n)).toBeGreaterThanOrEqual(2);
    expect(gistRow.rows[0].summary_text).toMatch(/cooking|Cooking|Roasted|Slow/);
  });

  it("findGistsContainingChunk drills back to source chunks from a gist", async () => {
    const pool = await getPool(pgCfg);
    const anyChunk = await pool.query<{ id: string }>(
      `WITH g AS (SELECT source_chunk_ids FROM cold.gists ORDER BY created_at DESC LIMIT 1)
       SELECT c.id FROM semantic.chunks c, g
         WHERE c.id = ANY(g.source_chunk_ids)
         LIMIT 1`,
    );
    expect(anyChunk.rowCount).toBeGreaterThanOrEqual(1);
    const gists = await findGistsContainingChunk(pool, anyChunk.rows[0].id);
    expect(gists.length).toBeGreaterThanOrEqual(1);
    expect(gists[0].sourceChunkIds).toContain(anyChunk.rows[0].id);
  });
});
