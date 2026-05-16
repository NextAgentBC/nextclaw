import { describe, expect, it, vi } from "vitest";
import { buildViewerScopeFilter, filterVisibleChunkIds } from "./viewer-scope.js";

describe("buildViewerScopeFilter", () => {
  it("returns no-op when viewer is undefined", () => {
    const f = buildViewerScopeFilter(undefined, 1);
    expect(f.whereSql).toBe("TRUE");
    expect(f.params).toEqual([]);
    expect(f.paramCount).toBe(0);
  });

  it("returns no-op when both viewer fields are empty", () => {
    const f = buildViewerScopeFilter({}, 1);
    expect(f.whereSql).toBe("TRUE");
    expect(f.paramCount).toBe(0);
  });

  it("emits the three-tier WHERE with bind params at the given start index", () => {
    const f = buildViewerScopeFilter({ userId: "8064984663", chatId: "-1001234567890" }, 5);
    // Two params consumed: $5 = userId, $6 = chatId
    expect(f.paramCount).toBe(2);
    expect(f.params).toEqual(["8064984663", "-1001234567890"]);
    // Sanity: SQL references both placeholders
    expect(f.whereSql).toContain("$5");
    expect(f.whereSql).toContain("$6");
    expect(f.whereSql).toContain("anchor_sender_id");
    expect(f.whereSql).toContain("anchor_chat_id");
    expect(f.whereSql).toContain("anchor_visibility");
  });

  it("substitutes sentinel string when only chatId is set (user-anonymous viewer)", () => {
    const f = buildViewerScopeFilter({ chatId: "-1001234567890" }, 1);
    expect(f.params[0]).toBe("__no_user__"); // userId sentinel
    expect(f.params[1]).toBe("-1001234567890");
  });
});

describe("filterVisibleChunkIds (mocked pool)", () => {
  function mockPool(returnIds: string[]) {
    return {
      query: vi.fn(async () => ({ rows: returnIds.map((id) => ({ id })) })),
    } as unknown as Parameters<typeof filterVisibleChunkIds>[0];
  }

  it("returns empty set when chunkIds is empty", async () => {
    const pool = mockPool([]);
    const out = await filterVisibleChunkIds(pool, { userId: "1" }, []);
    expect(out.size).toBe(0);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("passes everything through when viewer is undefined", async () => {
    const pool = mockPool([]); // pool would not be called
    const out = await filterVisibleChunkIds(pool, undefined, ["a", "b"]);
    expect(out.has("a")).toBe(true);
    expect(out.has("b")).toBe(true);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("issues one batch query and returns the rows it gets back", async () => {
    const pool = mockPool(["a", "c"]); // "b" was filtered out by SQL
    const out = await filterVisibleChunkIds(pool, { userId: "1", chatId: "-100" }, ["a", "b", "c"]);
    expect(out.has("a")).toBe(true);
    expect(out.has("c")).toBe(true);
    expect(out.has("b")).toBe(false);
    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    // SQL references the four anchor kinds the three-tier model uses
    expect(callArgs[0]).toContain("anchor_sender_id");
    expect(callArgs[0]).toContain("anchor_chat_id");
    expect(callArgs[0]).toContain("anchor_visibility");
    // Bind values: [chunkIds, viewerUser, viewerChat]
    expect(callArgs[1]).toEqual([["a", "b", "c"], "1", "-100"]);
  });
});
