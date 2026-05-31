import { describe, expect, it } from "vitest";
import { getChunk } from "./operations.js";

/**
 * getChunk is read-only and fail-closed: the agent_id filter lives in the
 * WHERE clause, so a chunk owned by another agent reads as not-found (we never
 * reveal it exists). Pure unit test — query-recording fake pool, no live PG.
 */

function fakePool(response: { rowCount: number; rows: unknown[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return response;
    },
  };
}

const deps = (pool: unknown) =>
  ({ pool, cfg: {}, embedding: {} }) as unknown as Parameters<typeof getChunk>[0];

describe("getChunk", () => {
  it("filters by id AND agent_id in the WHERE clause (hard isolation)", async () => {
    const pool = fakePool({ rowCount: 0, rows: [] });
    await getChunk(deps(pool), { chunkId: "abc", agentId: "main" });

    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+agent_id\s*=\s*\$2/);
    expect(params).toEqual(["abc", "main"]);
  });

  it("returns not-found when no row matches (covers wrong-agent — no leak)", async () => {
    const pool = fakePool({ rowCount: 0, rows: [] });
    const out = await getChunk(deps(pool), { chunkId: "abc", agentId: "club" });
    expect(out).toEqual({ ok: false, reason: "not-found" });
  });

  it("maps a found row to the chunk shape with a pg:// citation, read-only", async () => {
    const created = new Date("2026-05-20T10:00:00.000Z");
    const pool = fakePool({
      rowCount: 1,
      rows: [
        {
          id: "11111111-2222-3333-4444-555555555555",
          text: "the full chunk text",
          source: "manual",
          source_ref: null,
          kind: "fact",
          retention_class: "pinned",
          importance: 0.9,
          recall_count: 3,
          created_at: created,
        },
      ],
    });

    const out = await getChunk(deps(pool), {
      chunkId: "11111111-2222-3333-4444-555555555555",
      agentId: "main",
    });

    expect(out.ok).toBe(true);
    if (!out.ok) {return;}
    expect(out.chunk).toEqual({
      chunkId: "11111111-2222-3333-4444-555555555555",
      text: "the full chunk text",
      source: "manual",
      sourceRef: null,
      kind: "fact",
      retentionClass: "pinned",
      importance: 0.9,
      recallCount: 3,
      createdAt: "2026-05-20T10:00:00.000Z",
      citation: "pg://manual/11111111-2222-3333-4444-555555555555",
    });
    // Read-only: exactly one query (the SELECT) — no warmth/recall_count UPDATE.
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/^\s*SELECT/);
  });
});
