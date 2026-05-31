import { describe, expect, it } from "vitest";
import { makeBuildPromptSection } from "./prompt-section.js";

const ALL_TOOLS = new Set([
  "memory_search",
  "memory_store",
  "memory_update",
  "memory_forget",
]);

describe("makeBuildPromptSection", () => {
  it("omits the sidecar block by default (emitSidecar=false)", () => {
    const build = makeBuildPromptSection({ emitSidecar: false });
    const text = build({ availableTools: ALL_TOOLS, citationsMode: "on" }).join("\n");
    expect(text).not.toContain("## Memory Sidecar");
    expect(text).not.toContain("<mem>");
    // The rest of the section is unaffected.
    expect(text).toContain("## Memory Recall (memory-postgres)");
    expect(text).toContain("memory_search");
    expect(text).toContain("## Memory Curation");
  });

  it("includes the sidecar block when emitSidecar=true", () => {
    const build = makeBuildPromptSection({ emitSidecar: true });
    const text = build({ availableTools: ALL_TOOLS, citationsMode: "on" }).join("\n");
    expect(text).toContain("## Memory Sidecar");
    expect(text).toContain("<mem>{\"entities\":[]");
  });

  it("returns nothing when no memory tools are available", () => {
    const build = makeBuildPromptSection({ emitSidecar: true });
    expect(build({ availableTools: new Set(), citationsMode: "on" })).toEqual([]);
  });

  it("honors citationsMode independently of the sidecar gate", () => {
    const build = makeBuildPromptSection({ emitSidecar: false });
    const off = build({ availableTools: ALL_TOOLS, citationsMode: "off" }).join("\n");
    expect(off).toContain("Citations are disabled");
    const on = build({ availableTools: ALL_TOOLS, citationsMode: "on" }).join("\n");
    expect(on).toContain("pg://<source>/<chunkId>");
  });
});
