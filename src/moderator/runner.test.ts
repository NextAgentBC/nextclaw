import { describe, expect, it, vi } from "vitest";
import { buildDecisionPrompt } from "./decisions.js";
import { runOneCycle, applyDecisionToState, type ModeratorLlm } from "./runner.js";
import { newModeratorState, parseDecision } from "./types.js";

describe("parseDecision (defensive parser)", () => {
  it("returns ignore when input is not an object", () => {
    expect(parseDecision(null).decision.action).toBe("ignore");
    expect(parseDecision("string").decision.action).toBe("ignore");
    expect(parseDecision([1, 2]).decision.action).toBe("ignore");
  });

  it("returns ignore for unknown action", () => {
    const r = parseDecision({ action: "do_the_thing", rationale: "?" });
    expect(r.decision.action).toBe("ignore");
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("accepts a well-formed answer-direct decision", () => {
    const r = parseDecision({
      action: "answer-direct",
      rationale: "student asked a math question",
      answerTasks: [{
        taskId: "t1",
        roleKey: "math_tutor_grade5",
        taskPrompt: "explain 1/3 + 1/4",
        canParallel: true,
      }],
      telegramActions: [{ kind: "placeholder", taskId: "t1", text: "⏳..." }],
    });
    expect(r.decision.action).toBe("answer-direct");
    expect(r.decision.answerTasks?.length).toBe(1);
    expect(r.decision.answerTasks?.[0].roleKey).toBe("math_tutor_grade5");
    expect(r.errors.length).toBe(0);
  });

  it("drops malformed sub-objects but keeps the rest", () => {
    const r = parseDecision({
      action: "write-only",
      rationale: "user shared a fact",
      memoryWrites: [
        { text: "Yao 喜欢简洁回复", scope: "user", importance: 0.8 },     // ok
        { text: "no scope provided" },                                     // dropped (no scope)
        { scope: "user" },                                                 // dropped (no text)
        { text: "bad scope", scope: "everywhere" },                        // dropped (bad scope)
      ],
    });
    expect(r.decision.action).toBe("write-only");
    expect(r.decision.memoryWrites?.length).toBe(1);
    expect(r.decision.memoryWrites?.[0].importance).toBe(0.8);
  });

  it("captures escalation when reason + summary are both strings", () => {
    const r = parseDecision({
      action: "escalate",
      rationale: "user is frustrated",
      escalation: { reason: "stuck-on-topic", summary: "Mason 卡分数 15 分钟", pauseScope: true },
    });
    expect(r.decision.escalation?.pauseScope).toBe(true);
    expect(r.decision.escalation?.summary).toContain("Mason");
  });
});

describe("applyDecisionToState", () => {
  it("appends a message to recentMessages and updates activeStudents", () => {
    const s = newModeratorState("tg:chat:-100", "group", "-100");
    const m = {
      ts: "2026-05-16T20:00:00Z",
      fromUserId: "8064984663",
      fromLabel: "Yao",
      text: "怎么算 1/3 + 1/4",
      messageId: 42,
      isAddressed: true,
    };
    const out = applyDecisionToState(
      s,
      { kind: "message", message: m },
      { action: "answer-direct", rationale: "math q" },
    );
    expect(out.recentMessages.length).toBe(1);
    expect(out.recentMessages[0].text).toBe(m.text);
    expect(out.activeStudents.length).toBe(1);
    expect(out.activeStudents[0].userId).toBe("8064984663");
    expect(out.messagesSinceLastReview).toBe(1);
  });

  it("caps recentMessages at 50 entries (FIFO)", () => {
    let s = newModeratorState("tg:chat:-100", "group");
    for (let i = 0; i < 60; i += 1) {
      const m = {
        ts: `2026-05-16T20:${String(i % 60).padStart(2, "0")}:00Z`,
        fromUserId: `user-${i}`,
        text: `msg-${i}`,
      };
      s = applyDecisionToState(s, { kind: "message", message: m }, { action: "ignore", rationale: "" });
    }
    expect(s.recentMessages.length).toBe(50);
    expect(s.recentMessages[0].fromUserId).toBe("user-10"); // dropped 0-9
  });

  it("adds workers from decision.answerTasks", () => {
    const s = newModeratorState("tg:chat:-100", "group");
    const out = applyDecisionToState(
      s,
      { kind: "message", message: { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", text: "Q" } },
      {
        action: "answer-decompose",
        rationale: "two questions",
        answerTasks: [
          { taskId: "t1", roleKey: "math", taskPrompt: "P1" },
          { taskId: "t2", roleKey: "english", taskPrompt: "P2" },
        ],
      },
    );
    expect(out.activeWorkers.length).toBe(2);
    expect(out.activeWorkers.map((w) => w.roleKey)).toEqual(["math", "english"]);
    expect(out.activeWorkers.every((w) => w.status === "running")).toBe(true);
  });

  it("transitions a running worker to completed on worker-result trigger", () => {
    let s = newModeratorState("tg:chat:-100", "group");
    s = applyDecisionToState(
      s,
      { kind: "message", message: { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", text: "Q" } },
      { action: "answer-direct", rationale: "", answerTasks: [{ taskId: "t1", roleKey: "math", taskPrompt: "P" }] },
    );
    expect(s.activeWorkers[0].status).toBe("running");

    s = applyDecisionToState(
      s,
      { kind: "worker-result", taskId: "t1", result: "7/12", success: true },
      { action: "ignore", rationale: "result arrived" },
    );
    expect(s.activeWorkers[0].status).toBe("completed");
    expect(s.activeWorkers[0].result).toBe("7/12");
  });

  it("appends noteAppend to notes (cap 20)", () => {
    let s = newModeratorState("tg:chat:-100", "group");
    for (let i = 0; i < 25; i += 1) {
      s = applyDecisionToState(
        s,
        { kind: "cron", reason: "self-review" },
        { action: "ignore", rationale: "", noteAppend: `note-${i}` },
      );
    }
    expect(s.notes.length).toBe(20);
    expect(s.notes[0]).toBe("note-5");
  });
});

describe("buildDecisionPrompt", () => {
  it("serializes scope + recent messages + active workers", () => {
    let s = newModeratorState("tg:chat:-100", "group", "-100");
    s.activeTopic = "math.fractions";
    s.recentMessages = [
      { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", fromLabel: "Yao", text: "hi" },
      { ts: "2026-05-16T20:01:00Z", fromUserId: "u2", text: "怎么算 1/3" },
    ];
    s.activeWorkers = [
      { taskId: "t1", roleKey: "math", task: "...", startedAt: "now", status: "running" },
    ];
    const out = buildDecisionPrompt({
      state: s,
      trigger: {
        kind: "message",
        message: { ts: "2026-05-16T20:02:00Z", fromUserId: "u2", text: "@bot help me", isAddressed: true },
      },
      knownRoles: ["math_tutor_grade5", "english_tutor"],
    });
    expect(out.system).toContain("MODERATOR");
    expect(out.user).toContain("scopeKind: group");
    expect(out.user).toContain("activeTopic: math.fractions");
    expect(out.user).toContain("activeWorkers");
    expect(out.user).toContain("@bot help me");
    expect(out.user).toContain("@bot-mention");
    expect(out.user).toContain("math_tutor_grade5, english_tutor");
  });
});

describe("runOneCycle (mock LLM)", () => {
  function mockLlm(responseText: string): ModeratorLlm {
    return {
      call: vi.fn(async () => ({
        text: responseText,
        inputTokens: 100,
        outputTokens: 50,
        model: "openai/gpt-5.5",
        latencyMs: 2500,
      })),
    };
  }

  it("happy path: LLM returns valid JSON, state mutates correctly", async () => {
    const state = newModeratorState("tg:chat:-100", "group", "-100");
    const llm = mockLlm(JSON.stringify({
      action: "answer-direct",
      rationale: "math q",
      answerTasks: [{ taskId: "t1", roleKey: "math_tutor_grade5", taskPrompt: "explain 1/3 + 1/4" }],
      telegramActions: [{ kind: "placeholder", taskId: "t1", text: "⏳..." }],
    }));

    const out = await runOneCycle(state, {
      kind: "message",
      message: { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", text: "1/3 + 1/4 是多少", isAddressed: true },
    }, llm);

    expect(out.decision.action).toBe("answer-direct");
    expect(out.decision.answerTasks?.length).toBe(1);
    expect(out.parseErrors.length).toBe(0);
    expect(out.state.recentMessages.length).toBe(1);
    expect(out.state.activeWorkers.length).toBe(1);
    expect(out.llm.model).toBe("openai/gpt-5.5");
  });

  it("tolerates ```json``` code fences around the JSON", async () => {
    const state = newModeratorState("tg:chat:-100", "group");
    const llm = mockLlm("```json\n" + JSON.stringify({ action: "ignore", rationale: "chatter" }) + "\n```");
    const out = await runOneCycle(state, {
      kind: "message",
      message: { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", text: "lol" },
    }, llm);
    expect(out.decision.action).toBe("ignore");
    expect(out.parseErrors.length).toBe(0);
  });

  it("falls back to ignore on unparseable JSON; parseErrors captured", async () => {
    const state = newModeratorState("tg:chat:-100", "group");
    const llm = mockLlm("not json at all");
    const out = await runOneCycle(state, {
      kind: "message",
      message: { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", text: "Q" },
    }, llm);
    expect(out.decision.action).toBe("ignore");
    expect(out.parseErrors.length).toBeGreaterThan(0);
    // Even when LLM output is garbage, the message still lands in state.
    expect(out.state.recentMessages.length).toBe(1);
  });

  it("falls back to ignore on JSON with unknown action enum", async () => {
    const state = newModeratorState("tg:chat:-100", "group");
    const llm = mockLlm(JSON.stringify({ action: "make-coffee", rationale: "🤖" }));
    const out = await runOneCycle(state, {
      kind: "message",
      message: { ts: "2026-05-16T20:00:00Z", fromUserId: "u1", text: "Q" },
    }, llm);
    expect(out.decision.action).toBe("ignore");
    expect(out.parseErrors.some((e) => e.includes("unknown action"))).toBe(true);
  });
});
