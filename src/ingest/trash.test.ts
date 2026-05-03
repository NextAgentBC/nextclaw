import { describe, expect, it } from "vitest";
import { trashFilter } from "./trash.js";

describe("trash filter", () => {
  it("rejects empty / whitespace", () => {
    expect(trashFilter("")).toMatchObject({ ok: false, reason: "too_short" });
    expect(trashFilter("    \n\n")).toMatchObject({ ok: false, reason: "too_short" });
  });

  it("rejects boilerplate openings", () => {
    expect(trashFilter("I'll proceed with the change")).toMatchObject({
      ok: false,
      reason: "boilerplate",
    });
    expect(trashFilter("Let me help you with that")).toMatchObject({
      ok: false,
      reason: "boilerplate",
    });
    expect(trashFilter("Sure!")).toMatchObject({ ok: false, reason: "boilerplate" });
    expect(trashFilter("好,")).toMatchObject({ ok: false, reason: "boilerplate" });
  });

  it("rejects pure stack traces", () => {
    const trace = "    at runTest (src/foo.ts:42:5)";
    expect(trashFilter(trace)).toMatchObject({ ok: false, reason: "tool_output_only" });
  });

  it("rejects pure grep output", () => {
    const out = "src/a.ts:12:foo\nsrc/b.ts:34:bar\nsrc/c.ts:9:baz";
    expect(trashFilter(out)).toMatchObject({ ok: false, reason: "tool_output_only" });
  });

  it("rejects too-short content lacking verbs", () => {
    expect(trashFilter("123")).toMatchObject({ ok: false, reason: "too_short" });
  });

  it("accepts a real fact sentence", () => {
    expect(trashFilter("今天和 Shadow 改了 PR #1234，午饭吃了 1800 卡")).toEqual({ ok: true });
    expect(trashFilter("we shipped the auth fix on Tuesday")).toEqual({ ok: true });
  });
});
