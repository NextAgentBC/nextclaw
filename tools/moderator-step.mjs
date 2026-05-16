#!/usr/bin/env node
/**
 * One-shot manual driver for the Moderator decision loop.
 *
 * Loads or initializes a Moderator state from PG, runs ONE cycle against
 * gpt-5.5 (or whatever the moderator LLM config says), prints the
 * decision, and optionally persists the updated state.
 *
 * This lets you test Moderator behaviour end-to-end against a real
 * LLM without needing the Telegram event hook to be wired (that's
 * Phase C-wiring, separate commit). Useful for prompt iteration and
 * for triaging a single weird message after the fact.
 *
 * Usage:
 *   NEXTCLAW_DASH_TOKEN=...  OPENAI_API_KEY=...  \
 *     node tools/moderator-step.mjs \
 *       --scope tg:chat:-1001234567890 \
 *       --user 8064984663 \
 *       --label "Yao" \
 *       --text "@bot 怎么算 1/3 + 1/4" \
 *       --addressed \
 *       [--dry-run]               # don't save state, don't log decision
 *       [--api http://127.0.0.1:8765]
 *       [--moderator-base https://api.openai.com]
 *       [--moderator-model gpt-5.5]
 *       [--moderator-format openai|gemini]
 *       [--moderator-key-env OPENAI_API_KEY]
 *
 * For Gemini-via-credbroker (no key):
 *   --moderator-format gemini  --moderator-base http://100.79.97.110:8800/v1/proxy/gemini  --moderator-model gemini-2.5-flash
 */

import pg from "pg";
import { randomUUID } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) {continue;}
  const k = a.slice(2);
  const nxt = process.argv[i + 1];
  if (nxt === undefined || nxt.startsWith("--")) {args.set(k, "true");}
  else {args.set(k, nxt); i += 1;}
}

const scopeKey = args.get("scope");
const fromUserId = args.get("user");
const fromLabel = args.get("label");
const text = args.get("text");
const addressed = args.get("addressed") === "true";
const dryRun = args.get("dry-run") === "true";
const agentId = args.get("agent-id") ?? "main";

const moderatorFormat = args.get("moderator-format") ?? "openai";
const moderatorBase = args.get("moderator-base") ?? "https://api.openai.com";
const moderatorModel = args.get("moderator-model") ?? "gpt-5.5";
const moderatorKeyEnv = args.get("moderator-key-env") ?? "OPENAI_API_KEY";

const pgUrl = args.get("pg-url") ?? "postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw";

if (!scopeKey || !fromUserId || !text) {
  console.error("usage: --scope tg:chat:-100... --user <id> --text \"...\" [--addressed] [--dry-run]");
  process.exit(2);
}

// Load the compiled Moderator modules from dist/.
const repoRoot = new URL("..", import.meta.url);
const distState = await import(new URL("dist/src/moderator/state.js", repoRoot).href);
const distRunner = await import(new URL("dist/src/moderator/runner.js", repoRoot).href);
const distLlm = await import(new URL("dist/src/moderator/llm-client.js", repoRoot).href);

const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });

try {
  // 1. Load state
  const state = await distState.loadModeratorState(pool, agentId, scopeKey);
  console.log("=== state BEFORE ===");
  console.log(`  scope=${state.scopeKey}  kind=${state.scopeKind}`);
  console.log(`  recentMessages=${state.recentMessages.length}  activeWorkers=${state.activeWorkers.length}`);
  console.log(`  notes=${state.notes.length}  activeTopic=${state.activeTopic ?? "(none)"}`);

  // 2. Build LLM client
  const llm = distLlm.buildModeratorLlm({
    format: moderatorFormat,
    baseUrl: moderatorBase,
    model: moderatorModel,
    apiKeyEnv: moderatorKeyEnv,
  });

  // 3. Run one cycle
  const message = {
    ts: new Date().toISOString(),
    fromUserId,
    fromLabel: fromLabel ?? undefined,
    text,
    isAddressed: addressed,
  };
  console.log(`\n=== trigger ===\n  message from ${fromUserId} (${fromLabel ?? "?"}): ${text}\n  addressed=${addressed}\n`);

  const startedAt = Date.now();
  const out = await distRunner.runOneCycle(state, { kind: "message", message }, llm, []);
  const elapsed = Date.now() - startedAt;

  console.log(`=== decision (elapsed ${elapsed}ms; llm ${out.llm.latencyMs ?? "?"}ms / in ${out.llm.inputTokens ?? "?"}t / out ${out.llm.outputTokens ?? "?"}t) ===`);
  console.log(`  action:    ${out.decision.action}`);
  console.log(`  rationale: ${out.decision.rationale}`);
  if (out.decision.memoryWrites?.length) {
    console.log(`  memoryWrites (${out.decision.memoryWrites.length}):`);
    for (const w of out.decision.memoryWrites) {
      console.log(`    - [${w.scope}${w.visibility ? `/${w.visibility}` : ""}] ${w.text}`);
    }
  }
  if (out.decision.answerTasks?.length) {
    console.log(`  answerTasks (${out.decision.answerTasks.length}):`);
    for (const t of out.decision.answerTasks) {
      console.log(`    - ${t.taskId} → role=${t.roleKey}  parallel=${t.canParallel !== false}`);
      console.log(`      prompt: ${t.taskPrompt.slice(0, 120)}${t.taskPrompt.length > 120 ? "…" : ""}`);
    }
  }
  if (out.decision.telegramActions?.length) {
    console.log(`  telegramActions (${out.decision.telegramActions.length}):`);
    for (const a of out.decision.telegramActions) {
      console.log(`    - ${JSON.stringify(a)}`);
    }
  }
  if (out.decision.escalation) {
    console.log(`  ESCALATE: ${out.decision.escalation.reason} — ${out.decision.escalation.summary}`);
  }
  if (out.parseErrors.length > 0) {
    console.log(`  parseErrors: ${JSON.stringify(out.parseErrors)}`);
  }

  if (dryRun) {
    console.log("\n(dry-run, state not saved, decision not logged)");
  } else {
    await distState.saveModeratorState(pool, agentId, scopeKey, out.state, {
      bumpMessageCount: 1,
      bumpDecisionCount: 1,
      lastMessageAt: new Date(),
    });
    await distState.logDecision(pool, {
      agentId,
      scopeKey,
      triggerKind: "message",
      triggerUserId: fromUserId,
      triggerText: text,
      decision: out.decision,
      model: out.llm.model,
      inputTokens: out.llm.inputTokens,
      outputTokens: out.llm.outputTokens,
      latencyMs: out.llm.latencyMs,
      workersSpawned: out.decision.answerTasks?.length ?? 0,
      errors: out.parseErrors,
    });
    console.log("\nstate saved + decision logged");
  }
} finally {
  await pool.end();
}
