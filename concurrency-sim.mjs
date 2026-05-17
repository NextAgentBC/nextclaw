/**
 * Concurrency simulation for the Moderator cache pre-check + worker layer.
 *
 * Drives the cache + worker pipeline directly with parallel callers:
 *   A. Cache stampede     — 10x same Q, same scope (correctness under contention)
 *   B. Cross-scope        — 5 scopes × same Q (parallelism)
 *   C. Viewer isolation   — private-scoped row should not leak across users
 *   D. Mixed load         — random queries, some hits some misses
 *   E. Phase D round-trip — N parallel worker dispatches → cache write-back → all
 *                           subsequent same-Q precheck hits at L1 (proves the
 *                           closed loop works under concurrency without dupe rows)
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildEmbeddingClientFromConfig } from "./dist/src/embedding/client.js";
import { buildModeratorLlm } from "./dist/src/moderator/llm-client.js";
import { tryCachePrecheck, clearL0Cache, l0Stats } from "./dist/src/moderator/cache-precheck.js";
import { dispatchWorker, writeAnswerToCache, loadRoleSpec, upsertWorkerRole } from "./dist/src/moderator/workers.js";
import { buildWorkerLlmFromConfig } from "./dist/src/moderator/worker-llm.js";
import { storeCachedAnswer } from "./dist/src/cache/qa.js";

const PG_URL = "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw";
const AGENT = "main";
const SCOPE = "tg:chat:-1003789981008";

const pool = new pg.Pool({ connectionString: PG_URL });
const embedding = buildEmbeddingClientFromConfig({
  format: "openai",
  baseUrl: "http://100.79.97.110:8800/v1/proxy/local-embed",
  model: "qwen3-embedding:0.6b",
});
const deps = { pool, embedding, agentId: AGENT };

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}
function summary(label, latencies) {
  const sum = latencies.reduce((a, b) => a + b, 0);
  console.log(`  ${label}: n=${latencies.length}  p50=${pct(latencies, 0.5)}ms  p95=${pct(latencies, 0.95)}ms  max=${Math.max(...latencies)}ms  sum=${sum}ms`);
}

async function scenarioA_stampede() {
  console.log("\n=== A. Cache stampede — 10× '@Yao_zhua_bot 1/3 + 1/4 等于多少' same scope, parallel ===");
  clearL0Cache();
  const Q = "@Yao_zhua_bot 1/3 + 1/4 等于多少";
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      tryCachePrecheck(deps, { scopeKey: SCOPE, questionText: Q, viewer: { userId: `u${i}`, chatId: "-1003789981008" } }),
    ),
  );
  const wall = Date.now() - t0;
  const hits = results.filter((r) => r.hit);
  const byKind = hits.reduce((acc, r) => ((acc[r.hitKind] = (acc[r.hitKind] ?? 0) + 1), acc), {});
  console.log(`  wall=${wall}ms  hits=${hits.length}/10  by-kind=${JSON.stringify(byKind)}`);
  summary("latency", results.map((r) => r.latencyMs));
  const answers = new Set(hits.map((h) => h.answer));
  console.log(`  distinct answers seen: ${answers.size} (expect 1)`);
  console.log(`  L0 size after: ${l0Stats().size}`);
}

async function scenarioB_crossScope() {
  console.log("\n=== B. Cross-scope parallelism — 5 scopes × same Q, parallel ===");
  clearL0Cache();
  const Q = "退货政策是多少天";
  const scopes = Array.from({ length: 5 }, (_, i) => `tg:chat:-100${1000 + i}`);
  const t0 = Date.now();
  const results = await Promise.all(
    scopes.map((s, i) =>
      tryCachePrecheck(deps, { scopeKey: s, questionText: Q, viewer: { userId: `u${i}`, chatId: s.replace("tg:chat:", "") } }),
    ),
  );
  const wall = Date.now() - t0;
  const hits = results.filter((r) => r.hit);
  console.log(`  wall=${wall}ms  hits=${hits.length}/5  if truly parallel: wall ≈ max(latency)`);
  summary("latency", results.map((r) => r.latencyMs));
  // True parallelism check: wall should be close to max individual latency, not sum.
  const maxLat = Math.max(...results.map((r) => r.latencyMs));
  const sumLat = results.reduce((a, r) => a + r.latencyMs, 0);
  console.log(`  parallelism = sum/wall = ${(sumLat / wall).toFixed(2)}x  (5.0 = perfect parallel; 1.0 = serial)`);
}

async function scenarioC_viewerIsolation() {
  console.log("\n=== C. Viewer isolation — private TA row must not leak ===");
  clearL0Cache();
  const Q = `secret question for user A ${randomUUID().slice(0, 8)}`;
  const owner = "user-A-123";
  const stranger = "user-B-456";
  // Embed once for the seed.
  const er = await embedding.embed({ inputs: [Q], taskPrefix: "passage" });
  const id = await storeCachedAnswer(pool, {
    agentId: AGENT,
    questionText: Q,
    questionEmbedding: er.embeddings[0],
    embeddingModel: "qwen3-embedding:0.6b",
    answerText: "私密答案：只有 user-A 该看到",
    scope: { senderId: owner, visibility: "private" },
    source: "manual",
    ttlDays: 1,
  });
  console.log(`  seeded TA row id=${id} owner=${owner}`);

  const ownerRes = await tryCachePrecheck(deps, { scopeKey: SCOPE, questionText: Q, viewer: { userId: owner, chatId: "-1003789981008" } });
  const strangerRes = await tryCachePrecheck(deps, { scopeKey: SCOPE, questionText: Q, viewer: { userId: stranger, chatId: "-1003789981008" } });
  console.log(`  owner sees:    hit=${ownerRes.hit}${ownerRes.hit ? " kind=" + ownerRes.hitKind : ""}`);
  console.log(`  stranger sees: hit=${strangerRes.hit}${strangerRes.hit ? " kind=" + strangerRes.hitKind + " LEAK!" : " ← correct"}`);
  // Cleanup.
  await pool.query("DELETE FROM cache.qa WHERE id = $1", [id]);
}

async function scenarioD_mixed() {
  console.log("\n=== D. Mixed load — 20 concurrent across hit/miss mix ===");
  clearL0Cache();
  const queries = [
    "@Yao_zhua_bot 1/3 + 1/4 等于多少",   // L2 hit
    "退货政策是多少天?",                    // L1 exact hit
    "怎么算 1/3 + 1/4",                    // L1 exact hit
    "通分是什么意思?",                      // L1 exact hit
    "今天天气怎样",                         // miss
    "约分是什么?",                          // L1 exact hit
    "1/3 + 1/4 等于多少",                  // L2 hit
    "什么叫最大公约数?",                    // L1 exact hit
    "什么是机器学习",                       // miss
    "你好",                                 // too short (< 4 cleaned)
  ];
  const batch = [];
  for (let i = 0; i < 20; i++) {
    const q = queries[i % queries.length];
    batch.push(tryCachePrecheck(deps, { scopeKey: SCOPE, questionText: q, viewer: { userId: `u${i % 5}`, chatId: "-1003789981008" } }));
  }
  const t0 = Date.now();
  const results = await Promise.all(batch);
  const wall = Date.now() - t0;
  const hits = results.filter((r) => r.hit);
  const byKind = hits.reduce((acc, r) => ((acc[r.hitKind] = (acc[r.hitKind] ?? 0) + 1), acc), {});
  console.log(`  wall=${wall}ms  hits=${hits.length}/20  by-kind=${JSON.stringify(byKind)}`);
  summary("latency", results.map((r) => r.latencyMs));
  console.log(`  L0 size after: ${l0Stats().size}`);
}

async function scenarioE_workerRoundtrip() {
  console.log("\n=== E. Phase D round-trip — 5 parallel worker dispatches → write-back → cache ===");
  clearL0Cache();
  const workerLlm = buildWorkerLlmFromConfig({
    format: "gemini",
    baseUrl: "http://100.79.97.110:8800/v1/proxy/gemini",
    model: "gemini-2.5-flash",
  });
  const cfg = {
    pluginId: "memory-postgres",
    storage: { schema: "public", chunksTable: "chunks", chunkIndexesTable: "chunk_indexes" },
    embedding: { model: "qwen3-embedding:0.6b" },
  };
  const logger = { info: () => {}, warn: () => {} }; // quiet
  const wkDeps = { pool, workerLlm, embedding, cfg, agentId: AGENT, logger };

  // 5 *different* novel questions (UUID suffix), so each must call the LLM,
  // then write back. After write-back, a second precheck for each must hit.
  const uid = randomUUID().slice(0, 8);
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    taskId: `t_sim_${uid}_${i}`,
    roleKey: "default",
    taskPrompt: `用一句话回答：${i + 1} 加 ${i + 1} 等于多少？(${uid}-${i})`,
    memoryScope: { topic: "arith.concurrency-test" },
    canParallel: true,
  }));

  const t0 = Date.now();
  const results = await Promise.all(
    tasks.map((t) => dispatchWorker(wkDeps, t, { userId: "u-test", chatId: "-1003789981008" }, t.taskPrompt, SCOPE)),
  );
  const dispatchWall = Date.now() - t0;
  console.log(`  5 parallel dispatches: wall=${dispatchWall}ms, individual latencies=${results.map((r) => r.llm.latencyMs).join("/")}ms`);
  console.log(`  all answers ok? ${results.every((r) => r.ok)}`);

  // Write-back all (parallel).
  const wT0 = Date.now();
  const ids = await Promise.all(results.map((r, i) => writeAnswerToCache(wkDeps, r, tasks[i])));
  console.log(`  5 parallel writes: wall=${Date.now() - wT0}ms, ids=${ids.filter(Boolean).length}/5`);

  // Re-precheck each — every one should now hit L1-exact (cleaned questionText hashed).
  clearL0Cache();
  const recheckT0 = Date.now();
  const rechecks = await Promise.all(
    tasks.map((t) =>
      tryCachePrecheck(deps, { scopeKey: SCOPE, questionText: t.taskPrompt, viewer: { userId: "u-test", chatId: "-1003789981008" } }),
    ),
  );
  console.log(`  5 parallel rechecks: wall=${Date.now() - recheckT0}ms`);
  const hitCount = rechecks.filter((r) => r.hit).length;
  console.log(`  rechecks hit: ${hitCount}/5 ${hitCount === 5 ? "✓ closed loop" : "✗ round-trip broken"}`);

  // Cleanup.
  for (const id of ids) {
    if (id) {await pool.query("DELETE FROM cache.qa WHERE id = $1", [id]);}
  }
}

async function scenarioF_roleAutoRegister() {
  console.log("\n=== F. Role auto-register — Moderator-coined role persists across calls ===");
  const uid = randomUUID().slice(0, 6);
  const roleKey = `sim_specialist_${uid}`;
  const spec = {
    systemPrompt: `你是一个 [${uid}] 测试 specialist：用 8 个字以内回答任何问题，结尾加 [${uid}] 标签。`,
    displayName: `Sim Specialist ${uid}`,
    memoryScope: { topic: "sim.role-register" },
  };

  // 1. Initial state: role does not exist → loadRoleSpec returns DEFAULT_ROLE
  const before = await loadRoleSpec(pool, AGENT, roleKey);
  console.log(`  before insert: roleKey=${before.roleKey} displayName='${before.displayName}' isDefault=${before.systemPrompt === (await loadRoleSpec(pool, AGENT, "__nonexistent__")).systemPrompt}`);

  // 2. RACE: 5 parallel upsert attempts for the SAME brand-new key.
  //    ON CONFLICT DO NOTHING → exactly one should report `created=true`.
  const created = await Promise.all(
    Array.from({ length: 5 }, () => upsertWorkerRole(pool, AGENT, roleKey, spec, SCOPE)),
  );
  const successes = created.filter(Boolean).length;
  console.log(`  5 parallel upserts: created=${successes}/5 (expect exactly 1)`);

  // 3. Subsequent loadRoleSpec must return the Moderator-designed spec, NOT default.
  const after = await loadRoleSpec(pool, AGENT, roleKey);
  const usesNewSpec = after.systemPrompt === spec.systemPrompt;
  console.log(`  after upsert: roleKey=${after.roleKey} displayName='${after.displayName}'`);
  console.log(`  systemPrompt matches spec: ${usesNewSpec ? "✓" : "✗ — DEFAULT_ROLE was returned"}`);

  // 4. Second upsert with a DIFFERENT prompt under the same key → must be ignored (first-write-wins).
  const overwriteAttempted = await upsertWorkerRole(
    pool,
    AGENT,
    roleKey,
    { ...spec, systemPrompt: "覆盖测试 — 不该出现", displayName: "should not stick" },
    SCOPE,
  );
  const final = await loadRoleSpec(pool, AGENT, roleKey);
  console.log(`  second upsert returned created=${overwriteAttempted} (expect false)`);
  console.log(`  systemPrompt still original: ${final.systemPrompt === spec.systemPrompt ? "✓ first-write-wins" : "✗ overwritten"}`);

  // Cleanup.
  await pool.query("DELETE FROM moderator.worker_roles WHERE agent_id=$1 AND role_key=$2", [AGENT, roleKey]);
}

async function scenarioG_workerTools() {
  console.log("\n=== G. Worker tool calls — model invokes memory_search mid-answer ===");
  const workerLlm = buildWorkerLlmFromConfig({
    format: "gemini",
    baseUrl: "http://100.79.97.110:8800/v1/proxy/gemini",
    model: "gemini-2.5-flash",
  });
  const cfg = {
    pluginId: "memory-postgres",
    storage: { schema: "public", chunksTable: "chunks", chunkIndexesTable: "chunk_indexes" },
    embedding: { model: "qwen3-embedding:0.6b" },
  };
  const logger = { info: (m) => console.log("    log:", m), warn: () => {} };
  const wkDeps = { pool, workerLlm, embedding, cfg, agentId: AGENT, logger };

  // Register a role that has the memory_search tool.
  const uid = randomUUID().slice(0, 6);
  const roleKey = `sim_searcher_${uid}`;
  await upsertWorkerRole(
    pool,
    AGENT,
    roleKey,
    {
      systemPrompt:
        "你是一个助教，要回答用户问题前 **必须先调用 memory_search 工具** 查找历史记忆。" +
        "如果搜到相关内容，用它回答；如果没搜到，明说你查过没找到。回答简洁，不超过 3 句。",
      displayName: `Sim Searcher ${uid}`,
      tools: ["memory_search"],
    },
    SCOPE,
  );

  // A question that obviously benefits from memory_search.
  const task = {
    taskId: `t_searcher_${uid}`,
    roleKey,
    taskPrompt: "之前有人问过怎么算 1/3 + 1/4 吗？如果有，告诉我答案。",
    memoryScope: { topic: "math.fractions" },
    canParallel: true,
  };

  const result = await dispatchWorker(
    wkDeps,
    task,
    { userId: "u-sim", chatId: "-1003789981008" },
    task.taskPrompt,
    SCOPE,
  );

  console.log(`  ok: ${result.ok}`);
  console.log(`  tool calls made: ${result.toolCalls?.length ?? 0}${result.toolCalls ? " (" + result.toolCalls.map((c) => c.name).join(",") + ")" : ""}`);
  if (result.toolCalls?.length) {
    console.log(`  first call args: ${JSON.stringify(result.toolCalls[0].args)}`);
  }
  console.log(`  answer (first 180 chars): ${JSON.stringify(result.answer.slice(0, 180))}`);
  console.log(`  tokens=${result.llm.inputTokens}→${result.llm.outputTokens} latency=${result.llm.latencyMs}ms`);
  const usedTool = (result.toolCalls?.length ?? 0) > 0;
  console.log(`  → tool wiring works: ${usedTool ? "✓" : "✗ (model chose not to call — try a clearer prompt)"}`);

  // Cleanup the role.
  await pool.query("DELETE FROM moderator.worker_roles WHERE agent_id=$1 AND role_key=$2", [AGENT, roleKey]);
}

async function scenarioH_webSearch() {
  console.log("\n=== H. web_search tool — worker pulls live web data via Tavily ===");
  const workerLlm = buildWorkerLlmFromConfig({
    format: "gemini",
    baseUrl: "http://100.79.97.110:8800/v1/proxy/gemini",
    model: "gemini-2.5-flash",
  });
  const cfg = {
    pluginId: "memory-postgres",
    storage: { schema: "public", chunksTable: "chunks", chunkIndexesTable: "chunk_indexes" },
    embedding: { model: "qwen3-embedding:0.6b" },
  };
  const logger = { info: (m) => console.log("    log:", m), warn: () => {} };
  const wkDeps = { pool, workerLlm, embedding, cfg, agentId: AGENT, logger };

  const uid = randomUUID().slice(0, 6);
  const roleKey = `sim_websearcher_${uid}`;
  await upsertWorkerRole(
    pool,
    AGENT,
    roleKey,
    {
      systemPrompt:
        "你必须用 web_search 工具查找最新信息再回答。回答 2 段以内，必须包含至少一个具体 URL。",
      displayName: `Web Searcher ${uid}`,
      tools: ["web_search"],
    },
    SCOPE,
  );
  const task = {
    taskId: `t_web_${uid}`,
    roleKey,
    taskPrompt: "OpenClaw 的最新版本号是什么？给我一个来源链接。",
    canParallel: true,
  };
  const result = await dispatchWorker(
    wkDeps,
    task,
    { userId: "u-sim", chatId: "-1003789981008" },
    task.taskPrompt,
    SCOPE,
  );

  console.log(`  ok: ${result.ok}`);
  console.log(`  tool calls: ${result.toolCalls?.length ?? 0}${result.toolCalls ? " (" + result.toolCalls.map((c) => c.name).join(",") + ")" : ""}`);
  if (result.toolCalls?.length) {
    console.log(`  first call args: ${JSON.stringify(result.toolCalls[0].args)}`);
  }
  console.log(`  answer (first 220 chars): ${JSON.stringify(result.answer.slice(0, 220))}`);
  console.log(`  tokens=${result.llm.inputTokens}→${result.llm.outputTokens} latency=${result.llm.latencyMs}ms`);
  const usedWeb = (result.toolCalls ?? []).some((c) => c.name === "web_search");
  console.log(`  → web_search invoked: ${usedWeb ? "✓" : "✗"}`);

  await pool.query("DELETE FROM moderator.worker_roles WHERE agent_id=$1 AND role_key=$2", [AGENT, roleKey]);
}

async function scenarioI_skillEmit() {
  console.log("\n=== I. Skill emit — Moderator-coined role also lands as a SKILL.md ===");
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const tmpRoot = mkdtempSync("/tmp/nextclaw-sim-skills-");
  console.log(`  tmp skills dir: ${tmpRoot}`);

  const workerLlm = buildWorkerLlmFromConfig({
    format: "gemini",
    baseUrl: "http://100.79.97.110:8800/v1/proxy/gemini",
    model: "gemini-2.5-flash",
  });
  const cfg = {
    pluginId: "memory-postgres",
    storage: { schema: "public", chunksTable: "chunks", chunkIndexesTable: "chunk_indexes" },
    embedding: { model: "qwen3-embedding:0.6b" },
    moderator: { model: { format: "gemini", model: "gemini-2.5-flash" } },
  };
  const logger = { info: (m) => console.log("    log:", m), warn: () => {} };
  const wkDeps = { pool, workerLlm, embedding, cfg, agentId: AGENT, logger, publishSkillsDir: tmpRoot };

  const uid = randomUUID().slice(0, 6);
  const roleKey = `sim_skillemit_${uid}`;
  const task = {
    taskId: `t_skillemit_${uid}`,
    roleKey,
    taskPrompt: "用一句话回答：1+1=?",
    canParallel: true,
    newRoleSpec: {
      systemPrompt: `你是一个 [${uid}] 测试 specialist：用 8 个字以内回答任何数学题。`,
      displayName: `Sim Skill Specialist ${uid}`,
      memoryScope: { topic: "sim.skill-emit" },
      tools: [],
    },
  };

  const result = await dispatchWorker(
    wkDeps,
    task,
    { userId: "u-sim", chatId: "-1003789981008" },
    task.taskPrompt,
    SCOPE,
  );
  console.log(`  worker ok: ${result.ok}`);

  const skillPath = `${tmpRoot}/${roleKey}/SKILL.md`;
  const skillFileExists = existsSync(skillPath);
  console.log(`  SKILL.md exists at ${skillPath}: ${skillFileExists ? "✓" : "✗"}`);
  if (skillFileExists) {
    const content = readFileSync(skillPath, "utf8");
    const hasFrontmatter = content.startsWith("---\n");
    const hasRoleKey = content.includes(`name: ${roleKey}`);
    const hasSystemPrompt = content.includes("测试 specialist");
    console.log(`  frontmatter present: ${hasFrontmatter ? "✓" : "✗"}`);
    console.log(`  name field matches: ${hasRoleKey ? "✓" : "✗"}`);
    console.log(`  systemPrompt body present: ${hasSystemPrompt ? "✓" : "✗"}`);
    console.log(`  first 200 chars:\n    ${content.slice(0, 200).replace(/\n/g, "\n    ")}`);
  }

  // Cleanup
  await pool.query("DELETE FROM moderator.worker_roles WHERE agent_id=$1 AND role_key=$2", [AGENT, roleKey]);
  rmSync(tmpRoot, { recursive: true, force: true });
}

async function main() {
  console.log("Concurrency simulation — Moderator cache + worker pipeline");
  console.log("==========================================================");
  try {
    await scenarioA_stampede();
    await scenarioB_crossScope();
    await scenarioC_viewerIsolation();
    await scenarioD_mixed();
    await scenarioE_workerRoundtrip();
    await scenarioF_roleAutoRegister();
    await scenarioG_workerTools();
    await scenarioH_webSearch();
    await scenarioI_skillEmit();
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
