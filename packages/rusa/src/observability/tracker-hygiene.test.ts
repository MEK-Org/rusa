import { describe, expect, it } from "vitest";
import type {
  IssueClient,
  IssueComment,
  OpenIssue,
  OpenPullRequest,
} from "../gitops/issue-client.js";
import { SYSTEM_TRACKER_HYGIENE, verifyAuthorStamp } from "../mcp/stamp.js";
import {
  containsSnoozeCommand,
  type MeshNotifier,
  planTrackerHygieneActions,
  runTrackerHygiene,
} from "./tracker-hygiene.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const REPO = "dummy-org/dummy-repo";

function issue(extra: Partial<OpenIssue> = {}): OpenIssue {
  return {
    number: 1,
    title: "Quiet issue",
    author: "operator",
    labels: ["owner:cloudy-porpoise"],
    state: "open",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...extra,
  };
}

function pr(extra: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 2,
    title: "Fix an issue",
    headRef: "mc/issue-1",
    headRefName: "mc/issue-1",
    htmlUrl: "https://example.test/pr/2",
    body: "Fixes #1",
    author: "bot",
    labels: ["owner:cloudy-porpoise"],
    updatedAt: "2026-07-09T00:00:00.000Z",
    issueNumber: 1,
    ...extra,
  };
}

function comment(extra: Partial<IssueComment> = {}): IssueComment {
  return {
    id: 1,
    author: "bot",
    body: "comment",
    createdAt: "2026-07-09T00:00:00.000Z",
    ...extra,
  };
}

