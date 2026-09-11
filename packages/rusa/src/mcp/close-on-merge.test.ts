import { describe, expect, it } from "vitest";
import { parseCloseOnMergeDirective } from "./close-on-merge.js";

describe("parseCloseOnMergeDirective", () => {
  it("returns absent when the body carries no directive", () => {
    expect(parseCloseOnMergeDirective("")).toEqual({ kind: "absent" });
    expect(parseCloseOnMergeDirective(null)).toEqual({ kind: "absent" });
    expect(parseCloseOnMergeDirective("Just a PR body.\n\nCloses #114")).toEqual({
      kind: "absent",
    });
  });

  it("parses a single exact issue reference", () => {
    expect(parseCloseOnMergeDirective("body\n\n<!-- mesh:close-on-merge #114 -->")).toEqual({
      kind: "close",
      issueNumbers: [114],
    });
  });

  it("parses several references in one directive, in order, deduplicated", () => {
    expect(parseCloseOnMergeDirective("<!-- mesh:close-on-merge #114 #9 #114 -->")).toEqual({
      kind: "close",
      issueNumbers: [114, 9],
    });
  });

  it("tolerates surrounding whitespace inside the comment only", () => {
    expect(parseCloseOnMergeDirective("<!--   mesh:close-on-merge   #114   -->")).toEqual({
      kind: "close",
      issueNumbers: [114],
    });
  });

  it("ignores visible closing-keyword prose entirely", () => {
    for (const body of [
      "Closes #114",
      "closes #114, fixes #9",
      "Resolves MEK-Org/rusa#114",
      "mesh:close-on-merge #114",
    ]) {
      expect(parseCloseOnMergeDirective(body), body).toEqual({ kind: "absent" });
    }
  });

  it("does not confuse other mesh directives for a close directive", () => {
    expect(
      parseCloseOnMergeDirective(
        "<!-- mesh:author:v3 actor instance 1 abcd -->\n<!-- mesh:deliver cloudy-porpoise -->"
      )
    ).toEqual({ kind: "absent" });
  });

  it("rejects malformed directives instead of closing anything", () => {
    for (const body of [
      "<!-- mesh:close-on-merge -->",
      "<!-- mesh:close-on-merge 114 -->",
      "<!-- mesh:close-on-merge #114, #9 -->",
      "<!-- mesh:close-on-merge #114 and #9 -->",
      "<!-- mesh:close-on-merge owner/repo#114 -->",
      "<!-- mesh:close-on-merge #0 -->",
      "<!-- mesh:close-on-merge #-1 -->",
      "<!-- mesh:close-on-merge #114 #abc -->",
      "<!-- mesh:close-on-merge #114\n-->",
      "<!-- mesh:close-on-merge #114",
      "<!-- mesh:close-on-merge #999999999999999999999 -->",
      "<!-- mesh:close-on-merge:v2 #114 -->",
      "<!-- MESH:CLOSE-ON-MERGE #114 -->",
    ]) {
      const parsed = parseCloseOnMergeDirective(body);
      expect(parsed.kind, body).toBe("malformed");
    }
  });

  it("rejects a body carrying more than one directive", () => {
    const parsed = parseCloseOnMergeDirective(
      "<!-- mesh:close-on-merge #114 -->\n\n<!-- mesh:close-on-merge #9 -->"
    );
    expect(parsed.kind).toBe("malformed");
  });

  it("fails closed for every HTML comment beginning with the reserved directive name", () => {
    for (const body of [
      "<!-- mesh:close-on-merge,#114 -->",
      "<!-- mesh:close-on-merge-legacy #114 -->",
      "<!-- mesh:close-on-merge #114 -->\n<!-- mesh:close-on-merge,#9 -->",
    ]) {
      expect(parseCloseOnMergeDirective(body).kind, body).toBe("malformed");
    }
  });

  it("ignores foreign HTML comments", () => {
    expect(parseCloseOnMergeDirective("<!-- other:close-on-merge #114 -->")).toEqual({
      kind: "absent",
    });
  });

  it("ignores literal directive examples in Markdown code", () => {
    for (const body of [
      "```html\n<!-- mesh:close-on-merge #114 -->\n```",
      "~~~html\n<!-- mesh:close-on-merge #114 -->\n~~~",
      "Use `<!-- mesh:close-on-merge #114 -->` in the PR body.",
    ]) {
      expect(parseCloseOnMergeDirective(body), body).toEqual({ kind: "absent" });
    }

    expect(
      parseCloseOnMergeDirective(
        "```html\n<!-- mesh:close-on-merge #114 -->\n```\n\n<!-- mesh:close-on-merge #9 -->"
      )
    ).toEqual({ kind: "close", issueNumbers: [9] });
  });

  it("executes only a directive that occupies its own top-level line", () => {
    for (const body of [
      "<!-- mesh:close-on-merge #114 -->",
      "<!-- mesh:close-on-merge #114 -->   ",
      "Ships it.\r\n\r\n<!-- mesh:close-on-merge #114 -->\r\n",
      "> quoted context\n<!-- mesh:close-on-merge #114 -->",
      "```html\n<!-- mesh:close-on-merge #9 -->\n```\n<!-- mesh:close-on-merge #114 -->\nTrailing prose.",
      "<!-- mesh:close-on-merge #114 -->\n<!-- mesh:author:v2 actor instance 1 abcd -->",
    ]) {
      expect(parseCloseOnMergeDirective(body), body).toEqual({
        kind: "close",
        issueNumbers: [114],
      });
    }
  });

  it("rejects a reserved-name comment that shares its line with anything else", () => {
    for (const body of [
      " <!-- mesh:close-on-merge #114 -->",
      "    <!-- mesh:close-on-merge #114 -->",
      "\t<!-- mesh:close-on-merge #114 -->",
      "See the note\n    <!-- mesh:close-on-merge #114 -->",
      "<!-- mesh:close-on-merge #114 --> ships it",
      "Ships it <!-- mesh:close-on-merge #114 -->",
      "<!-- mesh:close-on-merge #114 --><!-- mesh:author:v2 actor instance 1 abcd -->",
    ]) {
      expect(parseCloseOnMergeDirective(body), body).toEqual({
        kind: "malformed",
        reason: expect.stringContaining("own line"),
      });
    }
  });

  it("never executes a directive nested in a Markdown container", () => {
    const tildeInBlockquote = "> ~~~html\n> <!-- mesh:close-on-merge #114 -->\n> ~~~";
    expect(parseCloseOnMergeDirective(tildeInBlockquote)).toEqual({
      kind: "malformed",
      reason: expect.stringContaining("own line"),
    });
    for (const body of [
      "> ```html\n> <!-- mesh:close-on-merge #114 -->\n> ```",
      "- item\n\n  ~~~\n  <!-- mesh:close-on-merge #114 -->\n  ~~~",
    ]) {
      expect(parseCloseOnMergeDirective(body), body).toEqual({ kind: "absent" });
    }
    for (const body of [
      "> <!-- mesh:close-on-merge #114 -->",
      "- <!-- mesh:close-on-merge #114 -->",
      "1. <!-- mesh:close-on-merge #114 -->",
    ]) {
      expect(parseCloseOnMergeDirective(body).kind, body).toBe("malformed");
    }
    expect(
      parseCloseOnMergeDirective(`${tildeInBlockquote}\n\n<!-- mesh:close-on-merge #9 -->`).kind
    ).toBe("malformed");
  });

  it("rejects the whole body when a valid directive sits beside a malformed one", () => {
    const parsed = parseCloseOnMergeDirective(
      "<!-- mesh:close-on-merge #114 -->\n<!-- mesh:close-on-merge nope -->"
    );
    expect(parsed.kind).toBe("malformed");
  });

  it("explains what was malformed", () => {
    const parsed = parseCloseOnMergeDirective("<!-- mesh:close-on-merge 114 -->");
    expect(parsed).toEqual({
      kind: "malformed",
      reason: expect.stringContaining("<!-- mesh:close-on-merge 114 -->"),
    });
  });
});
