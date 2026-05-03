/**
 * memory-postgres prompt section: tells the agent how to use memory_search /
 * memory_store, and asks it to emit a sidecar JSON block at turn end so we
 * can capture facts/preferences/metrics structurally.
 *
 * Returns lines that get appended to the agent's system prompt. The shape
 * matches memory-core's prompt section so the agent's prompt structure
 * stays consistent across memory backends.
 */

import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasSearch = availableTools.has("memory_search");
  const hasStore = availableTools.has("memory_store");
  if (!hasSearch && !hasStore) {return [];}

  const lines: string[] = ["## Memory Recall (memory-postgres)"];

  if (hasSearch) {
    lines.push(
      "Before answering questions about past work, decisions, people, preferences, files, "
        + "or anything time-bound, call `memory_search` first. "
        + "Pass `cwd`, `branch`, `pr`, or `timeBucket` (YYYY-MM-DD) when you have those signals — "
        + "they hit the anchor route which is sub-second and zero-cost.",
    );
  }

  if (hasStore) {
    lines.push(
      "When the user states a durable fact, preference, decision, or shares a measurable "
        + "metric (calories, time spent, count, etc.), use `memory_store` to persist it. "
        + "Pin (`pinned: true`) only for truly long-term preferences. "
        + "Pass anchors so future recall finds it without semantic search.",
    );
  }

  // Sidecar tagging: ask the agent to emit a structured JSON block at turn end.
  // The flushPlanResolver / dream pipeline scans for this and ingests it via
  // ingestOne's sidecarText path — zero LLM cost for the structuring pass.
  lines.push(
    "## Memory Sidecar",
    "After your reply, on the very last line of your turn output exactly one structured "
      + "block in this format (omit if nothing memorable happened):",
    "<mem>{\"entities\":[],\"events\":[],\"preferences\":[],\"metrics\":[]}</mem>",
    "Each item is small and concrete (e.g. {\"type\":\"person\",\"canonicalName\":\"shadow\"}, "
      + "{\"metric\":\"calories\",\"value\":1800,\"unit\":\"kcal\",\"ts\":\"2026-05-02\"}).",
    "Sidecar is the cheapest path; deterministic regex + tool calls back you up if you skip it.",
  );

  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not include source paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include `pg://<source>/<chunkId>` when it helps the user verify a memory.",
    );
  }
  lines.push("");
  return lines;
};
