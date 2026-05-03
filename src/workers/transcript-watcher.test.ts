import { describe, expect, it } from "vitest";
import { extractMessageText, isPureQuestion } from "./transcript-watcher.js";

describe("extractMessageText", () => {
  it("returns text from user message", () => {
    expect(
      extractMessageText({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
    ).toBe("hello");
  });

  it("returns text from assistant message", () => {
    expect(
      extractMessageText({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
      }),
    ).toBe("hi back");
  });

  it("ignores tool result messages", () => {
    expect(
      extractMessageText({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "..." }] },
      }),
    ).toBeNull();
  });

  it("ignores toolCall content parts", () => {
    expect(
      extractMessageText({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }, { type: "text", text: "after the tool call" }],
        },
      }),
    ).toBe("after the tool call");
  });

  it("ignores non-message types", () => {
    expect(extractMessageText({ type: "trace.artifacts" })).toBeNull();
  });
});

describe("isPureQuestion", () => {
  it("flags Chinese 吗/呢 endings", () => {
    expect(isPureQuestion("你还好吗？")).toBe(true);
    expect(isPureQuestion("这是什么呢")).toBe(true);
  });

  it("flags Latin question marks", () => {
    expect(isPureQuestion("what is this?")).toBe(true);
    expect(isPureQuestion("how does it work?")).toBe(true);
  });

  it("does not flag a statement followed by a clarifying question", () => {
    expect(
      isPureQuestion("我们最近改了 memory plugin。打算下周发布。是这个时间吗？"),
    ).toBe(false);
  });

  it("does not flag multi-line messages", () => {
    expect(isPureQuestion("第一行陈述\n第二行问 what?")).toBe(false);
  });

  it("does not flag long messages even if ending with ?", () => {
    const long = "a ".repeat(120) + "really?";
    expect(isPureQuestion(long)).toBe(false);
  });

  it("flags interrogative leads without further sentences", () => {
    expect(isPureQuestion("怎么进入记忆")).toBe(true);
    expect(isPureQuestion("how to debug this")).toBe(true);
  });
});
