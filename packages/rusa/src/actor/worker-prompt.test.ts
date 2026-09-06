import { describe, expect, it } from "vitest";
import { signatureDiscipline } from "./worker-prompt.js";

// This covers the structured GitHub signing contract only; the root and worker
// prompt-assembly tombstones continue to exclude static prompt-prose tests.
describe("GitHub signature discipline", () => {
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
});
