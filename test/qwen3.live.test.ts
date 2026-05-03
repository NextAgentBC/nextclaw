/**
 * Live qwen3 embedding probe via configurable QWEN_EMBED_URL endpoint.
 *
 * Skipped silently when neither OPENCLAW_LIVE_TEST nor the live test URL are
 * set. This test verifies the OpenAI-compat path against the real broker:
 * a 4096-dim qwen3-embedding response is parsed correctly.
 */

import { describe, expect, it } from "vitest";
import { EmbeddingClient } from "../src/embedding/client.js";

const BASE = "process.env.QWEN_EMBED_URL ?? "http://localhost:11434/v1/proxy/local-embed"";
const enabled = process.env["OPENCLAW_LIVE_TEST"] === "1";
const describeLive = enabled ? describe : describe.skip;

describeLive("qwen3 embedding via configurable endpoint (live)", () => {
  it("returns a 4096-dim vector for a single input", async () => {
    const client = new EmbeddingClient({
      baseUrl: BASE,
      model: "qwen3-embedding",
      format: "openai",
    });
    const r = await client.embed({ inputs: ["probe"] });
    expect(r.embeddings.length).toBe(1);
    expect(r.dims).toBe(4096);
    expect(r.embeddings[0].length).toBe(4096);
    expect(r.latencyMs).toBeGreaterThan(0);
  });

  it("returns aligned vectors for batched inputs", async () => {
    const client = new EmbeddingClient({
      baseUrl: BASE,
      model: "qwen3-embedding",
      format: "openai",
    });
    const r = await client.embed({
      inputs: ["alpha apple", "bravo banana", "charlie cherry"],
    });
    expect(r.embeddings.length).toBe(3);
    for (const v of r.embeddings) {expect(v.length).toBe(4096);}
    // Distinct inputs should have non-identical embeddings.
    const sumDelta = r.embeddings[0]
      .map((x, i) => Math.abs(x - r.embeddings[1][i]))
      .reduce((a, b) => a + b, 0);
    expect(sumDelta).toBeGreaterThan(0);
  });

  it("decorates query with qwen3 prefix when taskPrefix='query'", async () => {
    const client = new EmbeddingClient({
      baseUrl: BASE,
      model: "qwen3-embedding",
      format: "openai",
    });
    const a = await client.embed({ inputs: ["calorie intake"] });
    const b = await client.embed({ inputs: ["calorie intake"], taskPrefix: "query" });
    // Same text but different framing → different embeddings.
    let delta = 0;
    for (let i = 0; i < 4096; i += 1) {
      delta += Math.abs(a.embeddings[0][i] - b.embeddings[0][i]);
    }
    expect(delta).toBeGreaterThan(0);
  });

  it("probe() succeeds against the live endpoint", async () => {
    const client = new EmbeddingClient({
      baseUrl: BASE,
      model: "qwen3-embedding",
      format: "openai",
    });
    const r = await client.probe();
    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.dims).toBe(4096);}
  });
});
