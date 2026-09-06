import { describe, expect, it } from "vitest";
import { generateHandle } from "./handle-generator.js";
import { buildRootPrompt } from "./root-prompt.js";
import { buildWorkerPrompt, signatureDiscipline } from "./worker-prompt.js";

describe("GitHub run attribution", () => {
  it.each([
    [
      { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
      "*actor-handle (gpt-5.6-terra, xhigh)*",
      "This run launched as **gpt-5.6-terra** at **xhigh** effort.",
    ],
    [
      { provider: "codex", model: "gpt-5.6-terra" },
      "*actor-handle (gpt-5.6-terra)*",
      "This run launched as **gpt-5.6-terra** with no explicit effort.",
    ],
    [undefined, "*actor-handle*", "No model was resolved for this run; do not invent"],
    [{ provider: "codex" }, "*actor-handle*", "No model was resolved for this run; do not invent"],
  ])("renders %s without provider disclosure", (selected, signature, attribution) => {
    const rendered = signatureDiscipline("actor-handle", selected);

    expect(rendered).toContain(signature);
    expect(rendered).toContain(attribution);
    expect(rendered).not.toContain("codex");
  });

  it("renders the shared signature discipline in both root and worker prompts", () => {
    const selected = { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" };
    const workerId = "worker-attribution";
    const expectedWorkerSignature = `*${generateHandle(workerId)} (gpt-5.6-terra, xhigh)*`;

    expect(buildRootPrompt("root charter", "root-handle", undefined, selected)).toContain(
      "*root-handle (gpt-5.6-terra, xhigh)*"
    );
    expect(
      buildWorkerPrompt(
        "worker charter",
        { threadId: workerId, parentId: "parent-attribution" },
        undefined,
        selected
      )
    ).toContain(expectedWorkerSignature);
  });
});
