import { describe, expect, it } from "vitest";
import { resourceKey } from "../actor/event-subscriptions.js";
import { checkSuiteWakesAnyone, deriveGitHubInboxNotification } from "./inbox-notification.js";

describe("deriveGitHubInboxNotification", () => {
  it("uses an issue source and keeps only the comment-specific identifier", () => {
    const notification = deriveGitHubInboxNotification("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      issue: { number: 903, title: "not cached" },
      comment: { id: 4959289232, body: "not cached" },
      sender: { login: "not cached" },
    });

    if (!notification) throw new Error("notification not derived");
    expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/issues/903");
    expect(notification.payload).toEqual({
      type: "issue_comment.created",
      commentId: 4959289232,
    });
  });

  it("canonicalizes a PR conversation issue_comment to the delegated PR resource", () => {
    const notification = deriveGitHubInboxNotification("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      issue: { number: 910, pull_request: {} },
      comment: { id: 4960049260 },
    });

    if (!notification) throw new Error("notification not derived");
    expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/pulls/910");
    expect(notification.payload).toEqual({
      type: "issue_comment.created",
      commentId: 4960049260,
    });
  });

  it("keeps the PR identifier without copying PR content", () => {
    const notification = deriveGitHubInboxNotification("pull_request", {
      action: "synchronize",
      repository: { full_name: "dummy-org/dummy-repo" },
      pull_request: { number: 910, title: "not cached" },
    });

    if (!notification) throw new Error("notification not derived");
    expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/pulls/910");
    expect(notification.payload).toEqual({ type: "pull_request.synchronize" });
  });

  it("keeps only the merged discriminator needed by pull_request.closed bubbling", () => {
    const notification = deriveGitHubInboxNotification("pull_request", {
      action: "closed",
      repository: { full_name: "dummy-org/dummy-repo" },
      pull_request: { number: 910, merged: true, title: "not cached" },
    });

    if (!notification) throw new Error("notification not derived");
    expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/pulls/910");
    expect(notification.payload).toEqual({ type: "pull_request.closed", merged: true });
  });

  it("does not copy push content into the inbox payload", () => {
    const notification = deriveGitHubInboxNotification("push", {
      repository: { full_name: "dummy-org/dummy-repo" },
      ref: "refs/heads/staging",
      after: "abcdef",
      commits: [{ message: "not cached" }],
    });

    if (!notification) throw new Error("notification not derived");
    expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/branches/staging");
    expect(notification.payload).toEqual({ type: "push" });
  });

  it("routes push to github_repo when ref is missing", () => {
    const notification = deriveGitHubInboxNotification("push", {
      repository: { full_name: "dummy-org/dummy-repo" },
      after: "abcdef",
      commits: [{ message: "not cached" }],
    });

    if (!notification) throw new Error("notification not derived");
    expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo");
    expect(notification.payload).toEqual({ type: "push" });
  });

  it("routes branch create/delete events to their fully-qualified branch source", () => {
    for (const event of ["create", "delete"]) {
      const notification = deriveGitHubInboxNotification(event, {
        repository: { full_name: "dummy-org/dummy-repo" },
        ref_type: "branch",
        ref: "worker",
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe(
        "github:dummy-org/dummy-repo/branches/worker"
      );
      expect(notification.payload).toEqual({ type: event });
    }
  });

  describe("check_suite and check_run routing", () => {
    it("routes check_suite with pull_requests present to github_pr", () => {
      const notification = deriveGitHubInboxNotification("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: {
          id: 101,
          head_branch: "feature-branch",
          pull_requests: [{ number: 1593 }],
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/pulls/1593");
      expect(notification.payload).toEqual({ type: "check_suite.completed" });
    });

    it("routes check_suite with head_branch present (no PR) to github_branch", () => {
      const notification = deriveGitHubInboxNotification("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: {
          id: 102,
          head_branch: "staging",
          pull_requests: [],
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe(
        "github:dummy-org/dummy-repo/branches/staging"
      );
      expect(notification.payload).toEqual({ type: "check_suite.completed" });
    });

    it("routes check_suite with fully qualified head_branch to github_branch", () => {
      const notification = deriveGitHubInboxNotification("check_suite", {
        action: "rerequested",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: {
          id: 103,
          head_branch: "refs/heads/mc/0940705a/fix",
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe(
        "github:dummy-org/dummy-repo/branches/mc%2F0940705a%2Ffix"
      );
      expect(notification.payload).toEqual({ type: "check_suite.rerequested" });
    });

    it("routes check_suite fallback to github_repo when neither PR nor branch is present", () => {
      const notification = deriveGitHubInboxNotification("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: { id: 104 },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo");
      expect(notification.payload).toEqual({ type: "check_suite.completed" });
    });

    it("routes check_run with direct pull_requests present to github_pr", () => {
      const notification = deriveGitHubInboxNotification("check_run", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: {
          id: 201,
          pull_requests: [{ number: 1593 }],
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/pulls/1593");
      expect(notification.payload).toEqual({ type: "check_run.completed" });
    });

    it("routes check_run with check_suite.pull_requests present to github_pr", () => {
      const notification = deriveGitHubInboxNotification("check_run", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: {
          id: 202,
          pull_requests: [],
          check_suite: {
            pull_requests: [{ number: 1593 }],
          },
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo/pulls/1593");
      expect(notification.payload).toEqual({ type: "check_run.completed" });
    });

    it("routes check_run with direct head_branch present (no PR) to github_branch", () => {
      const notification = deriveGitHubInboxNotification("check_run", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: {
          id: 203,
          head_branch: "staging",
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe(
        "github:dummy-org/dummy-repo/branches/staging"
      );
      expect(notification.payload).toEqual({ type: "check_run.completed" });
    });

    it("routes check_run with check_suite.head_branch present (no PR) to github_branch", () => {
      const notification = deriveGitHubInboxNotification("check_run", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: {
          id: 204,
          check_suite: {
            head_branch: "feature-branch",
          },
        },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe(
        "github:dummy-org/dummy-repo/branches/feature-branch"
      );
      expect(notification.payload).toEqual({ type: "check_run.completed" });
    });

    it("routes check_run fallback to github_repo when neither PR nor branch is present", () => {
      const notification = deriveGitHubInboxNotification("check_run", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: { id: 205 },
      });

      if (!notification) throw new Error("notification not derived");
      expect(resourceKey(notification.resource)).toBe("github:dummy-org/dummy-repo");
      expect(notification.payload).toEqual({ type: "check_run.completed" });
    });

    it("derives type correctly when action is omitted for check_suite and check_run", () => {
      const notificationSuite = deriveGitHubInboxNotification("check_suite", {
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: { id: 206 },
      });
      const notificationRun = deriveGitHubInboxNotification("check_run", {
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: { id: 207 },
      });

      if (!notificationSuite || !notificationRun) throw new Error("notifications not derived");
      expect(notificationSuite.payload).toEqual({ type: "check_suite" });
      expect(notificationRun.payload).toEqual({ type: "check_run" });
    });
  });
});

describe("checkSuiteWakesAnyone", () => {
  const suite = (conclusion: unknown): Record<string, unknown> => ({
    action: "completed",
    repository: { full_name: "dummy-org/dummy-repo" },
    check_suite: { id: 456, conclusion },
  });

  it("stays quiet for a suite that concluded with nothing to do", () => {
    expect(checkSuiteWakesAnyone(suite("success"))).toBe(false);
    expect(checkSuiteWakesAnyone(suite("neutral"))).toBe(false);
    expect(checkSuiteWakesAnyone(suite("skipped"))).toBe(false);
  });

  it("stays quiet for a superseded suite, because its replacement will report", () => {
    expect(checkSuiteWakesAnyone(suite("cancelled"))).toBe(false);
    expect(checkSuiteWakesAnyone(suite("stale"))).toBe(false);
  });

  it("wakes for every conclusion that leaves somebody with work", () => {
    expect(checkSuiteWakesAnyone(suite("failure"))).toBe(true);
    expect(checkSuiteWakesAnyone(suite("timed_out"))).toBe(true);
    expect(checkSuiteWakesAnyone(suite("action_required"))).toBe(true);
    expect(checkSuiteWakesAnyone(suite("startup_failure"))).toBe(true);
  });

  it("wakes when it cannot read the conclusion at all", () => {
    // The failure mode worth avoiding is a red suite nobody hears about, so an
    // unrecognised or missing conclusion is delivered rather than dropped.
    expect(checkSuiteWakesAnyone(suite("some_new_github_conclusion"))).toBe(true);
    expect(checkSuiteWakesAnyone(suite(null))).toBe(true);
    expect(checkSuiteWakesAnyone(suite(undefined))).toBe(true);
    expect(checkSuiteWakesAnyone({ action: "completed" })).toBe(true);
  });

  it("does not confuse a conclusion with the in-progress status that precedes it", () => {
    // `check_suite.requested` and `.rerequested` carry a null conclusion; they
    // are filtered by action upstream, and this predicate must not silence them.
    expect(
      checkSuiteWakesAnyone({
        action: "requested",
        check_suite: { id: 456, status: "queued", conclusion: null },
      })
    ).toBe(true);
  });
});
