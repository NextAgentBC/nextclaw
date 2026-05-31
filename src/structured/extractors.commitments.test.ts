import { describe, expect, it } from "vitest";
import { extractAll } from "./extractors.js";

/**
 * Commitment extraction is the action-sensitive layer: tag directives the
 * agent might ACT on so a stale/low-authority remark can't trigger a real
 * side effect. Tested via the public extractAll() entry. Conservative defaults
 * + precision (no tagging of bare imperatives in reference text) are the point.
 */

const NOW = new Date("2026-05-31T12:00:00.000Z");
const run = (text: string, source = "session") =>
  extractAll({ text, source, now: NOW }).commitments;

describe("extractCommitments", () => {
  it("tags an addressed side-effecting directive as task, confirm-required", () => {
    const cs = run("帮我取消明天上午的牙医预约");
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: "task", safeToAct: false, requiresConfirmation: true });
  });

  it("tags an English 'please <verb>' directive as task", () => {
    const cs = run("Please cancel my newsletter subscription.");
    expect(cs[0]).toMatchObject({ kind: "task", requiresConfirmation: true });
  });

  it("treats a reminder as safe to act on, no confirmation", () => {
    const cs = run("提醒我周五下午三点上小龙虾课");
    expect(cs[0]).toMatchObject({ kind: "reminder", safeToAct: true, requiresConfirmation: false });
  });

  it("tags an authorization but still requires confirmation (conservative)", () => {
    const cs = run("你可以直接部署到生产环境");
    expect(cs[0]).toMatchObject({ kind: "authorization", safeToAct: false, requiresConfirmation: true });
  });

  it("does NOT tag a bare imperative in reference/tutorial text (precision)", () => {
    expect(run("Delete the old build artifacts and rerun the pipeline.")).toEqual([]);
    expect(run("删除旧文件然后重新构建项目")).toEqual([]);
    expect(run("今天温哥华天气不错，适合散步。")).toEqual([]);
  });

  it("derives authority from source: manual/session = user_direct, else inferred", () => {
    expect(run("帮我发送这封邮件", "manual")[0]).toMatchObject({ authority: "user_direct" });
    expect(run("帮我发送这封邮件", "session")[0]).toMatchObject({ authority: "user_direct" });
    expect(run("帮我发送这封邮件", "dream")[0]).toMatchObject({ authority: "inferred" });
  });

  it("emits at most one commitment per chunk (highest action-sensitivity wins)", () => {
    // Contains both a task verb (addressed) and a reminder cue; task dominates.
    const cs = run("提醒我，另外请你帮我取消那个订单");
    expect(cs).toHaveLength(1);
    expect(cs[0].kind).toBe("task");
  });
});
