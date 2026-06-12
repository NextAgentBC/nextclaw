/**
 * Golden retrieval regression harness (P0#1).
 *
 * The self-tuning loop and every recall change need a correctness anchor:
 * "did we surface the RIGHT chunk?", not just "was it cheap?". This harness
 * seeds a fixed corpus into a throwaway Postgres, runs a labelled set of
 * (query → expected chunk) cases across the recall routes, and reports
 * recall@5 / MRR / tier distribution / p50-p95 latency. A committed
 * baseline.json turns it into a CI gate: a >2% recall@5 drop fails the run.
 *
 * Hermetic by design — a deterministic 16-dim stub embedder, no ollama, no
 * network. It exercises the deterministic routes (anchor / trgm / time_bucket /
 * concept_tag / entity_ref / fulltext) faithfully; true semantic-quality runs
 * against the real embedder are a later mode (--real-embed, not yet wired).
 *
 * Usage (one-time):  docker exec nextclaw-pg createdb -U nextclaw nextclaw_golden
 *   node test/golden/run-golden.mjs [--update-baseline]
 *
 * WARNING: drops + recreates the semantic/structured/cache/cold/audit schemas
 * in the target DB. It MUST be a dedicated golden DB, never the gateway's live
 * memory store. Two guards enforce this (see assertSafeTarget + the real-data
 * check): the run aborts if the target matches any Postgres url in
 * openclaw.json, or if the target already holds non-stub chunks.
 */

import { resolveConfig } from "../../dist/src/config.js";
import { EmbeddingClient } from "../../dist/src/embedding/client.js";
import { ingestOne } from "../../dist/src/ingest/pipeline.js";
import { recall } from "../../dist/src/recall/router.js";
import { migrate, ensureHnswIndex, recordEmbeddingDims } from "../../dist/src/storage/migrate.js";
import { getPool, closeAllPools } from "../../dist/src/storage/pool.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(HERE, "baseline.json");
const LASTRUN_PATH = path.join(HERE, "last-run.json");

const OPENCLAW_JSON = process.env["OPENCLAW_CONFIG"] ?? "/home/ubuntu/.openclaw/openclaw.json";
const PG_URL =
  process.env["OPENCLAW_MEMORY_PG_URL"] ??
  // Dedicated golden DB — NEVER the gateway's live store (…/nextclaw).
  "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw_golden";
const UPDATE_BASELINE = process.argv.includes("--update-baseline");

