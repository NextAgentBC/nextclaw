/**
 * Stage 4 LLM residual extractor (P2#6 wiring) — pure unit tests (no PG, no
 * network). Covers the JSON parser and the gate/fail-soft behaviour with a
 * mock chat client.
 */

import { describe, it, expect } from "vitest";
import { parseResidualPreferences, buildResidualExtractor } from "../src/ingest/residual.js";
import { resolveConfig } from "../src/config.js";

describe("parseResidualPreferences", () => {
  it("parses a clean JSON object (lowercases the key)", () => {
    expect(parseResidualPreferences('{"preferences":[{"key":"Coffee","value":"light roast","confidence":0.9}]}'))
      .toEqual([{ scope: "global", key: "coffee", value: "light roast", confidence: 0.9 }]);
  });
  it("tolerates code fences / surrounding prose, defaults confidence", () => {
    expect(parseResidualPreferences('sure:\n```json\n{"preferences":[{"key":"seat","value":"aisle"}]}\n```'))
      .toEqual([{ scope: "global", key: "seat", value: "aisle", confidence: 0.6 }]);
  });
  it("returns [] on non-JSON and drops malformed entries", () => {
    expect(parseResidualPreferences("not json")).toEqual([]);
    expect(parseResidualPreferences('{"preferences":[{"value":"no key"},{"key":"ok","value":"v"}]}'))
      .toEqual([{ scope: "global", key: "ok", value: "v", confidence: 0.6 }]);
  });
});

describe("buildResidualExtractor", () => {
  const cfg = resolveConfig({
    postgres: { url: "postgres://x" }, embedding: { provider: "stub", model: "m" },
    residual: { enabled: true, model: { format: "gemini", baseUrl: "http://stub", model: "g" } },
  });

  it("is undefined when residual is disabled (deterministic-only)", () => {
    const off = resolveConfig({ postgres: { url: "postgres://x" }, embedding: { provider: "stub", model: "m" } });
    expect(buildResidualExtractor(off)).toBeUndefined();
  });

  it("calls the model and maps preferences", async () => {
    const mock = { chat: async () => ({ ok: true as const, text: '{"preferences":[{"key":"coffee","value":"light","confidence":0.8}]}', inputTokens: 10, outputTokens: 5, latencyMs: 1 }) };
    const fn = buildResidualExtractor(cfg, mock)!;
    const r = await fn("I switched to light roast", {});
    expect(r.result.preferences).toEqual([{ scope: "global", key: "coffee", value: "light", confidence: 0.8 }]);
    expect(r.tokensUsed).toBe(15);
  });

  it("fails soft on a model error (e.g. 429) — empty result, 0 tokens", async () => {
    const mock = { chat: async () => ({ ok: false as const, error: "HTTP 429", latencyMs: 1 }) };
    const fn = buildResidualExtractor(cfg, mock)!;
    const r = await fn("anything", {});
    expect(r.result.preferences).toEqual([]);
    expect(r.tokensUsed).toBe(0);
  });
});
