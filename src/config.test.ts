import { describe, expect, it } from "vitest";
import { resolveConfig, validateConfig } from "./config.js";

describe("memory-postgres config", () => {
  it("validates a minimal config", () => {
    const raw = {
      postgres: { url: "postgres://u:p@127.0.0.1:5432/openclaw_memory" },
      embedding: { provider: "ollama", model: "qwen3-embedding:0.6b" },
    };
    expect(() => validateConfig(raw)).not.toThrow();
  });

  it("requires postgres.url", () => {
    expect(() => validateConfig({})).toThrow(/postgres/);
    expect(() => validateConfig({ postgres: {} })).toThrow(/postgres\.url/);
  });

  it("requires embedding.provider and embedding.model", () => {
    expect(() =>
      validateConfig({ postgres: { url: "postgres://x" }, embedding: {} }),
    ).toThrow(/embedding/);
  });

  it("resolveConfig fills sensible defaults", () => {
    const resolved = resolveConfig({
      postgres: { url: "postgres://localhost/x" },
      embedding: { provider: "ollama", model: "qwen3-embedding:0.6b" },
    });
    expect(resolved.postgres.poolMax).toBe(8);
    expect(resolved.tiers.t0SizeLimit).toBe(50);
    expect(resolved.tiers.t1SizeLimit).toBe(500);
    expect(resolved.scoring.ingest.weights.token).toBeCloseTo(0.30);
    expect(resolved.scoring.recall.weights.tier).toBeCloseTo(0.25);
    expect(resolved.dashboard.host).toBe("127.0.0.1");
    expect(resolved.dashboard.port).toBe(8765);
    expect(resolved.tuning.autoApplyEnabled).toBe(false);
  });

  it("resolveConfig honors user overrides without merging undefined", () => {
    const resolved = resolveConfig({
      postgres: { url: "postgres://x", poolMax: 16 },
      embedding: { provider: "ollama", model: "qwen3-embedding:8b", dims: 4096 },
      tiers: { t0SizeLimit: 100 },
      scoring: { ingest: { weights: { token: 0.5 } } },
      dashboard: { enabled: true, host: "0.0.0.0", port: 9000 },
    });
    expect(resolved.postgres.poolMax).toBe(16);
    expect(resolved.embedding.dims).toBe(4096);
    expect(resolved.tiers.t0SizeLimit).toBe(100);
    expect(resolved.tiers.t1SizeLimit).toBe(500);
    expect(resolved.scoring.ingest.weights.token).toBeCloseTo(0.5);
    expect(resolved.scoring.ingest.weights.latency).toBeCloseTo(0.20);
    expect(resolved.dashboard.enabled).toBe(true);
    expect(resolved.dashboard.host).toBe("0.0.0.0");
    expect(resolved.dashboard.port).toBe(9000);
  });
});
