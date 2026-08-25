import { describe, expect, it } from "vitest";
import { speakableText } from "./tts-text.js";

describe("speakableText", () => {
  it("replaces fenced code blocks with a spoken marker", () => {
    const text = speakableText("Fixed it.\n```ts\nconst x = 1;\n```\nDeploying now.");
    expect(text).toBe("Fixed it. (code omitted) Deploying now.");
  });

  it("keeps link labels and drops URLs", () => {
    expect(speakableText("See [the PR](https://github.com/x/y/pull/1) for details")).toBe(
      "See the PR for details"
    );
    expect(speakableText("Docs at https://example.com/deep/path now")).toBe("Docs at (link) now");
  });

  it("strips inline code, headings, emphasis, and bullets", () => {
    const text = speakableText(
      "## Status\n- **Done**: the `voice` route\n- *Next*: tests\n> quoted note"
    );
    expect(text).toBe("Status Done: the voice route Next: tests quoted note");
  });

  it("collapses whitespace and trims", () => {
    expect(speakableText("a\n\n\n   b")).toBe("a b");
  });

  it("returns empty string for markdown-only input", () => {
    expect(speakableText("```\nonly code\n```")).toBe("(code omitted)");
    expect(speakableText("   \n\n")).toBe("");
  });
});
