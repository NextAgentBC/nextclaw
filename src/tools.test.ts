import { describe, expect, it } from "vitest";
import { agentIdFromSessionKey } from "./tools.js";

describe("agentIdFromSessionKey (fail-closed isolation parser)", () => {
  it("parses the canonical 3-segment shape", () => {
    expect(agentIdFromSessionKey("agent:main:session-abc")).toBe("main");
    expect(agentIdFromSessionKey("agent:club:session-xyz")).toBe("club");
  });

  it("parses extended session keys with channel suffix", () => {
    // Channel-scoped keys still carry the agent id as segment 2; anything after
    // is opaque to the parser.
    expect(
      agentIdFromSessionKey("agent:main:telegram:direct:8064984663"),
    ).toBe("main");
  });

  it("returns 'main' when sessionKey is undefined or empty (manual scripts, doctor)", () => {
    expect(agentIdFromSessionKey(undefined)).toBe("main");
    expect(agentIdFromSessionKey("")).toBe("main");
  });

  it("THROWS when given a present-but-unrecognised sessionKey (fail-closed)", () => {
    // Catches the regression case: upstream openclaw release changes the key
    // shape (e.g. adds a 'session:' prefix), and the old parser would silently
    // collapse every agent into 'main'. We refuse rather than leak.
    expect(() => agentIdFromSessionKey("session:abc")).toThrow(/sessionKey/);
    expect(() => agentIdFromSessionKey("main")).toThrow(/sessionKey/);
    expect(() => agentIdFromSessionKey("agent:")).toThrow(/sessionKey/);
    expect(() => agentIdFromSessionKey("agent")).toThrow(/sessionKey/);
  });

  it("error message names the offending key so the regression is debuggable", () => {
    try {
      agentIdFromSessionKey("session:weird");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("session:weird");
      expect((err as Error).message).toContain("memory-postgres");
    }
  });
});
