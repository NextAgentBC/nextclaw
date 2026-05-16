import { describe, expect, it } from "vitest";
import { inferTimeBucketsFromQuery } from "./temporal.js";

const FIXED_NOW = new Date("2026-05-16T17:30:00Z"); // Saturday

describe("inferTimeBucketsFromQuery", () => {
  it("returns null for queries with no temporal cue", () => {
    expect(inferTimeBucketsFromQuery("what did Yao say about Postgres", FIXED_NOW)).toBeNull();
    expect(inferTimeBucketsFromQuery("hello", FIXED_NOW)).toBeNull();
  });

  it("today / 今天 → single bucket", () => {
    const r1 = inferTimeBucketsFromQuery("what did I do today", FIXED_NOW);
    expect(r1?.buckets).toEqual(["2026-05-16"]);
    const r2 = inferTimeBucketsFromQuery("我今天说了什么", FIXED_NOW);
    expect(r2?.buckets).toEqual(["2026-05-16"]);
  });

  it("yesterday / 昨天 → today-1", () => {
    expect(inferTimeBucketsFromQuery("what happened yesterday", FIXED_NOW)?.buckets).toEqual(["2026-05-15"]);
    expect(inferTimeBucketsFromQuery("昨天说了啥", FIXED_NOW)?.buckets).toEqual(["2026-05-15"]);
  });

  it("前天 → today-2", () => {
    expect(inferTimeBucketsFromQuery("前天的对话", FIXED_NOW)?.buckets).toEqual(["2026-05-14"]);
  });

  it("N days ago / N 天前", () => {
    expect(inferTimeBucketsFromQuery("3 days ago", FIXED_NOW)?.buckets).toEqual(["2026-05-13"]);
    expect(inferTimeBucketsFromQuery("7 天前", FIXED_NOW)?.buckets).toEqual(["2026-05-09"]);
  });

  it("this week / 这周 → Mon..today range", () => {
    // FIXED_NOW is Saturday 2026-05-16, ISO week Mon = 2026-05-11
    const r = inferTimeBucketsFromQuery("this week's work", FIXED_NOW);
    expect(r?.buckets[0]).toBe("2026-05-11");
    expect(r?.buckets[r.buckets.length - 1]).toBe("2026-05-16");
    expect(r?.buckets.length).toBe(6);
  });

  it("last week / 上周 → previous Mon..Sun range (7 days)", () => {
    const r = inferTimeBucketsFromQuery("上周做了什么", FIXED_NOW);
    expect(r?.buckets[0]).toBe("2026-05-04");
    expect(r?.buckets[r.buckets.length - 1]).toBe("2026-05-10");
    expect(r?.buckets.length).toBe(7);
  });

  it("last month / 上个月 → last 30 days", () => {
    const r = inferTimeBucketsFromQuery("上个月", FIXED_NOW);
    expect(r?.buckets.length).toBe(30);
    expect(r?.buckets[r.buckets.length - 1]).toBe("2026-05-15"); // today-1
  });

  it("explicit YYYY-MM-DD", () => {
    expect(inferTimeBucketsFromQuery("see 2025-12-25 notes", FIXED_NOW)?.buckets).toEqual(["2025-12-25"]);
  });

  it("explicit Chinese date 2026年5月10日", () => {
    expect(inferTimeBucketsFromQuery("2026年5月10日的会议", FIXED_NOW)?.buckets).toEqual(["2026-05-10"]);
  });

  it("more-specific match wins (today before this-week)", () => {
    // 'today' should NOT be promoted to this-week even though 'this' appears.
    const r = inferTimeBucketsFromQuery("today's plan", FIXED_NOW);
    expect(r?.matched).toBe("today");
    expect(r?.buckets).toEqual(["2026-05-16"]);
  });
});
