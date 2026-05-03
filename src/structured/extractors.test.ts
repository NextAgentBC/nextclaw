import { describe, expect, it } from "vitest";
import { extractAll, EXTRACTOR_VERSION } from "./extractors.js";

const fixedNow = new Date("2026-05-02T08:00:00Z");

describe("extractors (deterministic)", () => {
  it("emits a calorie metric + meal event from a calorie sentence", () => {
    const r = extractAll({
      text: "今天和 Shadow 在 Carbon 仓库改了 PR #1234，午饭吃了 1800 卡",
      source: "session",
      now: fixedNow,
    });
    expect(r.extractorVersion).toBe(EXTRACTOR_VERSION);

    // Metric
    expect(r.metrics).toHaveLength(1);
    const metric = r.metrics[0];
    expect(metric.metric).toBe("calories");
    expect(metric.unit).toBe("kcal");
    expect(metric.value).toBe(1800);
    // Today → start-of-day in UTC
    expect(metric.ts.toISOString()).toBe("2026-05-02T00:00:00.000Z");

    // PR + meal events both present
    const eventTypes = r.events.map((e) => e.type).toSorted();
    expect(eventTypes).toContain("pr_change");
    expect(eventTypes).toContain("meal");
    const pr = r.events.find((e) => e.type === "pr_change")!;
    expect((pr.details as { prNumber: number }).prNumber).toBe(1234);
  });

  it("extracts repo + file entities when present", () => {
    const r = extractAll({
      text: "see openclaw/openclaw and src/foo/bar.ts for details",
      source: "session",
      now: fixedNow,
    });
    const repos = r.entities.filter((e) => e.type === "repo").map((e) => e.canonicalName);
    const files = r.entities.filter((e) => e.type === "file").map((e) => e.canonicalName);
    expect(repos).toContain("openclaw/openclaw");
    expect(files).toContain("src/foo/bar.ts");
  });

  it("extracts @mention as person entity (lowercased canonical)", () => {
    const r = extractAll({
      text: "review with @Shadow before merging",
      source: "session",
      now: fixedNow,
    });
    const person = r.entities.find((e) => e.type === "person");
    expect(person?.canonicalName).toBe("shadow");
    expect(person?.aliases).toContain("Shadow");
  });

  it("captures user preference when 'remember'/'记住' phrasing is present", () => {
    const r = extractAll({
      text: "记住 以后 PR 都要先跑 pnpm test",
      source: "session",
      now: fixedNow,
    });
    expect(r.preferences).toHaveLength(1);
    expect(r.preferences[0].scope).toBe("global");
    expect(r.preferences[0].key).toBe("user_rule");
  });

  it("respects time anchors: 昨天 → previous day", () => {
    const r = extractAll({
      text: "昨天跑了 5 公里",
      source: "session",
      now: fixedNow,
    });
    expect(r.metrics).toHaveLength(1);
    const m = r.metrics[0];
    expect(m.metric).toBe("distance");
    expect(m.value).toBe(5);
    expect(m.unit).toBe("km");
    expect(m.ts.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("respects ISO date anchors over relative ones", () => {
    const r = extractAll({
      text: "On 2025-09-15 I logged 8000 步",
      source: "session",
      now: fixedNow,
    });
    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0].ts.toISOString()).toBe("2025-09-15T00:00:00.000Z");
    expect(r.metrics[0].metric).toBe("steps");
  });

  it("relation extraction picks up '和 X' collaboration", () => {
    const r = extractAll({
      text: "和 @shadow 改了 PR #42",
      source: "session",
      now: fixedNow,
    });
    const works = r.relations.find((rel) => rel.predicate === "works_with");
    expect(works?.object?.canonicalName).toBe("shadow");
  });

  it("does not invent events for trivial text", () => {
    const r = extractAll({ text: "ok thanks", source: "session", now: fixedNow });
    expect(r.events).toHaveLength(0);
    expect(r.metrics).toHaveLength(0);
    expect(r.preferences).toHaveLength(0);
    expect(r.relations).toHaveLength(0);
  });

  it("tool call signal becomes a structured event with details", () => {
    const r = extractAll({
      text: "edited file",
      source: "tool_call",
      signals: { toolCall: { name: "Edit", input: { file_path: "src/foo.ts" } } },
      now: fixedNow,
    });
    const evt = r.events.find((e) => e.type === "tool_call:edit");
    expect(evt).toBeDefined();
    expect((evt!.details as { file_path: string }).file_path).toBe("src/foo.ts");
  });
});
