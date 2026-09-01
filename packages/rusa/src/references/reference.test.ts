import { describe, expect, it } from "vitest";
import {
  asGitHubBranch,
  asGitHubIssue,
  githubBranchReference,
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
      "github:o/r/issues", // dangling collection with no id
      "gchat:spaces/AAAA/messages", // same
    ]) {
      expect(isReference(bad), bad).toBe(false);
    }
  });

  it("names a scheme's root partially, so parents round-trip", () => {
    // `referenceParent` walks a repository up to its owner, so the grammar has
    // to parse what it produces; an obligation may also be about a whole org.
    expect(parseReference("github:MEK-Org").key).toBe("github:MEK-Org");
    expect(isReference("github:MEK-Org")).toBe(true);
    expect(parseReference("gchat:spaces").key).toBe("gchat:spaces");
    expect(isReference("gchat:spaces")).toBe(true);
    expect(referenceParent(parseReference("gchat:spaces"))).toBeNull();
    // But a dangling collection is still nonsense at any depth.
    expect(isReference("github:MEK-Org/rusa/issues")).toBe(false);
    expect(isReference("gchat:spaces/AAAA/messages")).toBe(false);
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

  it("parses system scheme references", () => {
    const systemEvent = parseReference("system:events");
    expect(systemEvent.scheme).toBe("system");
    expect(systemEvent.key).toBe("system:events");
    expect(referenceParent(systemEvent)).toBeNull();

    const diskAlert = parseReference("system:events/alerts/disk");
    expect(referenceParent(diskAlert)?.key).toBe("system:events");
    expect(isDescendantOf(diskAlert, systemEvent)).toBe(true);
  });

  it("handles GitHub branch references and encoding", () => {
    expect(githubBranchReference("MEK-Org/rusa", "staging")).toBe(
      "github:MEK-Org/rusa/branches/staging"
    );
    expect(githubBranchReference("MEK-Org/rusa", "refs/heads/staging")).toBe(
      "github:MEK-Org/rusa/branches/staging"
    );
    expect(githubBranchReference("MEK-Org/rusa", "refs/heads/mc/0940705a/fix")).toBe(
      "github:MEK-Org/rusa/branches/mc%2F0940705a%2Ffix"
    );

    const branchRef = parseReference("github:MEK-Org/rusa/branches/mc%2F0940705a%2Ffix");
    expect(asGitHubBranch(branchRef)).toEqual({
      owner: "MEK-Org",
      repo: "rusa",
      branch: "mc/0940705a/fix",
    });
    expect(asGitHubBranch(parseReference("github:MEK-Org/rusa/branches/%"))).toBeNull();
    expect(referenceUrl(branchRef)).toBe(
      "https://github.com/MEK-Org/rusa/tree/mc%2F0940705a%2Ffix"
    );
    expect(referenceParent(branchRef)?.key).toBe("github:MEK-Org/rusa");
    expect(isDescendantOf(branchRef, parseReference("github:MEK-Org/rusa"))).toBe(true);
  });
});
