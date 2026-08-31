import { describe, expect, it } from "vitest";
import { asGitHubIssue } from "../references/reference.js";
import {
  assertObligationStatus,
  isTerminalObligationStatus,
  ObligationValidationError,
  parseExternalRef,
  validateEntityId,
} from "./obligation.js";

describe("parseExternalRef", () => {
  it("parses an issue and a pull request into the one grammar", () => {
    const issue = parseExternalRef("github:dummy-org/dummy-repo/issues/1666");
    expect(issue.key).toBe("github:dummy-org/dummy-repo/issues/1666");
    expect(asGitHubIssue(issue)).toEqual({
      owner: "dummy-org",
      repo: "dummy-repo",
      collection: "issues",
      number: 1666,
    });

    const pull = parseExternalRef("github:octocat/Hello-World/pulls/42");
    expect(pull.key).toBe("github:octocat/Hello-World/pulls/42");
    expect(asGitHubIssue(pull)).toEqual({
      owner: "octocat",
      repo: "Hello-World",
      collection: "pulls",
      number: 42,
    });
  });

  it("refuses a comment as an identity claim", () => {
    // A comment is evidence *about* an issue, never the same thing as it — and
    // external_ref is unique per live obligation, which a comment cannot be.
    expect(() => parseExternalRef("github:dummy-org/dummy-repo/issues/1666/comments/9")).toThrow(
      "external ref must be"
    );
  });

  it("accepts owner and repo at exact GitHub maxima (39 and 100 characters)", () => {
    const maxOwner = "a".repeat(39);
    const maxRepo = "b".repeat(100);
    const ref = parseExternalRef(`github:${maxOwner}/${maxRepo}/issues/1`);

    expect(ref.key).toBe(`github:${maxOwner}/${maxRepo}/issues/1`);
    const issue = asGitHubIssue(ref);
    expect(issue).toEqual({
      owner: maxOwner,
      repo: maxRepo,
      collection: "issues",
      number: 1,
    });
  });

  it("rejects owner exceeding 39 characters", () => {
    const oversizedOwner = "a".repeat(40);
    expect(() => parseExternalRef(`github:${oversizedOwner}/repo/issues/1`)).toThrow(
      ObligationValidationError
    );
    expect(() => parseExternalRef(`github:${oversizedOwner}/repo/issues/1`)).toThrow(
      "external ref owner cannot exceed 39 characters"
    );
  });

  it("rejects repo exceeding 100 characters", () => {
    const oversizedRepo = "b".repeat(101);
    expect(() => parseExternalRef(`github:owner/${oversizedRepo}/issues/1`)).toThrow(
      ObligationValidationError
    );
    expect(() => parseExternalRef(`github:owner/${oversizedRepo}/issues/1`)).toThrow(
      "external ref repository cannot exceed 100 characters"
    );
  });

  it("rejects malformed refs and non-safe integer numbers", () => {
    expect(() => parseExternalRef("https://github.com/owner/repo/issues/1")).toThrow(
      ObligationValidationError
    );
    expect(() => parseExternalRef("github:owner/repo/issues/0")).toThrow(ObligationValidationError);
    expect(() => parseExternalRef("github:owner/repo/issues/9007199254740992")).toThrow(
      ObligationValidationError
    );
  });
});

describe("obligation entity and status helpers", () => {
  it("accepts every id in the mesh's one id space and rejects a blank one", () => {
    // Actor UUIDs, `root`, `human:*` and `system:*` all live in one space, and
    // the category is read off the prefix — there is no separate owner "kind".
    for (const id of [
      "actor-1",
      "root",
      "human:operator",
      "system:mesh",
      "system:tracker-hygiene",
    ]) {
      expect(validateEntityId(id)).toBe(id);
    }
    expect(() => validateEntityId("   ")).toThrow(ObligationValidationError);
    expect(() => validateEntityId("")).toThrow(ObligationValidationError);
  });

  it("identifies terminal obligation statuses and asserts valid statuses", () => {
    expect(isTerminalObligationStatus("done")).toBe(true);
    expect(isTerminalObligationStatus("cancelled")).toBe(true);
    expect(isTerminalObligationStatus("ready")).toBe(false);
    expect(isTerminalObligationStatus("waiting")).toBe(false);

    expect(() => assertObligationStatus("ready")).not.toThrow();
    expect(() => assertObligationStatus("invalid")).toThrow(ObligationValidationError);
  });
});
