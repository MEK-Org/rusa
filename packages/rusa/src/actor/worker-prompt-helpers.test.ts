// Covers only the pure helpers of worker-prompt.ts — prompt prose itself is not asserted here (#179).
import { describe, expect, it } from "vitest";
import { resolveHandleLabels, summarizeCharter } from "./worker-prompt.js";

describe("summarizeCharter", () => {
  it("takes the first non-empty line", () => {
    expect(summarizeCharter("\n  Implement auth.  \nmore detail")).toBe("Implement auth.");
  });
  it("truncates long lines", () => {
    expect(summarizeCharter("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
  it("falls back when empty/undefined", () => {
    expect(summarizeCharter(undefined)).toBe("(no charter)");
    expect(summarizeCharter("   ")).toBe("(no charter)");
  });
});

describe("resolveHandleLabels", () => {
  it("uses the role when set, else the target's charter summary", () => {
    const charters: Record<string, string> = {
      "t-rev": "Review code for the auth subsystem.",
      "t-doc": "Write docs.",
    };
    const resolved = resolveHandleLabels(
      [{ id: "t-rev", role: "security reviewer" }, { id: "t-doc" }],
      (id) => charters[id]
    );
    expect(resolved).toEqual([
      { id: "t-rev", label: "security reviewer" }, // role overrides
      { id: "t-doc", label: "Write docs." }, // falls back to charter
    ]);
  });
});
