import { describe, expect, it } from "vitest";
import {
  asGitHubIssue,
  isDescendantOf,
  isReference,
  parseReference,
  referenceParent,
  referenceUrl,
} from "./reference.js";

describe("reference grammar", () => {
  it("parses each scheme into its canonical form", () => {
    for (const value of [
      "github:MEK-Org/rusa",
      "github:MEK-Org/rusa/issues/33",
      "github:MEK-Org/rusa/issues/33/comments/12345",
      "github:MEK-Org/rusa/pulls/76",
      "gchat:spaces/AAAA/messages/BBBB",
      "mesh:messages/abc-123",
      "mesh:actors/actor-1/inbox/entry-9",
    ]) {
      expect(parseReference(value).key).toBe(value);
      expect(isReference(value)).toBe(true);
    }
  });

  it("preserves owner and repo case", () => {
    // Folding would make a stored ref stop matching what a person wrote, and
    // the display case is what they recognise in a citation.
    expect(parseReference("github:MEK-Org/Rusa/issues/1").key).toBe("github:MEK-Org/Rusa/issues/1");
  });

  it("rejects a provider's HTML anchor rather than adopting it", () => {
    // GitHub addresses an issue comment only as `#issuecomment-N`. That wrinkle
    // stops at the boundary; here a comment is a path.
    expect(() => parseReference("github:o/r/issues/1#issuecomment-5")).toThrow(/'#'/);
  });

  it("rejects anything that would give one resource two spellings", () => {
    for (const bad of [
      "",
      "no-scheme",
      "carrier_pigeon:o/r",
      "github:",
      "github:o//r",
      "github:o/r/../x",
      "mesh: messages/1",
      "github:o", // a repo needs owner AND name
      "github:o/r/issues", // dangling collection with no id
      "gchat:spaces", // same
    ]) {
      expect(isReference(bad), bad).toBe(false);
    }
  });

  it("walks up by collection/id pairs", () => {
    // Walk the whole chain, asserting each rung, so a break says which one.
    let current = parseReference("github:MEK-Org/rusa/issues/33/comments/12345");
    const climbed: string[] = [];
    for (;;) {
      const parent = referenceParent(current);
      if (!parent) break;
      climbed.push(parent.key);
      current = parent;
    }
    expect(climbed).toEqual([
      "github:MEK-Org/rusa/issues/33",
      "github:MEK-Org/rusa",
      "github:MEK-Org",
    ]);

    expect(referenceParent(parseReference("gchat:spaces/A/messages/B"))?.key).toBe(
      "gchat:spaces/A"
    );
  });

  it("answers containment with a prefix test", () => {
    const repo = parseReference("github:MEK-Org/rusa");
    const issue = parseReference("github:MEK-Org/rusa/issues/33");
    const comment = parseReference("github:MEK-Org/rusa/issues/33/comments/1");
    const other = parseReference("github:MEK-Org/rusa-extras/issues/33");

    expect(isDescendantOf(issue, repo)).toBe(true);
    expect(isDescendantOf(comment, repo)).toBe(true);
    expect(isDescendantOf(comment, issue)).toBe(true);
    expect(isDescendantOf(repo, issue)).toBe(false);
    expect(isDescendantOf(repo, repo)).toBe(true);

    // Segment-wise, not string-prefix: `rusa-extras` does not live under `rusa`.
    expect(isDescendantOf(other, repo)).toBe(false);
    // Never across schemes.
    expect(isDescendantOf(parseReference("mesh:messages/1"), repo)).toBe(false);
  });

  it("reads a GitHub issue or pull request, and only those", () => {
    expect(asGitHubIssue(parseReference("github:o/r/issues/33"))).toEqual({
      owner: "o",
      repo: "r",
      collection: "issues",
      number: 33,
    });
    expect(asGitHubIssue(parseReference("github:o/r/pulls/76"))?.collection).toBe("pulls");

    for (const notAnIssue of [
      "github:o/r",
      "github:o/r/issues/33/comments/1",
      "github:o/r/branches/main",
      "mesh:messages/1",
    ]) {
      expect(asGitHubIssue(parseReference(notAnIssue)), notAnIssue).toBeNull();
    }
  });

  it("rejects an issue number that is not a positive safe integer", () => {
    expect(asGitHubIssue(parseReference("github:o/r/issues/0"))).toBeNull();
    expect(asGitHubIssue(parseReference("github:o/r/issues/007"))).toBeNull();
    expect(asGitHubIssue(parseReference("github:o/r/issues/9007199254740992"))).toBeNull();
  });

  it("projects back out to the provider's URL, wrinkles and all", () => {
    // The one place GitHub's inconsistencies are reconstructed: singular
    // `/pull/`, and a comment as an anchor on its parent.
    expect(referenceUrl(parseReference("github:MEK-Org/rusa/issues/33"))).toBe(
      "https://github.com/MEK-Org/rusa/issues/33"
    );
    expect(referenceUrl(parseReference("github:MEK-Org/rusa/pulls/76"))).toBe(
      "https://github.com/MEK-Org/rusa/pull/76"
    );
    expect(referenceUrl(parseReference("github:MEK-Org/rusa/issues/33/comments/12345"))).toBe(
      "https://github.com/MEK-Org/rusa/issues/33#issuecomment-12345"
    );
    expect(referenceUrl(parseReference("mesh:messages/1"))).toBeNull();
  });
});
