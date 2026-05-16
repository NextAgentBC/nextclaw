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

  it("accepts a config with no embedding block (jina free-tier defaults apply)", () => {
    expect(() =>
      validateConfig({ postgres: { url: "postgres://x" } }),
    ).not.toThrow();
  });

  it("accepts an empty embedding block (defaults apply per-field)", () => {
    expect(() =>
      validateConfig({ postgres: { url: "postgres://x" }, embedding: {} }),
    ).not.toThrow();
  });

  it("rejects an unknown embedding format", () => {
    expect(() =>
      validateConfig({
        postgres: { url: "postgres://x" },
        embedding: { format: "cohere" },
      }),
    ).toThrow(/format/);
  });

  it("resolveConfig fills jina free-tier defaults when embedding block is absent", () => {
    const resolved = resolveConfig({
      postgres: { url: "postgres://localhost/x" },
    });
    expect(resolved.embedding.format).toBe("jina");
    expect(resolved.embedding.model).toBe("jina-embeddings-v3");
    expect(resolved.embedding.baseUrl).toBe("https://api.jina.ai");
    expect(resolved.embedding.apiKeyEnv).toBe("JINA_API_KEY");
    expect(resolved.embedding.provider).toBe("jina");
  });

  it("resolveConfig fills ollama defaults when format=ollama with other fields blank", () => {
    const resolved = resolveConfig({
      postgres: { url: "postgres://localhost/x" },
      embedding: { format: "ollama" },
    });
    expect(resolved.embedding.format).toBe("ollama");
    expect(resolved.embedding.model).toBe("qwen3-embedding:4b");
    expect(resolved.embedding.baseUrl).toBe("http://127.0.0.1:11434");
    expect(resolved.embedding.apiKeyEnv).toBeUndefined();
  });

  it("resolveConfig respects explicit overrides on top of format-based defaults", () => {
    const resolved = resolveConfig({
      postgres: { url: "postgres://x" },
      embedding: { format: "openai", model: "text-embedding-3-large", baseUrl: "https://proxy.local/v1" },
    });
    expect(resolved.embedding.format).toBe("openai");
    expect(resolved.embedding.model).toBe("text-embedding-3-large");
    expect(resolved.embedding.baseUrl).toBe("https://proxy.local/v1");
    // apiKeyEnv was not explicitly set; falls through to openai default
    expect(resolved.embedding.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("resolveConfig fills sensible defaults", () => {
    const resolved = resolveConfig({
      postgres: { url: "postgres://localhost/x" },
      embedding: { provider: "ollama", model: "qwen3-embedding:0.6b", format: "ollama" },
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
      embedding: { provider: "ollama", model: "qwen3-embedding:8b", dims: 4096, format: "ollama" },
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
