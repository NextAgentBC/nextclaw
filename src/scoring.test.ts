import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import {
  computeIngestScore,
  computeRecallScore,
  _internal,
} from "./scoring.js";

const cfg = resolveConfig({
  postgres: { url: "postgres://x" },
  embedding: { provider: "ollama", model: "qwen3-embedding:0.6b" },
}).scoring;

describe("ingest scoring", () => {
  it("rewards deterministic + zero-token + low-latency + accepted with full confidence", () => {
    const score = computeIngestScore(
      {
        decision: "accepted",
        path: "deterministic",
        llmTokensUsed: 0,
        latencyMs: 0,
        extractorConfidenceAvg: 1.0,
      },
      cfg.ingest,
    );
    // 0.30*1 + 0.20*1 + 0.30*1 + 0.20*1 = 1.0  -> 100
    expect(score).toBeCloseTo(100, 2);
  });

  it("penalizes llm_residual + heavy tokens + slow latency", () => {
    const score = computeIngestScore(
      {
        decision: "accepted",
        path: "llm_residual",
        llmTokensUsed: 1000,
        latencyMs: 500,
        extractorConfidenceAvg: 0.7,
      },
      cfg.ingest,
    );
    // 0.30*0 + 0.20*0 + 0.30*0.7 + 0.20*0.4 = 0.21 + 0.08 = 0.29 -> 29
    expect(score).toBeCloseTo(29, 1);
  });

  it("rejected events score 0 quality regardless of path", () => {
    const score = computeIngestScore(
      {
        decision: "rejected",
        path: "deterministic",
        llmTokensUsed: 0,
        latencyMs: 0,
      },
      cfg.ingest,
    );
    // 0.30*1 + 0.20*1 + 0.30*0 + 0.20*1 = 0.70 -> 70
    expect(score).toBeCloseTo(70, 1);
  });

  it("path efficiency table is strictly ordered: deterministic > cache > sidecar > llm_residual", () => {
    const t = _internal.PATH_EFFICIENCY;
    expect(t.deterministic).toBeGreaterThan(t.cache);
    expect(t.cache).toBeGreaterThan(t.sidecar);
    expect(t.sidecar).toBeGreaterThan(t.llm_residual);
  });
});

describe("recall scoring", () => {
  it("T0 hit with no LLM and zero latency is near-perfect (relevance unknown ~0.5)", () => {
    const score = computeRecallScore(
      { hitTier: "t0", llmTokensUsed: 0, latencyMs: 0 },
      cfg.recall,
    );
    // 0.25*1 + 0.25*1 + 0.25*1 + 0.25*0.5 = 0.875 -> 87.5
    expect(score).toBeCloseTo(87.5, 2);
  });

  it("T0 with full relevance follow-up reaches 100", () => {
    const score = computeRecallScore(
      { hitTier: "t0", llmTokensUsed: 0, latencyMs: 0, relevanceEstimate: 1.0 },
      cfg.recall,
    );
    expect(score).toBeCloseTo(100, 2);
  });

  it("T3 with heavy tokens scores low", () => {
    const score = computeRecallScore(
      { hitTier: "t3", llmTokensUsed: 500, latencyMs: 200, relevanceEstimate: 0.5 },
      cfg.recall,
    );
    // 0.25*0 + 0.25*0 + 0.25*0.2 + 0.25*0.5 = 0.05+0.125 = 0.175 -> 17.5
    expect(score).toBeCloseTo(17.5, 2);
  });

  it("tier efficiency is strictly ordered T0 > T1 > T2_anchor > T2_hybrid > T2_full > T3", () => {
    const t = _internal.TIER_EFFICIENCY;
    expect(t.t0).toBeGreaterThan(t.t1);
    expect(t.t1).toBeGreaterThan(t.t2_anchor);
    expect(t.t2_anchor).toBeGreaterThan(t.t2_hybrid);
    expect(t.t2_hybrid).toBeGreaterThan(t.t2_full);
    expect(t.t2_full).toBeGreaterThan(t.t3);
  });
});