describe("tracker hygiene planner", () => {
  it("surfaces unowned issues and PRs exactly once to the area steward", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [{ issue: issue({ labels: [] }), comments: [] }],
      pullRequests: [
        { pullRequest: pr({ number: 3, labels: [], issueNumber: null }), comments: [] },
      ],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "surface_unowned",
        number: 3,
        artifactKind: "pull_request",
        areaStewardHandle: "cloudy-porpoise",
      }),
      expect.objectContaining({
        kind: "surface_unowned",
        number: 1,
        artifactKind: "issue",
        areaStewardHandle: "cloudy-porpoise",
      }),
    ]);

    const repeated = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ labels: [] }),
          comments: [comment({ body: "<!-- rusa:owner-needed -->" })],
        },
      ],
      pullRequests: [],
    });
    expect(repeated).toEqual([]);
  });

  it("exempts bless PRs from ownership-needed ping", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [{ issue: issue({ number: 1, labels: [] }), comments: [] }],
      pullRequests: [
        {
          pullRequest: pr({
            number: 2,
            title: "Bless release v1.0.0",
            headRefName: "main",
            labels: [],
            issueNumber: null,
          }),
          comments: [],
        },
        {
          pullRequest: pr({
            number: 3,
            title: "Regular PR title",
            headRefName: "bless-release-v1.0.0",
            labels: [],
            issueNumber: null,
          }),
          comments: [],
        },
        {
          pullRequest: pr({
            number: 4,
            title: "Regular PR",
            headRefName: "mc/issue-1",
            labels: [],
            issueNumber: null,
          }),
          comments: [],
        },
      ],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "surface_unowned",
        number: 4,
        artifactKind: "pull_request",
      }),
      expect.objectContaining({
        kind: "surface_unowned",
        number: 1,
        artifactKind: "issue",
      }),
    ]);
  });

  it("does not stale-ping an issue while an open PR references it", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [{ issue: issue({ updatedAt: "2026-07-01T00:00:00.000Z" }), comments: [] }],
      pullRequests: [{ pullRequest: pr(), comments: [] }],
    });

    expect(actions).toEqual([]);
  });

  it("pings an owner-labeled quiet issue with no open PR", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [{ issue: issue({ updatedAt: "2026-07-09T00:00:00.000Z" }), comments: [] }],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "ping_stale_owner",
        number: 1,
        ownerHandle: "cloudy-porpoise",
        pingCount: 1,
        staleSince: "2026-07-09T00:00:00.000Z",
      }),
    ]);
  });

  it("backs off repeated stale pings and resets after a later non-automation comment", () => {
    const firstPing = comment({
      body: '<!-- rusa:stale-ping staleSince="2026-07-07T00:00:00.000Z" ping="1" -->',
      createdAt: "2026-07-08T00:00:00.000Z",
    });

    expect(
      planTrackerHygieneActions({
        repo: REPO,
        now: new Date("2026-07-08T12:00:00.000Z"),
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        issues: [{ issue: issue({ updatedAt: firstPing.createdAt }), comments: [firstPing] }],
        pullRequests: [],
      })
    ).toEqual([]);

    expect(
      planTrackerHygieneActions({
        repo: REPO,
        now: NOW,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        issues: [
          {
            issue: issue({ updatedAt: "2026-07-09T03:00:00.000Z" }),
            comments: [
              firstPing,
              comment({ body: "still live", createdAt: "2026-07-09T03:00:00.000Z" }),
            ],
          },
        ],
        pullRequests: [],
      })
    ).toEqual([
      expect.objectContaining({
        kind: "ping_stale_owner",
        pingCount: 1,
        staleSince: "2026-07-09T03:00:00.000Z",
      }),
    ]);
  });

  it("closes transparently after pings and a week of silence", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ updatedAt: "2026-07-09T00:00:00.000Z" }),
          comments: [
            comment({
              body: '<!-- rusa:stale-ping staleSince="2026-07-03T00:00:00.000Z" ping="1" -->',
              createdAt: "2026-07-04T00:00:00.000Z",
            }),
            comment({
              id: 2,
              body: '<!-- rusa:stale-ping staleSince="2026-07-03T00:00:00.000Z" ping="2" -->',
              createdAt: "2026-07-05T00:00:00.000Z",
            }),
          ],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "close_stale",
        pingCount: 2,
        staleSince: "2026-07-03T00:00:00.000Z",
      }),
    ]);
  });

  it("ignores spoofed owner-needed markers from non-automation comments", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ labels: [] }),
          comments: [
            comment({
              author: "human",
              body: "<!-- rusa:owner-needed -->",
            }),
          ],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "surface_unowned",
        number: 1,
      }),
    ]);
  });

  it("ignores spoofed stale markers from non-automation comments", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ updatedAt: "2026-07-09T00:00:00.000Z" }),
          comments: [
            comment({
              author: "human",
              body: '<!-- rusa:stale-ping staleSince="2026-07-03T00:00:00.000Z" ping="1" -->',
              createdAt: "2026-07-04T00:00:00.000Z",
            }),
          ],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "ping_stale_owner",
        pingCount: 1,
        staleSince: "2026-07-09T00:00:00.000Z",
      }),
    ]);
  });

  it("does not close when later owner activity appears after the first 100 comments", () => {
    const oldAutomationPing = comment({
      id: 1,
      body: '<!-- rusa:stale-ping staleSince="2026-07-03T00:00:00.000Z" ping="1" -->',
      createdAt: "2026-07-04T00:00:00.000Z",
    });
    const filler = Array.from({ length: 100 }, (_, index) =>
      comment({
        id: index + 2,
        author: "bot",
        body: "<!-- rusa:owner-needed -->",
        createdAt: "2026-07-04T01:00:00.000Z",
      })
    );
    const laterOwnerComment = comment({
      id: 200,
      author: "cloudy-porpoise",
      body: "still working this",
      createdAt: "2026-07-09T03:00:00.000Z",
    });

    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ updatedAt: "2026-07-09T00:00:00.000Z" }),
          comments: [oldAutomationPing, ...filler, laterOwnerComment],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "ping_stale_owner",
        pingCount: 1,
        staleSince: "2026-07-09T03:00:00.000Z",
      }),
    ]);
  });

  it("suppresses stale ping while an unexpired snooze marker is present", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ updatedAt: "2026-07-09T00:00:00.000Z" }),
          comments: [
            comment({
              body: '<!-- rusa:snooze until="2026-07-27T00:00:00.000Z" by="owner:cloudy-porpoise" -->',
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([]);
  });

  it("resumes stale ping with a snooze-lapsed note when the snooze marker is expired", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ updatedAt: "2026-07-03T13:00:00.000Z" }),
          comments: [
            comment({
              body: '<!-- rusa:stale-ping staleSince="2026-07-03T13:00:00.000Z" ping="1" -->',
              createdAt: "2026-07-04T13:00:00.000Z",
            }),
            comment({
              body: '<!-- rusa:snooze until="2026-07-05T00:00:00.000Z" by="owner:cloudy-porpoise" -->',
              createdAt: "2026-07-04T13:00:00.000Z",
            }),
          ],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "ping_stale_owner",
        pingCount: 2,
        staleSince: "2026-07-03T13:00:00.000Z",
        snoozeLapsed: true,
      }),
    ]);
  });

  it("ignores spoofed snooze markers from non-automation comments", () => {
    const actions = planTrackerHygieneActions({
      repo: REPO,
      now: NOW,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      issues: [
        {
          issue: issue({ updatedAt: "2026-07-09T00:00:00.000Z" }),
          comments: [
            comment({
              author: "human",
              body: '<!-- rusa:snooze until="2026-07-27T00:00:00.000Z" by="owner:cloudy-porpoise" -->',
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        },
      ],
      pullRequests: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        kind: "ping_stale_owner",
      }),
    ]);
  });
});

