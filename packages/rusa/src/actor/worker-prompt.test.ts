import { describe, expect, it } from "vitest";
import { buildRootPrompt } from "./root-prompt.js";
import {
  buildWorkerPrompt,
  EXTERNAL_CONDUCT_POLICY,
  resolveHandleLabels,
  summarizeCharter,
} from "./worker-prompt.js";

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

describe("EXTERNAL_CONDUCT_POLICY ", () => {
  it("contains the stable heading and all ratified policy points", () => {
    expect(EXTERNAL_CONDUCT_POLICY).toContain("## Conduct on external systems");
    expect(EXTERNAL_CONDUCT_POLICY).toContain(
      "1. **Use only the access the system's designers intended you to have.**"
    );
    expect(EXTERNAL_CONDUCT_POLICY).toContain(
      "2. **Never mutate an account or resource that is not owned by this system or one of its human users.**"
    );
    expect(EXTERNAL_CONDUCT_POLICY).toContain(
      "3. **Never test a destructive or irreversible hypothesis against a live external system.**"
    );
    expect(EXTERNAL_CONDUCT_POLICY).toContain(
      "4. **When capability and intent diverge, escalate.**"
    );
    expect(EXTERNAL_CONDUCT_POLICY).toContain(
      "These norms bind even when they cost you the goal you were given."
    );
  });
});

describe("prompt assembly conduct policy injection ", () => {
  const dummyWorkerCtx = {
    threadId: "test-worker-id-12345678",
    parentId: "test-parent-id-87654321",
  };

  it("injects EXTERNAL_CONDUCT_POLICY into buildWorkerPrompt at assembly time", () => {
    const prompt = buildWorkerPrompt("custom worker task charter", dummyWorkerCtx);
    expect(prompt).toContain("git clone --recurse-submodules");
    expect(prompt).toContain("never `--single-branch` or `--depth`");
    expect(prompt).toContain("## Conduct on external systems");
    expect(prompt).toContain(EXTERNAL_CONDUCT_POLICY);
    expect(prompt.split("## Conduct on external systems").length - 1).toBe(1);
  });

  it("injects EXTERNAL_CONDUCT_POLICY into buildWorkerPrompt even with empty charter", () => {
    const prompt = buildWorkerPrompt("", dummyWorkerCtx);
    expect(prompt).toContain("## Conduct on external systems");
    expect(prompt).toContain(EXTERNAL_CONDUCT_POLICY);
    expect(prompt.split("## Conduct on external systems").length - 1).toBe(1);
  });

  it("injects EXTERNAL_CONDUCT_POLICY into buildRootPrompt with default charter", () => {
    const prompt = buildRootPrompt();
    expect(prompt).toContain("## Conduct on external systems");
    expect(prompt).toContain(EXTERNAL_CONDUCT_POLICY);
    expect(prompt.split("## Conduct on external systems").length - 1).toBe(1);
  });

  it("injects EXTERNAL_CONDUCT_POLICY into buildRootPrompt with custom charter", () => {
    const prompt = buildRootPrompt("custom root charter", "custom-root-handle");
    expect(prompt).toContain("## Conduct on external systems");
    expect(prompt).toContain(EXTERNAL_CONDUCT_POLICY);
    expect(prompt.split("## Conduct on external systems").length - 1).toBe(1);
  });

  it("ensures root and worker prompt paths share byte-identical conduct policy content", () => {
    const rootPrompt = buildRootPrompt();
    const workerPrompt = buildWorkerPrompt("worker charter", dummyWorkerCtx);
    expect(rootPrompt).toContain(EXTERNAL_CONDUCT_POLICY);
    expect(workerPrompt).toContain(EXTERNAL_CONDUCT_POLICY);
  });

  it("injects understanding mount notice into worker prompt when understandingMountEnabled is true", () => {
    const prompt = buildWorkerPrompt("worker charter", {
      ...dummyWorkerCtx,
      understandingMountEnabled: true,
    });
    expect(prompt).toContain(
      "A read-only snapshot of the integrated understanding is mounted at /tmp/understanding; grep and read it directly."
    );
  });

  it("omits understanding mount notice from worker prompt when understandingMountEnabled is false or undefined", () => {
    const prompt1 = buildWorkerPrompt("worker charter", {
      ...dummyWorkerCtx,
      understandingMountEnabled: false,
    });
    expect(prompt1).not.toContain("/tmp/understanding");

    const prompt2 = buildWorkerPrompt("worker charter", dummyWorkerCtx);
    expect(prompt2).not.toContain("/tmp/understanding");
  });

  it("never includes understanding mount notice in root prompt", () => {
    const prompt = buildRootPrompt();
    expect(prompt).not.toContain("/tmp/understanding");
  });
});
