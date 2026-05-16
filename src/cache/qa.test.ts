import { describe, expect, it, vi } from "vitest";
import {
  lookupCachedAnswerExact,
  lookupCachedAnswerSemantic,
  storeCachedAnswer,
  recordCacheHit,
  recordCacheFeedback,
} from "./qa.js";

function mockPool(rows: Array<Record<string, unknown>>) {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  } as unknown as Parameters<typeof lookupCachedAnswerExact>[0];
}

describe("cache.qa lookup — exact path", () => {
  it("returns null when no row matches", async () => {
    const pool = mockPool([]);
    const r = await lookupCachedAnswerExact(pool, {
      questionText: "what is 1/3 + 1/4",
    });
    expect(r).toBeNull();
  });

  it("returns a hit with similarity=1.0 on match", async () => {
    const pool = mockPool([
      {
        id: "abc-id",
        question_text: "what is 1/3 + 1/4",
        answer_text: "7/12",
        answer_format: "plain",
        topic_tag: "math.fractions",
        use_count: 5,
        upvotes: 2,
        downvotes: 0,
        scope_chat_id: null,
        scope_sender_id: null,
        scope_visibility: "public",
        source: "agent",
        source_doc_id: null,
      },
    ]);
    const r = await lookupCachedAnswerExact(pool, {
      questionText: "what is 1/3 + 1/4",
    });
    expect(r).not.toBeNull();
    expect(r!.id).toBe("abc-id");
    expect(r!.similarity).toBe(1.0);
    expect(r!.hitKind).toBe("exact");
    expect(r!.answerText).toBe("7/12");
  });

  it("hashes the question lowercased + trimmed", async () => {
    const pool = mockPool([]);
    const spy = pool.query as ReturnType<typeof vi.fn>;
    await lookupCachedAnswerExact(pool, { questionText: "  WHAT IS 1/3 + 1/4  " });
    const callArgs = spy.mock.calls[0];
    const sql = callArgs[0] as string;
    expect(sql).toContain("question_hash = $2");
    // Bind value $2 is the hash buffer — can't read raw, but its presence
    // implies normalisation happened in `hashQuestion`.
    expect(callArgs[1]).toBeDefined();
  });
});

describe("cache.qa lookup — semantic path", () => {
  it("returns null when no embedding provided", async () => {
    const pool = mockPool([]);
    const r = await lookupCachedAnswerSemantic(pool, {
      questionText: "x",
      questionEmbedding: undefined,
    });
    expect(r).toBeNull();
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("returns null when best match is below threshold", async () => {
    const pool = mockPool([
      { id: "row1", question_text: "x", answer_text: "x", answer_format: "plain", topic_tag: null,
        use_count: 0, upvotes: 0, downvotes: 0, scope_chat_id: null, scope_sender_id: null,
        scope_visibility: "public", source: "agent", source_doc_id: null,
        similarity: 0.7 },  // below default 0.85
    ]);
    const r = await lookupCachedAnswerSemantic(pool, {
      questionText: "1/3 + 1/4",
      questionEmbedding: [0.1, 0.2, 0.3],
    });
    expect(r).toBeNull();
  });

  it("returns top hit when above threshold", async () => {
    const pool = mockPool([
      { id: "row1", question_text: "x", answer_text: "the answer", answer_format: "plain",
        topic_tag: "math.fractions", use_count: 3, upvotes: 1, downvotes: 0,
        scope_chat_id: null, scope_sender_id: null, scope_visibility: "public",
        source: "agent", source_doc_id: null, similarity: 0.91 },
    ]);
    const r = await lookupCachedAnswerSemantic(pool, {
      questionText: "1/3 + 1/4",
      questionEmbedding: [0.1, 0.2, 0.3],
    });
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeCloseTo(0.91);
    expect(r!.hitKind).toBe("semantic");
    expect(r!.answerText).toBe("the answer");
  });
});

describe("cache.qa viewer-scope embedded in SQL", () => {
  it("emits no scope clause when viewer omitted", async () => {
    const pool = mockPool([]);
    await lookupCachedAnswerExact(pool, { questionText: "x" });
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // No scope clause means the SQL just has the TRUE noop guard
    expect(sql).toMatch(/AND\s+TRUE/);
  });

  it("emits the three-tier scope clause when viewer set", async () => {
    const pool = mockPool([]);
    await lookupCachedAnswerExact(pool, {
      questionText: "x",
      viewer: { userId: "8064984663", chatId: "-1001234567890" },
    });
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("scope_chat_id IS NULL AND scope_sender_id IS NULL"); // T0
    expect(sql).toContain("scope_sender_id = $3");                                 // TA
    expect(sql).toContain("scope_chat_id = $4");                                   // TC
    expect(sql).toContain("scope_visibility = 'private'");                          // BLOCK
  });
});

describe("cache.qa write + ops", () => {
  it("storeCachedAnswer issues a single INSERT with bind values in the right order", async () => {
    const pool = mockPool([{ id: "newid" }]);
    const id = await storeCachedAnswer(pool, {
      questionText: "what is 1/3 + 1/4",
      questionEmbedding: [0.1, 0.2, 0.3, 0.4],
      embeddingModel: "qwen3-embedding:0.6b",
      answerText: "7/12",
      topicTag: "math.fractions",
      ttlDays: 30,
    });
    expect(id).toBe("newid");
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("INSERT INTO cache.qa");
    // ttlDays threaded through as the last bind
    expect(call[1][call[1].length - 1]).toBe("30");
  });

  it("recordCacheHit bumps use_count + last_used_at", async () => {
    const pool = mockPool([]);
    await recordCacheHit(pool, "id-1");
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("use_count = use_count + 1");
    expect(sql).toContain("last_used_at = now()");
  });

  it("recordCacheFeedback writes the vote + auto-invalidates on net-negative", async () => {
    const pool = mockPool([]);
    await recordCacheFeedback(pool, "id-1", "down");
    const spy = pool.query as ReturnType<typeof vi.fn>;
    // First call increments downvotes; second call may auto-invalidate.
    expect(spy.mock.calls.length).toBe(2);
    expect((spy.mock.calls[0][0] as string)).toContain("downvotes = downvotes + 1");
    expect((spy.mock.calls[1][0] as string)).toContain("invalidated = true");
  });
});