/** "host:port/db" identity of a connection url, ignoring credentials. */
function dbIdentity(url) {
  const m = String(url).match(/@([^/]+)\/([^?\s"']+)/);
  return m ? `${m[1]}/${m[2]}` : String(url);
}

/**
 * Guard 1: refuse to run if the target is a DB the live gateway uses. This
 * harness DROPs schemas — pointing it at the gateway's memory store would
 * destroy real memory (it once did). We compare the target against every
 * postgres url referenced in openclaw.json.
 */
function assertSafeTarget(targetUrl) {
  const target = dbIdentity(targetUrl);
  let cfgText = "";
  try {
    cfgText = readFileSync(OPENCLAW_JSON, "utf8");
  } catch {
    return; // no config readable → can't cross-check; data-level guard still applies
  }
  for (const u of cfgText.match(/postgres:\/\/[^"\s]+/g) ?? []) {
    if (dbIdentity(u) === target) {
      throw new Error(
        `REFUSING TO RUN: target ${target} is referenced in ${OPENCLAW_JSON} ` +
          `(the live gateway memory store). Use a dedicated golden DB.`,
      );
    }
  }
}
const RECALL_DROP_GATE = 0.02; // fail if recall@5 falls >2% below baseline
const TOP_K = 5;

/** Deterministic 16-dim embedder: char-frequency vector, L2-normalised. */
class StubEmbeddingClient extends EmbeddingClient {
  constructor() {
    super({ baseUrl: "http://stub", model: "stub-embed:16" });
  }
  async embed(req) {
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
  async probe() {
    return { ok: true, dims: 16, latencyMs: 0 };
  }
}

const DAY_A = new Date("2026-05-02T08:00:00Z"); // default ingest day → time_bucket 2026-05-02
const DAY_B = new Date("2026-05-01T18:00:00Z"); // the one "yesterday" chunk → 2026-05-01

/**
 * Seed corpus. Each entry has a stable `key`; the actual chunk UUID is captured
 * from ingestOne's return value so golden cases can reference chunks by key.
 * Texts are deliberately distinctive so each route has an unambiguous target.
 */
const SEED = [
  {
    key: "anchor",
    input: {
      text: "Deploy notes: finished the staging rollout and smoke-tested the new release.",
      source: "session",
      anchors: { cwd: "/srv/staging-app", branch: "release" },
      now: DAY_A,
    },
  },
  {
    key: "pr",
    input: {
      text: "Reviewed and merged the fix for the cache stampede under concurrent recall.",
      source: "session",
      anchors: { pr: "4821" },
      now: DAY_A,
    },
  },
  {
    key: "trgm",
    input: {
      text: "We standardized on pgvector for embedding storage with HNSW indexing.",
      source: "manual",
      now: DAY_A,
    },
  },
  {
    key: "time",
    input: {
      text: "Daily standup: shipped the authentication refactor and closed three tickets.",
      source: "session",
      now: DAY_B,
    },
  },
  {
    key: "semantic",
    input: {
      text: "The lake run this morning was 5 kilometers along the north trail.",
      source: "session",
      now: DAY_A,
    },
  },
  {
    key: "concept",
    input: {
      text: "We added rate-limiting to the public API gateway during last sprint.",
      source: "manual",
      now: DAY_A,
    },
  },
  {
    key: "entity",
    input: {
      text: "Met with @lin to plan the Aurora project roadmap for next quarter.",
      source: "session",
      now: DAY_A,
    },
  },
  // Distractors so top-5 is not trivially the whole corpus.
  {
    key: "distract1",
    input: { text: "Bought groceries and refilled the coffee beans on the way home.", source: "session", now: DAY_A },
  },
  {
    key: "distract2",
    input: { text: "The quarterly budget spreadsheet needs another review column.", source: "manual", now: DAY_A },
  },
];

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

async function bootstrap(pool) {
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
}

async function seedCorpus(cfg, pool, embedding) {
  const ids = {};
  for (const { key, input } of SEED) {
    const out = await ingestOne({ cfg, pool, embedding }, input);
    if (!out.chunkId) {
      throw new Error(`seed '${key}' did not produce a chunkId (decision=${out.decision})`);
    }
    ids[key] = out.chunkId;
  }
  return ids;
}

/** Read the actual index value the deterministic extractor wrote for a chunk. */
async function indexValue(pool, chunkId, kind) {
  const r = await pool.query(
    "SELECT value FROM semantic.chunk_indexes WHERE chunk_id = $1 AND kind = $2 ORDER BY value LIMIT 1",
    [chunkId, kind],
  );
  return r.rows[0]?.value ?? null;
}

async function buildGoldenCases(pool, ids) {
  // entity_ref + concept_tag values are resolved from what actually landed in
  // chunk_indexes, so the harness never guesses the extractor's exact output.
  const entityVal = await indexValue(pool, ids.entity, "entity_ref");
  const conceptVal = await indexValue(pool, ids.concept, "concept_tag");

  const cases = [
    {
      id: "anchor:cwd",
      route: "anchor",
      input: { query: "where did the staging deploy land", anchors: { cwd: "/srv/staging-app" }, maxResults: TOP_K },
      expect: ids.anchor,
    },
    {
      id: "anchor:pr",
      route: "anchor",
      input: { query: "that PR about the cache stampede", anchors: { pr: "4821" }, maxResults: TOP_K },
      expect: ids.pr,
    },
    {
      id: "trgm:typo",
      route: "trgm",
      input: { query: "pgvecter hnsw indexing", maxResults: TOP_K }, // misspelled on purpose
      expect: ids.trgm,
    },
    {
      id: "time_bucket",
      route: "time_bucket",
      input: { query: "what shipped that day", timeBucket: "2026-05-01", maxResults: TOP_K },
      expect: ids.time,
    },
    {
      id: "semantic:lexical",
      route: "semantic",
      input: { query: "morning lake run kilometers north trail", maxResults: TOP_K },
      expect: ids.semantic,
    },
  ];

  if (conceptVal) {
    cases.push({
      id: "concept_tag",
      route: "concept_tag",
      input: { query: "api gateway throttling", conceptTags: [conceptVal], maxResults: TOP_K },
      expect: ids.concept,
    });
  } else {
    console.warn("  ⚠ concept_tag case skipped — no concept_tag index on the seed chunk");
  }

  if (entityVal) {
    cases.push({
      id: "entity_ref",
      route: "entity_ref",
      input: { query: "what about Lin and Aurora", entityIds: [entityVal], maxResults: TOP_K },
      expect: ids.entity,
    });
  } else {
    console.warn("  ⚠ entity_ref case skipped — no entity_ref index on the seed chunk");
  }

  // graph_walk (2-hop) needs a relation-edge fixture between two entities;
  // deferred to a v2 golden subset. Logged, not silently dropped.
  console.warn("  ⚠ graph_walk route not yet covered (needs a relation fixture) — TODO v2");

  return cases;
}

async function runCases(cfg, pool, embedding, cases) {
  const perCase = [];
  const latencies = [];
  const tierCounts = {};
  const routesSeen = new Set();

  for (const c of cases) {
    const t0 = Date.now();
    const r = await recall({ cfg, pool, embedding }, c.input);
    const ms = Date.now() - t0;
    latencies.push(ms);
    tierCounts[r.hitTier] = (tierCounts[r.hitTier] ?? 0) + 1;
    for (const rt of r.routesRun ?? []) routesSeen.add(rt);

    const idsTop = (r.results ?? []).slice(0, TOP_K).map((x) => x.chunkId);
    const rank = idsTop.indexOf(c.expect); // 0-based; -1 = miss
    const hit = rank >= 0;
    perCase.push({
      id: c.id,
      route: c.route,
      hit,
      rank: hit ? rank + 1 : null,
      rr: hit ? 1 / (rank + 1) : 0,
      hitTier: r.hitTier,
      routesRun: r.routesRun,
      returned: (r.results ?? []).length,
      latencyMs: ms,
    });
  }

  const n = perCase.length;
  const recallAt5 = n ? perCase.filter((c) => c.hit).length / n : 0;
  const mrr = n ? perCase.reduce((a, c) => a + c.rr, 0) / n : 0;
  const sortedLat = [...latencies].sort((a, b) => a - b);

  return {
    metrics: {
      cases: n,
      recallAt5: Number(recallAt5.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      p50ms: pct(sortedLat, 0.5),
      p95ms: pct(sortedLat, 0.95),
      tierDistribution: tierCounts,
      routesExercised: [...routesSeen].sort(),
    },
    perCase,
  };
}

function report(result) {
  const m = result.metrics;
  console.log("\n=== Golden retrieval report ===");
  console.log(`  cases:     ${m.cases}`);
  console.log(`  recall@5:  ${m.recallAt5}`);
  console.log(`  MRR:       ${m.mrr}`);
  console.log(`  latency:   p50=${m.p50ms}ms  p95=${m.p95ms}ms`);
  console.log(`  tiers:     ${JSON.stringify(m.tierDistribution)}`);
  console.log(`  routes:    ${m.routesExercised.join(", ")}`);
  console.log("  per-case:");
  for (const c of result.perCase) {
    const mark = c.hit ? "✓" : "✗";
    console.log(
      `    ${mark} ${c.id.padEnd(18)} route=${String(c.route).padEnd(12)} ` +
        `rank=${c.rank ?? "-"} tier=${c.hitTier} ${c.latencyMs}ms`,
    );
  }
}

function gate(result) {
  writeFileSync(LASTRUN_PATH, JSON.stringify(result, null, 2));

  if (UPDATE_BASELINE || !existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ metrics: result.metrics }, null, 2));
    console.log(`\n  baseline ${UPDATE_BASELINE ? "updated" : "written"} → ${path.relative(process.cwd(), BASELINE_PATH)}`);
    return 0;
  }

  const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).metrics;
  const drop = base.recallAt5 - result.metrics.recallAt5;
  console.log(`\n  baseline recall@5=${base.recallAt5}  current=${result.metrics.recallAt5}  Δ=${(-drop).toFixed(4)}`);
  if (drop > RECALL_DROP_GATE) {
    console.error(`  ✗ REGRESSION: recall@5 dropped ${drop.toFixed(4)} (> ${RECALL_DROP_GATE} gate)`);
    return 1;
  }
  console.log("  ✓ within gate");
  return 0;
}

async function main() {
  assertSafeTarget(PG_URL); // guard 1 — never the gateway's live memory DB
  console.log(`Golden harness → ${PG_URL}`);
  console.log("(resets semantic/structured/cache/cold/audit schemas in that DB)");
  const cfg = resolveConfig({
    postgres: { url: PG_URL },
    embedding: { provider: "stub", model: "stub-embed:16" },
  });
  const pool = await getPool({ url: cfg.postgres.url, poolMax: 4, statementTimeoutMs: 15_000 });
  const embedding = new StubEmbeddingClient();

  // Guard 2 — never DROP a DB that already holds real (non-stub) memory.
  const real = await pool
    .query("SELECT count(*)::int AS n FROM semantic.chunks WHERE embedding_model IS DISTINCT FROM 'stub-embed:16'")
    .catch(() => ({ rows: [{ n: 0 }] })); // table absent on a fresh golden DB → fine
  if (real.rows[0].n > 0) {
    throw new Error(
      `REFUSING TO RUN: target holds ${real.rows[0].n} non-stub chunks — real memory, not a golden fixture.`,
    );
  }

  await bootstrap(pool);
  const ids = await seedCorpus(cfg, pool, embedding);
  console.log(`  seeded ${Object.keys(ids).length} chunks`);
  const cases = await buildGoldenCases(pool, ids);
  const result = await runCases(cfg, pool, embedding, cases);
  report(result);
  const code = gate(result);

  await closeAllPools();
  process.exit(code);
}

main().catch(async (err) => {
  console.error("golden harness failed:", err);
  await closeAllPools().catch(() => {});
  process.exit(2);
});