describe("tracker hygiene runner", () => {
  function clientFor(opts: {
    issues?: OpenIssue[];
    pullRequests?: OpenPullRequest[];
    comments?: IssueComment[];
    calls: string[];
  }): IssueClient {
    return {
      createIssue: async () => ({ number: 1, htmlUrl: "url" }),
      createPullRequest: async () => ({ number: 1, htmlUrl: "url" }),
      getOpenPullRequestsByAuthor: async () => [],
      getOpenPullRequests: async () => opts.pullRequests ?? [],
      listIssues: async () => opts.issues ?? [],
      getPullRequestDetails: async () => {
        throw new Error("unused");
      },
      getPullRequestChecksStatus: async () => ({
        state: "success",
        headSha: "head-sha",
        blocking: [],
      }),
      getIssue: async () => ({
        number: 1,
        title: "issue",
        body: "",
        state: "open",
        author: "operator",
      }),
      listIssueComments: async () => opts.comments ?? [],
      postComment: async (_repo, issueNumber, body) => {
        opts.calls.push(`comment:${issueNumber}:${body.split("\n")[1]}`);
      },
      updateIssueBody: async () => {},
      addLabel: async () => {},
      removeLabel: async () => {},
      closeIssue: async (_repo, issueNumber) => {
        opts.calls.push(`close:${issueNumber}`);
      },
      reopenIssue: async () => {},
      mergePullRequest: async () => "sha",
      createPullRequestReview: async () => undefined,
      addReaction: async () => {},
      addCommentReaction: async () => {},
      getPrReviewComments: async () => [],
      getParentIssueNumber: async () => null,
      getRootIssueNumber: async () => null,
      hasSubIssues: async () => false,
      addSubIssue: async () => {},
      removeSubIssue: async () => {},
    };
  }

  function notifier(calls: string[], overrides: Partial<MeshNotifier> = {}): MeshNotifier {
    return {
      resolveHandle: (handle) =>
        overrides.resolveHandle ? overrides.resolveHandle(handle) : `thread:${handle}`,
      sendMessage:
        overrides.sendMessage ??
        ((toId, body) => {
          calls.push(`mesh:${toId}:${body.split("\n")[0]}`);
          return { delivered: true };
        }),
    };
  }

  function closeReadyClient(calls: string[]): IssueClient {
    return {
      createIssue: async () => ({ number: 1, htmlUrl: "url" }),
      createPullRequest: async () => ({ number: 1, htmlUrl: "url" }),
      getOpenPullRequestsByAuthor: async () => [],
      getOpenPullRequests: async () => [],
      listIssues: async () => [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
      getPullRequestDetails: async () => {
        throw new Error("unused");
      },
      getPullRequestChecksStatus: async () => ({
        state: "success",
        headSha: "head-sha",
        blocking: [],
      }),
      getIssue: async () => ({
        number: 1,
        title: "issue",
        body: "",
        state: "open",
        author: "operator",
      }),
      listIssueComments: async () => [
        comment({
          body: '<!-- rusa:stale-ping staleSince="2026-07-03T00:00:00.000Z" ping="1" -->',
          createdAt: "2026-07-04T00:00:00.000Z",
        }),
      ],
      postComment: async (_repo, issueNumber, body) => {
        calls.push(`comment:${issueNumber}:${body.includes("Closed as stale")}`);
      },
      updateIssueBody: async () => {},
      addLabel: async () => {},
      removeLabel: async () => {},
      closeIssue: async (_repo, issueNumber) => {
        calls.push(`close:${issueNumber}`);
      },
      reopenIssue: async () => {},
      mergePullRequest: async () => "sha",
      createPullRequestReview: async () => undefined,
      addReaction: async () => {},
      addCommentReaction: async () => {},
      getPrReviewComments: async () => [],
      getParentIssueNumber: async () => null,
      getRootIssueNumber: async () => null,
      hasSubIssues: async () => false,
      addSubIssue: async () => {},
      removeSubIssue: async () => {},
    };
  }

  it("logs would-have-closed and does not close stale issues when closeAction is log", async () => {
    const calls: string[] = [];
    const logs: string[] = [];

    const actions = await runTrackerHygiene(closeReadyClient(calls), null, {
      repo: REPO,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      closeAction: "log",
      now: NOW,
      log: (message) => logs.push(message),
    });

    expect(actions.map((action) => action.kind)).toEqual(["close_stale"]);
    expect(calls).toEqual([]);
    expect(logs).toEqual([
      "would-have-closed #1 (an issue has no open PR and has been silent since 2026-07-03T00:00:00.000Z.) [+stale-close comment]",
    ]);
  });

  it("posts stale close comments before closing issues when closeAction is close", async () => {
    const calls: string[] = [];

    const actions = await runTrackerHygiene(closeReadyClient(calls), null, {
      repo: REPO,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      closeAction: "close",
      now: NOW,
    });

    expect(actions.map((action) => action.kind)).toEqual(["close_stale"]);
    expect(calls).toEqual(["comment:1:true", "close:1"]);
  });

  it("mesh-notifies the area steward for unowned artifacts after posting the audit comment", async () => {
    const calls: string[] = [];
    const actions = await runTrackerHygiene(
      clientFor({ calls, issues: [issue({ labels: [] })] }),
      notifier(calls),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(actions.map((action) => action.kind)).toEqual(["surface_unowned"]);
    expect(calls).toEqual([
      "comment:1:Ownership needed: this issue has no `owner:<handle>` label.",
      "mesh:thread:cloudy-porpoise:Tracker hygiene surface_unowned for dummy-org/dummy-repo#1",
    ]);
  });

  it("mesh-notifies stale owners after posting the stale ping comment", async () => {
    const calls: string[] = [];
    const actions = await runTrackerHygiene(
      clientFor({ calls, issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })] }),
      notifier(calls),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(actions.map((action) => action.kind)).toEqual(["ping_stale_owner"]);
    expect(calls).toEqual([
      "comment:1:Staleness check 1: owner:cloudy-porpoise, this issue has no open PR and has been quiet since 2026-07-09T00:00:00.000Z.",
      "mesh:thread:cloudy-porpoise:Tracker hygiene ping_stale_owner for dummy-org/dummy-repo#1",
    ]);
  });

  it("does not post or mesh-notify stale owners during an active snooze window", async () => {
    const calls: string[] = [];
    const actions = await runTrackerHygiene(
      clientFor({
        calls,
        issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
        comments: [
          comment({
            body: '<!-- rusa:snooze until="2026-07-24T12:00:00.000Z" by="owner:cloudy-porpoise" -->',
            createdAt: "2026-07-10T00:00:00.000Z",
          }),
        ],
      }),
      notifier(calls),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(actions).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("mesh-notifies stale owners for close actions when closeAction closes", async () => {
    const calls: string[] = [];
    const actions = await runTrackerHygiene(closeReadyClient(calls), notifier(calls), {
      repo: REPO,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      closeAction: "close",
      now: NOW,
    });

    expect(actions.map((action) => action.kind)).toEqual(["close_stale"]);
    expect(calls).toEqual([
      "comment:1:true",
      "mesh:thread:cloudy-porpoise:Tracker hygiene close_stale for dummy-org/dummy-repo#1",
      "close:1",
    ]);
  });

  it("surfaces unresolved and non-live mesh recipients without failing comment delivery", async () => {
    const unresolvedCalls: string[] = [];
    const unresolvedLogs: string[] = [];
    await runTrackerHygiene(
      clientFor({ calls: unresolvedCalls, issues: [issue({ labels: [] })] }),
      notifier(unresolvedCalls, { resolveHandle: () => null }),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
        log: (message) => unresolvedLogs.push(message),
      }
    );

    expect(unresolvedCalls).toEqual([
      "comment:1:Ownership needed: this issue has no `owner:<handle>` label.",
    ]);
    expect(unresolvedLogs).toEqual([
      "[tracker-hygiene] no live actor handle resolved for owner:cloudy-porpoise on dummy-org/dummy-repo#1",
    ]);

    const droppedCalls: string[] = [];
    const droppedLogs: string[] = [];
    await runTrackerHygiene(
      clientFor({
        calls: droppedCalls,
        issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
      }),
      notifier(droppedCalls, {
        sendMessage: () => ({ delivered: false, status: "retired" }),
      }),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
        log: (message) => droppedLogs.push(message),
      }
    );

    expect(droppedCalls).toEqual([
      "comment:1:Staleness check 1: owner:cloudy-porpoise, this issue has no open PR and has been quiet since 2026-07-09T00:00:00.000Z.",
    ]);
    expect(droppedLogs).toEqual([
      "[tracker-hygiene] mesh ping to owner:cloudy-porpoise (thread:cloudy-porpoise) for dummy-org/dummy-repo#1 was not delivered; status=retired",
    ]);
  });

  it("records a snooze marker from a human /snooze command", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const actions = await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
          comments: [
            comment({
              author: "AlabasterAxe",
              body: "/snooze 2w",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
      },
      notifier(calls),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(actions).toEqual([]);
    expect(bodies[0]).toContain(
      '<!-- rusa:snooze until="2026-07-24T12:00:00.000Z" by="AlabasterAxe" -->'
    );
    expect(bodies[0]).toContain("Snoozed until 2026-07-24T12:00:00.000Z by AlabasterAxe.");
  });

  it("records a snooze marker by owner:<handle> when the author holds the owner label", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
          comments: [
            comment({
              author: "cloudy-porpoise",
              body: "/snooze 2w",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(bodies[0]).toContain(
      '<!-- rusa:snooze until="2026-07-24T12:00:00.000Z" by="owner:cloudy-porpoise" -->'
    );
    expect(bodies[0]).toContain("Snoozed until 2026-07-24T12:00:00.000Z by owner:cloudy-porpoise.");
  });

  // Regression for ISSUE_NUM: every mesh actor posts GitHub comments under the shared
  // automation login (real authorship lives in the mesh:author stamp), so an
  // actor-issued /snooze arrives with author == automationAuthor. The old
  // login-keyed filter dropped it as "automation" and never applied the snooze —
  // the exact failure that let ISSUE_NUM's stale ping fire through a live /snooze.
  it("honors an actor-issued /snooze posted under the automation login and suppresses the stale ping ", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    // Durable store the mock persists into, so a later sweep sees the marker the
    // way a fresh listIssueComments from GitHub would.
    const stored: IssueComment[] = [
      comment({
        author: "bot", // shared automation login — an actor issued this command
        body: "/snooze 2w",
        createdAt: "2026-07-10T00:00:00.000Z",
      }),
    ];
    const client: IssueClient = {
      ...clientFor({ calls, issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })] }),
      listIssueComments: async () => [...stored],
      postComment: async (_repo, issueNumber, body) => {
        bodies.push(body);
        stored.push({ id: 100 + stored.length, author: "bot", body, createdAt: NOW.toISOString() });
        calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
      },
    };

    const opts = {
      repo: REPO,
      areaStewardHandle: "cloudy-porpoise",
      automationAuthor: "bot",
      now: NOW,
    };

    // Sweep 1: the command is parsed despite the automation login → marker written,
    // and the freshly recorded marker suppresses the ping in the same sweep.
    const first = await runTrackerHygiene(client, null, opts);
    expect(bodies[0]).toContain('<!-- rusa:snooze until="2026-07-24T12:00:00.000Z" by="bot" -->');
    expect(first.some((action) => action.kind === "ping_stale_owner")).toBe(false);

    // Sweep 2: the durable marker (also automation-login) still suppresses AND is
    // not itself re-parsed as a fresh command — exactly one acknowledgement total.
    const bodiesAfterFirst = bodies.length;
    const second = await runTrackerHygiene(client, null, opts);
    expect(second.some((action) => action.kind === "ping_stale_owner")).toBe(false);
    expect(bodies.length).toBe(bodiesAfterFirst);
  });

  it("caps a /snooze command at 30 days", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
          comments: [
            comment({
              author: "AlabasterAxe",
              body: "/snooze until 2026-09-10T00:00:00Z",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(bodies.length).toBe(1);
    const match = bodies[0].match(/until="([^"]+)"/);
    expect(match).not.toBeNull();
    const untilStr = match?.[1];
    if (!untilStr) throw new Error("snooze until missing");
    const until = new Date(untilStr);
    const maxUntil = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(until.getTime()).toBeLessThanOrEqual(maxUntil.getTime());
    expect(until.getTime()).toBe(maxUntil.getTime());
    expect(bodies[0]).toContain("exceeds the 30-day maximum");
  });

  it("replies with a parse-error marker for an invalid /snooze command", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ updatedAt: NOW.toISOString() })],
          comments: [
            comment({
              author: "AlabasterAxe",
              body: "/snooze until next tuesday",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("<!-- rusa:snooze-error");
    expect(bodies[0]).toContain("Could not parse `/snooze until next tuesday`");
    expect(bodies[0]).toContain("Accepted forms:");
  });

  it("does not re-post a snooze-error reply once one exists for the invalid command", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const existingError = comment({
      author: "bot",
      body: '<!-- rusa:snooze-error for="/snooze until next tuesday" -->\nCould not parse...',
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ updatedAt: NOW.toISOString() })],
          comments: [
            comment({
              author: "AlabasterAxe",
              body: "/snooze until next tuesday",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
            existingError,
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(bodies).toEqual([]);
  });

  it("replies with an unowned error marker for a /snooze command on an unowned issue", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const reactions: { commentId: number; reaction: string }[] = [];
    await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ labels: [], updatedAt: NOW.toISOString() })],
          comments: [
            comment({ body: "<!-- rusa:owner-needed -->" }),
            comment({
              id: 42,
              author: "AlabasterAxe",
              body: "/snooze 2w",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
        addCommentReaction: async (_repo, commentId, reaction) => {
          reactions.push({ commentId, reaction });
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("<!-- rusa:snooze-error");
    expect(bodies[0]).toContain("Cannot snooze an unowned issue");
    expect(bodies[0]).toContain("owner:<handle>");
    expect(reactions).toEqual([]);
  });

  it("does not re-post an unowned snooze-error reply once one exists for the command", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const existingError = comment({
      author: "bot",
      body: '<!-- rusa:snooze-error for="/snooze 2w" -->\nCannot snooze an unowned issue...',
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ labels: [], updatedAt: NOW.toISOString() })],
          comments: [
            comment({ body: "<!-- rusa:owner-needed -->" }),
            comment({
              author: "AlabasterAxe",
              body: "/snooze 2w",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
            existingError,
          ],
        }),
        postComment: async (_repo, issueNumber, body) => {
          bodies.push(body);
          calls.push(`comment:${issueNumber}:${body.split("\n")[0]}`);
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(bodies).toEqual([]);
  });

  it("ensures any comment matching containsSnoozeCommand produces exactly one acknowledgement from hygiene ", async () => {
    const scenarios = [
      {
        name: "owned issue + valid snooze",
        labels: ["owner:cloudy-porpoise"],
        command: "/snooze 2w",
        author: "AlabasterAxe",
        expectMarker: "<!-- rusa:snooze until=",
        expectReaction: true,
      },
      {
        name: "owned issue + invalid syntax",
        labels: ["owner:cloudy-porpoise"],
        command: "/snooze until next tuesday",
        author: "AlabasterAxe",
        expectMarker: '<!-- rusa:snooze-error for="/snooze until next tuesday"',
        expectReaction: false,
      },
      {
        name: "unowned issue + valid snooze",
        labels: [],
        command: "/snooze 2w",
        author: "AlabasterAxe",
        expectMarker: '<!-- rusa:snooze-error for="/snooze 2w"',
        expectReaction: false,
      },
      {
        name: "unowned issue + invalid syntax",
        labels: [],
        command: "/snooze until next tuesday",
        author: "AlabasterAxe",
        expectMarker: '<!-- rusa:snooze-error for="/snooze until next tuesday"',
        expectReaction: false,
      },
      {
        name: "unowned issue + actor-issued snooze under automation login ",
        labels: [],
        command: "/snooze 3d",
        author: "bot",
        expectMarker: '<!-- rusa:snooze-error for="/snooze 3d"',
        expectReaction: false,
      },
    ];

    for (const scenario of scenarios) {
      expect(containsSnoozeCommand(scenario.command)).toBe(true);

      const initialComments: IssueComment[] = [
        ...(scenario.labels.length === 0 ? [comment({ body: "<!-- rusa:owner-needed -->" })] : []),
        comment({
          id: 42,
          author: scenario.author,
          body: scenario.command,
          createdAt: "2026-07-10T00:00:00.000Z",
        }),
      ];
      const storedComments: IssueComment[] = [...initialComments];
      const postedBodies: string[] = [];
      const reactions: { commentId: number; reaction: string }[] = [];

      const client: IssueClient = {
        ...clientFor({
          calls: [],
          issues: [issue({ labels: scenario.labels, updatedAt: NOW.toISOString() })],
        }),
        listIssueComments: async () => [...storedComments],
        postComment: async (_repo, _issueNumber, body) => {
          postedBodies.push(body);
          storedComments.push({
            id: 100 + storedComments.length,
            author: "bot",
            body,
            createdAt: NOW.toISOString(),
          });
        },
        addCommentReaction: async (_repo, commentId, reaction) => {
          reactions.push({ commentId, reaction });
        },
      };

      const opts = {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      };

      // Sweep 1: Exactly one acknowledgement
      await runTrackerHygiene(client, null, opts);
      expect(
        postedBodies.length,
        `Scenario "${scenario.name}" should post exactly 1 comment on first sweep`
      ).toBe(1);
      expect(postedBodies[0]).toContain(scenario.expectMarker);
      if (scenario.expectReaction) {
        expect(reactions).toEqual([{ commentId: 42, reaction: "eyes" }]);
      } else {
        expect(reactions).toEqual([]);
      }

      // Sweep 2: Zero duplicate acknowledgements
      const bodiesAfterSweep1 = postedBodies.length;
      const reactionsAfterSweep1 = reactions.length;
      await runTrackerHygiene(client, null, opts);
      expect(
        postedBodies.length,
        `Scenario "${scenario.name}" should not post additional comments on second sweep`
      ).toBe(bodiesAfterSweep1);
      expect(
        reactions.length,
        `Scenario "${scenario.name}" should not add additional reactions on second sweep`
      ).toBe(reactionsAfterSweep1);
    }
  });

  it("emits the snooze receipt reaction only after the durable marker is posted", async () => {
    const timeline: { kind: "marker" | "receipt"; commentId?: number; reaction?: string }[] = [];
    const actions = await runTrackerHygiene(
      {
        ...clientFor({
          calls: [],
          issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
          comments: [
            comment({
              id: 42,
              author: "AlabasterAxe",
              body: "/snooze 2w",
              createdAt: "2026-07-10T00:00:00.000Z",
            }),
          ],
        }),
        postComment: async (_repo, _issueNumber, body) => {
          if (body.includes("<!-- rusa:snooze")) {
            timeline.push({ kind: "marker" });
          }
        },
        addCommentReaction: async (_repo, commentId, reaction) => {
          timeline.push({ kind: "receipt", commentId, reaction });
        },
      },
      null,
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      }
    );

    expect(actions).toEqual([]);
    expect(timeline).toEqual([
      { kind: "marker" },
      { kind: "receipt", commentId: 42, reaction: "eyes" },
    ]);
  });

  it("does not emit a snooze receipt reaction when the durable marker write fails", async () => {
    const reactions: { commentId: number; reaction: string }[] = [];
    const postedComments: string[] = [];
    const client: IssueClient = {
      ...clientFor({
        calls: [],
        issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
        comments: [
          comment({
            id: 42,
            author: "AlabasterAxe",
            body: "/snooze 2w",
            createdAt: "2026-07-10T00:00:00.000Z",
          }),
        ],
      }),
      postComment: async () => {
        postedComments.push("marker");
        throw new Error("GitHub API unavailable");
      },
      addCommentReaction: async (_repo, commentId, reaction) => {
        reactions.push({ commentId, reaction });
      },
    };

    await expect(
      runTrackerHygiene(client, null, {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
      })
    ).rejects.toThrow("GitHub API unavailable");

    expect(reactions).toEqual([]);
  });

  it("drops a ping for an issue that was closed after planning", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const actions = await runTrackerHygiene(
      {
        ...clientFor({
          calls,
          issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
        }),
        getIssue: async () => ({
          number: 1,
          title: "issue",
          body: "",
          state: "closed",
          author: "operator",
        }),
      },
      notifier(calls),
      {
        repo: REPO,
        areaStewardHandle: "cloudy-porpoise",
        automationAuthor: "bot",
        now: NOW,
        log: (message) => logs.push(message),
      }
    );

    expect(actions.map((action) => action.kind)).toEqual(["ping_stale_owner"]);
    expect(calls).toEqual([]);
    expect(logs).toEqual(["[tracker-hygiene] dropping ping_stale_owner#1: issue is closed"]);
  });

  describe("ISSUE_NUM stamping", () => {
    it("stamps posted comment bodies with a v2 stamp that resolves to system:tracker-hygiene", async () => {
      const calls: string[] = [];
      const bodies: string[] = [];
      await runTrackerHygiene(
        {
          ...clientFor({ calls, issues: [issue({ labels: [] })] }),
          postComment: async (_repo, issueNumber, body) => {
            bodies.push(body);
            calls.push(`comment:${issueNumber}`);
          },
        },
        null,
        {
          repo: REPO,
          areaStewardHandle: "cloudy-porpoise",
          automationAuthor: "bot",
          now: NOW,
          instanceId: "staging-instance",
        }
      );

      expect(bodies).toHaveLength(1);
      const verification = verifyAuthorStamp(bodies[0], REPO, 1);
      expect(verification.status).toBe("verified");
      expect(verification.actorId).toBe(SYSTEM_TRACKER_HYGIENE);
      expect(verification.instanceId).toBe("staging-instance");
    });

    it("stamps the stale-close comment and the snooze confirmation/error comments", async () => {
      // Stale-close path.
      const closeCalls: string[] = [];
      const closeBodies: string[] = [];
      await runTrackerHygiene(
        {
          ...closeReadyClient(closeCalls),
          postComment: async (_repo, issueNumber, body) => {
            closeBodies.push(body);
            closeCalls.push(`comment:${issueNumber}`);
          },
        },
        null,
        {
          repo: REPO,
          areaStewardHandle: "cloudy-porpoise",
          automationAuthor: "bot",
          closeAction: "close",
          now: NOW,
          instanceId: "staging-instance",
        }
      );
      expect(closeBodies).toHaveLength(1);
      expect(verifyAuthorStamp(closeBodies[0], REPO, 1).status).toBe("verified");

      // Snooze confirmation path.
      const snoozeCalls: string[] = [];
      const snoozeBodies: string[] = [];
      await runTrackerHygiene(
        {
          ...clientFor({
            calls: snoozeCalls,
            issues: [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
            comments: [
              comment({
                author: "AlabasterAxe",
                body: "/snooze 2w",
                createdAt: "2026-07-10T00:00:00.000Z",
              }),
            ],
          }),
          postComment: async (_repo, issueNumber, body) => {
            snoozeBodies.push(body);
            snoozeCalls.push(`comment:${issueNumber}`);
          },
        },
        null,
        {
          repo: REPO,
          areaStewardHandle: "cloudy-porpoise",
          automationAuthor: "bot",
          now: NOW,
          instanceId: "staging-instance",
        }
      );
      expect(snoozeBodies).toHaveLength(1);
      expect(verifyAuthorStamp(snoozeBodies[0], REPO, 1).status).toBe("verified");

      // Snooze error path on unowned issue.
      const unownedCalls: string[] = [];
      const unownedBodies: string[] = [];
      await runTrackerHygiene(
        {
          ...clientFor({
            calls: unownedCalls,
            issues: [issue({ labels: [], updatedAt: "2026-07-09T00:00:00.000Z" })],
            comments: [
              comment({ body: "<!-- rusa:owner-needed -->" }),
              comment({
                author: "AlabasterAxe",
                body: "/snooze 2w",
                createdAt: "2026-07-10T00:00:00.000Z",
              }),
            ],
          }),
          postComment: async (_repo, issueNumber, body) => {
            unownedBodies.push(body);
            unownedCalls.push(`comment:${issueNumber}`);
          },
        },
        null,
        {
          repo: REPO,
          areaStewardHandle: "cloudy-porpoise",
          automationAuthor: "bot",
          now: NOW,
          instanceId: "staging-instance",
        }
      );
      expect(unownedBodies).toHaveLength(1);
      expect(verifyAuthorStamp(unownedBodies[0], REPO, 1).status).toBe("verified");
    });
  });
});
