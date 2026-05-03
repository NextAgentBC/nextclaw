/**
 * Categorizer unit tests — no DB, no network, pure functions.
 */
import { describe, it, expect } from "vitest";
import { categorize, applyCategoryPolicy } from "./categorizer.js";

const cats = (text: string) => categorize(text).map((h) => h.category);

describe("categorize()", () => {
  it("health: 锻炼 / 卡路里 / sleep", () => {
    expect(cats("今天跑了 5km，午饭 1850 千卡")).toContain("health");
    expect(cats("Slept 7 hours and did a 30-min HIIT workout")).toContain("health");
  });

  it("medical: 医院 / 用药 / 症状 — pinned by policy", () => {
    const hits = categorize("今天去医院做了血常规检查，医生开了布洛芬。");
    expect(hits.map((h) => h.category)).toContain("medical");
    const policy = applyCategoryPolicy(hits, { importance: 0.3 });
    expect(policy.retentionClass).toBe("pinned");
    expect(policy.importance).toBe(0.7);
  });

  it("tech: code / repo / postgres / docker", () => {
    expect(cats("提交了 PR #999，修了 transcript-watcher 的 backfill bug")).toContain("tech");
    expect(cats("Spinning up a docker-compose with postgres + pgvector")).toContain("tech");
  });

  it("life: meals / family / weekend", () => {
    expect(cats("周末和老婆带娃去公园散步，午饭吃了披萨")).toContain("life");
    expect(cats("Had brunch with my parents, then watched a movie")).toContain("life");
  });

  it("work: meeting / client / contract", () => {
    expect(cats("和客户开会，签了合同，下周交付方案")).toContain("work");
    expect(cats("Standup with the team, then 1:1 with my manager")).toContain("work");
  });

  it("finance: 钱 / 投资 / mortgage", () => {
    expect(cats("买了 100 股 AAPL，月供加了 200 加币")).toContain("finance");
    expect(cats("Paid the mortgage, transferred $500 via Venmo")).toContain("finance");
  });

  it("multi-label: 医疗 + 财务", () => {
    const out = cats("今天去医院花了 500 块买药");
    expect(out).toContain("medical");
    expect(out).toContain("finance");
  });

  it("multi-label: 健康 + 生活", () => {
    const out = cats("早上 5km 慢跑，下午和朋友吃晚饭");
    expect(out).toContain("health");
    expect(out).toContain("life");
  });

  it("other: catchall when nothing strong matches", () => {
    expect(cats("无关的随便一句话内容")).toEqual(["other"]);
  });

  it("does not mislabel a code commit as medical", () => {
    // "fix" + "issue" alone shouldn't pull in medical even though some
    // medical rules mention "diagnose" — we use specific medical terms.
    expect(cats("Fixed an issue where the recall router skipped semantic")).not.toContain("medical");
  });

  it("weight threshold: weak single hit alone does not fire", () => {
    // "钱" alone is a 0.5-weight signal — below MIN_WEIGHT 1.5.
    expect(cats("我有一些钱")).toEqual(["other"]);
  });

  it("policy passthrough for non-sensitive categories", () => {
    const hits = categorize("Code commit on branch feature/foo");
    const policy = applyCategoryPolicy(hits, { importance: 0.3, retentionClass: "standard" });
    expect(policy.importance).toBe(0.3);
    expect(policy.retentionClass).toBe("standard");
  });

  it("empty input → empty output", () => {
    expect(categorize("")).toEqual([]);
    expect(categorize("   \n\t   ")).toEqual([]);
  });
});
