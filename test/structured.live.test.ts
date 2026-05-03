/**
 * Phase 2 live e2e: end-to-end extractor → reconcile → StructuredMemoryAPI
 * against real Postgres + pgvector.
 *
 * Skipped silently when OPENCLAW_MEMORY_PG_URL is unset.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  EmbeddingClient,
  type EmbedRequest,
  type EmbedResult,
} from "../src/embedding/client.js";
import { writeChunk } from "../src/manager.js";
import { migrate, ensureHnswIndex, recordEmbeddingDims } from "../src/storage/migrate.js";
import { closeAllPools, getPool } from "../src/storage/pool.js";
import { extractAll } from "../src/structured/extractors.js";
import { reconcile } from "../src/structured/reconcile.js";
import { StructuredMemoryAPI } from "../src/structured/api.js";

const PG_URL = process.env["OPENCLAW_MEMORY_PG_URL"];
const describeLive = PG_URL ? describe : describe.skip;

class StubEmbeddingClient extends EmbeddingClient {
  constructor() {
    super({ baseUrl: "http://stub", model: "stub-embed:16" });
  }
  override async embed(req: EmbedRequest): Promise<EmbedResult> {
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

describeLive("memory-postgres structured layer (live PG)", () => {
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

  it("end-to-end: extract → reconcile writes entities, events, metrics with provenance", async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
    const embedding = new StubEmbeddingClient();

    const text = "今天和 @shadow 在 openclaw/openclaw 改了 PR #1234，午饭吃了 1800 卡";
    const w = await writeChunk(pool, embedding, {
      text,
      source: "session",
      sourceRef: "session-x",
      kind: "fact",
      agentSessionId: "session-x",
    });

    const result = extractAll({ text, source: "session", now: fixedNow });
    const outcome = await reconcile(pool, {
      chunkId: w.id,
      rawExcerpt: text,
      result,
    });

    // Should have created at least: shadow (person), openclaw/openclaw (repo),
    // user (person, via relation), and a meal event + pr_change event + calories metric.
    expect(outcome.entityIds.length).toBeGreaterThanOrEqual(2);
    expect(outcome.eventIds.length).toBeGreaterThanOrEqual(2);
    expect(outcome.metricIds.length).toBe(1);
    expect(outcome.relationIds.length).toBeGreaterThanOrEqual(1);

    // Provenance row count = sum of new structured rows.
    const totalNew =
      outcome.entityIds.length +
      outcome.relationIds.length +
      outcome.eventIds.length +
      outcome.preferenceIds.length +
      outcome.metricIds.length;
    const provCount = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM structured.provenance WHERE chunk_id = $1",
      [w.id],
    );
    expect(Number(provCount.rows[0].n)).toBe(totalNew);

    // API: shadow lookup hits.
    const api = new StructuredMemoryAPI(pool);
    const shadow = await api.findEntities({ name: "shadow", type: "person", limit: 5 });
    expect(shadow.length).toBeGreaterThanOrEqual(1);
    expect(shadow[0].canonicalName).toBe("shadow");

    // API: calorie aggregate over the day.
    const calories = await api.aggregateMetric({
      metric: "calories",
      since: new Date("2026-05-02T00:00:00Z"),
      until: new Date("2026-05-03T00:00:00Z"),
    });
    expect(calories?.total).toBe(1800);
    expect(calories?.count).toBe(1);
    expect(calories?.unit).toBe("kcal");

    // API: events around target day.
    const events = await api.listEvents({
      since: new Date("2026-05-02T00:00:00Z"),
      until: new Date("2026-05-03T00:00:00Z"),
      limit: 10,
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("pr_change");
    expect(types).toContain("meal");
  });

  it("preference supersede: differing values invalidate the prior", async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
    const embedding = new StubEmbeddingClient();

    // Two writes with conflicting "remember" preferences. Same scope+key → supersede.
    const w1 = await writeChunk(pool, embedding, {
      text: "记住 以后 PR 都要先跑 pnpm test",
      source: "manual",
      kind: "fact",
    });
    await reconcile(pool, {
      chunkId: w1.id,
      rawExcerpt: "记住 以后 PR 都要先跑 pnpm test",
      result: extractAll({
        text: "记住 以后 PR 都要先跑 pnpm test",
        source: "manual",
        now: fixedNow,
      }),
    });

    const w2 = await writeChunk(pool, embedding, {
      text: "记住 以后 PR 都要先 build",
      source: "manual",
      kind: "fact",
    });
    await reconcile(pool, {
      chunkId: w2.id,
      rawExcerpt: "记住 以后 PR 都要先 build",
      result: extractAll({
        text: "记住 以后 PR 都要先 build",
        source: "manual",
        now: fixedNow,
      }),
    });

    const api = new StructuredMemoryAPI(pool);
    const active = await api.getPreference("global", "user_rule");
    expect(active).not.toBeNull();
    expect((active!.value as { text: string }).text).toContain("build");
    expect(active!.supersedes).toBeDefined();
  });

  it("entity dedup: same canonical_name across writes merges aliases", async () => {
    const pool = await getPool({
      url: cfg.postgres.url,
      poolMax: 4,
      statementTimeoutMs: 10_000,
    });
    const embedding = new StubEmbeddingClient();

    const w1 = await writeChunk(pool, embedding, {
      text: "see @SHADOW for details",
      source: "session",
      kind: "fact",
    });
    await reconcile(pool, {
      chunkId: w1.id,
      rawExcerpt: "see @SHADOW for details",
      result: extractAll({ text: "see @SHADOW for details", source: "session", now: fixedNow }),
    });
    const w2 = await writeChunk(pool, embedding, {
      text: "ping @Shadow about review",
      source: "session",
      kind: "fact",
    });
    const out2 = await reconcile(pool, {
      chunkId: w2.id,
      rawExcerpt: "ping @Shadow about review",
      result: extractAll({ text: "ping @Shadow about review", source: "session", now: fixedNow }),
    });
    // Second pass should dedup the entity.
    expect(out2.dedupCount).toBeGreaterThanOrEqual(1);

    const api = new StructuredMemoryAPI(pool);
    const found = await api.findEntities({ name: "shadow", type: "person", limit: 5 });
    const shadow = found.find((e) => e.canonicalName === "shadow");
    expect(shadow).toBeDefined();
    // Aliases should include both casings observed.
    expect(shadow!.aliases.length).toBeGreaterThanOrEqual(2);
  });
});
