import { describe, expect, it } from "vitest";
import {
  assertObligationStatus,
  isTerminalObligationStatus,
  ObligationValidationError,
  parseExternalRef,
  validateEntityId,
} from "./obligation.js";

describe("parseExternalRef", () => {
  it("parses valid github_issue and github_pr refs", () => {
    expect(parseExternalRef("github_issue:dummy-org/dummy-repo#1666")).toEqual({
      kind: "github_issue",
      owner: "dummy-org",
      repo: "dummy-repo",
      number: 1666,
      key: "github_issue:dummy-org/dummy-repo#1666",
    });

    expect(parseExternalRef("github_pr:octocat/Hello-World#42")).toEqual({
      kind: "github_pr",
      owner: "octocat",
      repo: "Hello-World",
      number: 42,
      key: "github_pr:octocat/Hello-World#42",
    });
  });

  it("accepts owner and repo at exact GitHub maxima (39 and 100 characters)", () => {
    const maxOwner = "a".repeat(39);
    const maxRepo = "b".repeat(100);
    const ref = parseExternalRef(`github_issue:${maxOwner}/${maxRepo}#1`);

    expect(ref).toEqual({
      kind: "github_issue",
      owner: maxOwner,
      repo: maxRepo,
      number: 1,
      key: `github_issue:${maxOwner}/${maxRepo}#1`,
    });
    expect(ref.owner.length).toBe(39);
    expect(ref.repo.length).toBe(100);
  });

  it("rejects owner exceeding 39 characters", () => {
    const oversizedOwner = "a".repeat(40);
    expect(() => parseExternalRef(`github_issue:${oversizedOwner}/repo#1`)).toThrow(
      ObligationValidationError
    );
    expect(() => parseExternalRef(`github_issue:${oversizedOwner}/repo#1`)).toThrow(
      "external ref owner cannot exceed 39 characters"
    );
  });

  it("rejects repo exceeding 100 characters", () => {
    const oversizedRepo = "b".repeat(101);
    expect(() => parseExternalRef(`github_issue:owner/${oversizedRepo}#1`)).toThrow(
      ObligationValidationError
    );
    expect(() => parseExternalRef(`github_issue:owner/${oversizedRepo}#1`)).toThrow(
      "external ref repository cannot exceed 100 characters"
    );
  });

  it("rejects malformed refs and non-safe integer numbers", () => {
    expect(() => parseExternalRef("https://github.com/owner/repo/issues/1")).toThrow(
      ObligationValidationError
    );
    expect(() => parseExternalRef("github_issue:owner/repo#0")).toThrow(ObligationValidationError);
    expect(() => parseExternalRef("github_issue:owner/repo#9007199254740992")).toThrow(
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
