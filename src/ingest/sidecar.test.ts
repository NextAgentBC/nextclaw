import { describe, expect, it } from "vitest";
import {
  parseSidecar,
  shouldRequestSidecar,
  mergeExtractorResults,
} from "./sidecar.js";
import { extractAll } from "../structured/extractors.js";

const now = new Date("2026-05-02T08:00:00Z");

describe("sidecar parser", () => {
  it("returns found=false when no <mem> block is present", () => {
    const r = parseSidecar("hello world", now);
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.result.entities).toHaveLength(0);
  });

  it("returns ok=true with empty result for <mem>{}</mem>", () => {
    const r = parseSidecar("reply text\n<mem>{}</mem>", now);
    expect(r.found).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.result.entities).toHaveLength(0);
  });

  it("returns ok=false when JSON is malformed", () => {
    const r = parseSidecar("ok <mem>{not json}</mem>", now);
    expect(r.found).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("parses entities + metrics from a clean sidecar block", () => {
    const block = `<mem>${JSON.stringify({
      entities: [{ type: "person", canonicalName: "shadow", aliases: ["Shadow"] }],
      events: [{ type: "pr_change", ts: "2026-05-02T00:00:00Z" }],
      metrics: [{ ts: "2026-05-02T00:00:00Z", metric: "calories", value: 1800, unit: "kcal" }],
      preferences: [{ scope: "global", key: "user_rule", value: { text: "always test first" } }],
    })}</mem>`;
    const r = parseSidecar(`reply\n${block}`, now);
    expect(r.ok).toBe(true);
    expect(r.result.entities).toHaveLength(1);
    expect(r.result.entities[0].canonicalName).toBe("shadow");
    expect(r.result.metrics[0].value).toBe(1800);
    expect(r.result.events[0].type).toBe("pr_change");
    expect(r.result.preferences[0].scope).toBe("global");
  });

  it("falls back to defaults for missing optional fields", () => {
    const r = parseSidecar(
      `<mem>${JSON.stringify({ entities: [{ type: "person", name: "x" }] })}</mem>`,
      now,
    );
    expect(r.ok).toBe(true);
    expect(r.result.entities[0].confidence).toBeGreaterThan(0);
  });
});

describe("sidecar trigger logic", () => {
  it("triggers on explicit remember", () => {
    expect(
      shouldRequestSidecar(
        { userMessageChars: 5, hadWriteToolCall: false, hasNumericMention: false, hasExplicitRemember: true },
        {},
      ),
    ).toBe(true);
  });
  it("triggers on numeric mention", () => {
    expect(
      shouldRequestSidecar(
        { userMessageChars: 5, hadWriteToolCall: false, hasNumericMention: true, hasExplicitRemember: false },
        {},
      ),
    ).toBe(true);
  });
  it("triggers on write tool calls", () => {
    expect(
      shouldRequestSidecar(
        { userMessageChars: 5, hadWriteToolCall: true, hasNumericMention: false, hasExplicitRemember: false },
        {},
      ),
    ).toBe(true);
  });
  it("triggers on long user messages (default 50)", () => {
    expect(
      shouldRequestSidecar(
        { userMessageChars: 80, hadWriteToolCall: false, hasNumericMention: false, hasExplicitRemember: false },
        {},
      ),
    ).toBe(true);
  });
  it("does not trigger for short trivial chat", () => {
    expect(
      shouldRequestSidecar(
        { userMessageChars: 5, hadWriteToolCall: false, hasNumericMention: false, hasExplicitRemember: false },
        {},
      ),
    ).toBe(false);
  });
});

describe("merge extractor results", () => {
  it("dedups entities by (type, canonicalName)", () => {
    const det = extractAll({ text: "see openclaw/openclaw and @shadow", source: "session", now });
    const sidecar = parseSidecar(
      `<mem>${JSON.stringify({
        entities: [{ type: "person", canonicalName: "shadow", aliases: ["@shadow"] }],
      })}</mem>`,
      now,
    );
    const merged = mergeExtractorResults(sidecar.result, det);
    const peopleNames = merged.entities.filter((e) => e.type === "person").map((e) => e.canonicalName);
    expect(peopleNames.filter((n) => n === "shadow")).toHaveLength(1);
  });
});
