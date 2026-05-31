import { describe, expect, it } from "vitest";
import { writeChunk } from "./manager.js";
import { EmbeddingClient } from "./embedding/client.js";

/**
 * Regression guard for the dedup-signal bug: a duplicate re-ingest must bump
 * last_seen_at / dup_count and MUST NOT touch last_recalled_at / recall_count.
 * Conflating the two used to keep frequently re-seen chunks perpetually "warm"
 * so the cold-gist compactor could never age them. See 60-last-seen.sql.
 *
 * Pure unit test — a query-recording fake Pool, no live Postgres.
 */

function fakePool(responses: Array<{ rowCount: number; rows: unknown[] }>) {
  const queries: string[] = [];
  let i = 0;
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql);
      return responses[i++] ?? { rowCount: 0, rows: [] };
    },
  };
}

/** Fails the test if embedding is invoked — the dedup path must short-circuit. */
class ExplodingEmbedding extends EmbeddingClient {
  constructor() {
    super({ baseUrl: "http://stub", model: "stub:16" });
  }
  override async embed(): Promise<never> {
    throw new Error("embed() must not run on the dedup path");
  }
}

describe("writeChunk dedup signal", () => {
  it("on a duplicate, bumps last_seen_at + dup_count and leaves the recall signal alone", async () => {
    const pool = fakePool([
      { rowCount: 1, rows: [{ id: "existing-id" }] }, // dedup SELECT hits
      { rowCount: 1, rows: [] }, // the UPDATE
    ]);

    const res = await writeChunk(
      pool as unknown as Parameters<typeof writeChunk>[0],
      new ExplodingEmbedding() as unknown as EmbeddingClient,
      { text: "duplicate text", source: "test" },
    );

    expect(res).toEqual({ id: "existing-id", written: false });
    expect(pool.queries).toHaveLength(2); // SELECT + UPDATE, no INSERT/BEGIN

    const updateSql = pool.queries[1];
    expect(updateSql).toMatch(/last_seen_at/);
    expect(updateSql).toMatch(/dup_count/);
    // The bug we're guarding against: dedup must not move the recall signal.
    expect(updateSql).not.toMatch(/last_recalled_at/);
    expect(updateSql).not.toMatch(/recall_count/);
  });
});
