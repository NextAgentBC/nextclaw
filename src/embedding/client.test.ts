import { describe, expect, it, vi } from "vitest";
import { EmbeddingClient } from "./client.js";

type FetchCall = Parameters<typeof fetch>;

function makeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const impl = async (..._args: FetchCall): Promise<Response> => {
    const r = responses[Math.min(i, responses.length - 1)] ?? { status: 200, body: {} };
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return vi.fn(impl);
}

function lastCall<T extends (...args: never[]) => unknown>(
  spy: ReturnType<typeof vi.fn<T>>,
): { url?: URL | string; init?: RequestInit } {
  const calls = spy.mock.calls as ReadonlyArray<readonly unknown[]>;
  const last = calls[calls.length - 1] ?? [];
  return {
    url: last[0] as URL | string | undefined,
    init: last[1] as RequestInit | undefined,
  };
}

describe("EmbeddingClient", () => {
  it("posts to /api/embed with model + input + bearer auth", async () => {
    const fetchSpy = makeFetch([
      { status: 200, body: { embeddings: [[1, 2, 3]] } },
    ]);
    const client = new EmbeddingClient({
      baseUrl: "http://example.tailnet.ts.net:11434",
      model: "qwen3-embedding:0.6b",
      apiKey: "secret-tok",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.embed({ inputs: ["hello"] });
    expect(res.embeddings).toEqual([[1, 2, 3]]);
    expect(res.dims).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, init = {} } = lastCall(fetchSpy);
    expect(String(url)).toBe("http://example.tailnet.ts.net:11434/api/embed");
    expect(init.method).toBe("POST");
    const headers = (init.headers as Record<string, string> | undefined) ?? {};
    expect(headers["authorization"]).toBe("Bearer secret-tok");
    const body = JSON.parse(((init.body as string | undefined) ?? "{}")) as { model?: string; input?: string[] };
    expect(body.model).toBe("qwen3-embedding:0.6b");
    expect(body.input).toEqual(["hello"]);
  });

  it("decorates query inputs with the qwen3 instruction prefix", async () => {
    const fetchSpy = makeFetch([
      { status: 200, body: { embeddings: [[0.1, 0.2]] } },
    ]);
    const client = new EmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.embed({ inputs: ["卡路里"], taskPrefix: "query" });
    const { init = {} } = lastCall(fetchSpy);
    const body = JSON.parse(((init.body as string | undefined) ?? "{}")) as { input?: string[] };
    expect(body.input?.[0]).toMatch(/^Instruct: Given a user query.*Query:卡路里$/s);
  });

  it("returns empty without calling fetch when inputs is empty", async () => {
    const fetchSpy = makeFetch([]);
    const client = new EmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.embed({ inputs: [] });
    expect(res.embeddings).toEqual([]);
    expect(res.dims).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on HTTP error with response body included", async () => {
    const fetchSpy = makeFetch([{ status: 500, body: "boom" }]);
    const client = new EmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.embed({ inputs: ["x"] })).rejects.toThrow(/embed HTTP 500/);
  });

  it("throws when response embeddings count mismatches input count", async () => {
    const fetchSpy = makeFetch([
      { status: 200, body: { embeddings: [[1, 2, 3]] } },
    ]);
    const client = new EmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.embed({ inputs: ["a", "b"] })).rejects.toThrow(/missing embeddings/);
  });

  it("probe() returns { ok, dims } on success", async () => {
    const fetchSpy = makeFetch([
      { status: 200, body: { embeddings: [Array.from({ length: 1024 }, (_, i) => i / 1024)] } },
    ]);
    const client = new EmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await client.probe();
    expect(res.ok).toBe(true);
    if (res.ok) {expect(res.dims).toBe(1024);}
  });
});
