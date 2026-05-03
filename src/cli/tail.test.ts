import { describe, expect, it } from "vitest";
import { _internal } from "./tail.js";

const { formatLine, shouldShow } = _internal;

describe("memory tail formatter", () => {
  it("renders an ingest-accepted event with green ACCEPT tag", () => {
    const line = formatLine({
      table: "ingest_decisions",
      op: "INSERT",
      id: "x",
      ts: "2026-05-02T12:30:45Z",
      decision: "accepted",
      ingest_path: "deterministic",
      score: 87.4,
    });
    expect(line).toContain("ACCEPT");
    expect(line).toContain("deterministic");
    expect(line).toMatch(/score=87\.4/);
    expect(line).toContain("12:30:45");
  });

  it("renders an ingest-rejected event with red REJECT tag", () => {
    const line = formatLine({
      table: "ingest_decisions",
      op: "INSERT",
      id: "x",
      ts: "2026-05-02T12:30:45Z",
      decision: "rejected",
      ingest_path: "deterministic",
    });
    expect(line).toContain("REJECT");
  });

  it("renders recall events with tier label", () => {
    const line = formatLine({
      table: "recall_decisions",
      op: "INSERT",
      id: "x",
      ts: "2026-05-02T12:30:45Z",
      hit_tier: "t2_anchor",
      returned: 5,
      score: 81.2,
    });
    expect(line).toMatch(/RECALL/);
    expect(line).toContain("t2_anchor");
    expect(line).toContain("returned=5");
    expect(line).toMatch(/score=81\.2/);
  });

  it("filters: rejected only", () => {
    const ev = (decision: string) => ({
      table: "ingest_decisions" as const,
      op: "INSERT",
      id: "x",
      ts: "2026-05-02T12:00:00Z",
      decision,
      ingest_path: "deterministic",
    });
    expect(shouldShow(ev("accepted"), "rejected")).toBe(false);
    expect(shouldShow(ev("rejected"), "rejected")).toBe(true);
  });

  it("filters: recall only", () => {
    expect(
      shouldShow(
        {
          table: "ingest_decisions",
          op: "INSERT",
          id: "x",
          ts: "2026-05-02T12:00:00Z",
          decision: "accepted",
          ingest_path: "deterministic",
        },
        "recall",
      ),
    ).toBe(false);
    expect(
      shouldShow(
        {
          table: "recall_decisions",
          op: "INSERT",
          id: "x",
          ts: "2026-05-02T12:00:00Z",
          hit_tier: "t1",
        },
        "recall",
      ),
    ).toBe(true);
  });
});
