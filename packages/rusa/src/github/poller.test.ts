import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { DbGitHubPollStateStore } from "../db/repositories/github-poll-state-repository.js";
import { InboxRepository } from "../db/repositories/inbox-repository.js";
import type {
  GitHubPollingIssueClient,
  IssueClient,
  PollIssueComment,
  PollIssueOrPullRequest,
} from "../gitops/issue-client.js";
import { GitBridgeIssueClient } from "../gitops/issue-client.js";
import { EventManager, type EventRoutingKernel } from "../runtime/event-manager.js";
import { parseDirectedDeliveryDirective } from "../webhook/directed-delivery.js";
import { deriveGitHubInboxNotification } from "./inbox-notification.js";
import { GitHubEventPoller } from "./poller.js";

class MockPollIssueClient implements Partial<GitHubPollingIssueClient> {
  issues: PollIssueOrPullRequest[] = [];
  comments: PollIssueComment[] = [];
  pollIssues = new Map<number, PollIssueOrPullRequest>();
  issueSinceCalls: string[] = [];
  commentSinceCalls: string[] = [];
  polledRepos: string[] = [];
  orgRepos = new Map<string, string[]>();
  branchHeads = new Map<string, string>();

  async listPollOrganizationRepositories(org: string): Promise<string[]> {
    return this.orgRepos.get(org) ?? [];
  }

  async getPollBranchHead(repo: string, branch: string): Promise<{ sha: string } | null> {
    const sha = this.branchHeads.get(`${repo}@${branch}`);
    return sha ? { sha } : null;
  }

  async listUpdatedIssuesAndPullRequests(
    _repo: string,
    since: string
  ): Promise<PollIssueOrPullRequest[]> {
    this.polledRepos.push(_repo);
    this.issueSinceCalls.push(since);
    return this.issues.filter((issue) => issue.updatedAt > since);
  }

  async listUpdatedIssueComments(_repo: string, since: string): Promise<PollIssueComment[]> {
    this.commentSinceCalls.push(since);
    return this.comments.filter((comment) => comment.updatedAt > since);
  }

  async getPollIssue(_repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    const issue = this.pollIssues.get(issueNumber);
    if (!issue) throw new Error(`missing issue ${issueNumber}`);
    return issue;
  }
}

describe("GitHubEventPoller", () => {
  // One migrated mesh.db per test. A "restart" below is a fresh poller over the
  // same database, which is exactly what a process restart is to this state.
  let db: Database.Database;
  let state: DbGitHubPollStateStore;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    state = new DbGitHubPollStateStore(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("polls explicit repositories plus organization repositories and suppresses exclusions", async () => {
    const client = new MockPollIssueClient();
    client.orgRepos.set("dummy-org", [
      "dummy-org/included",
      "dummy-org/excluded",
      "dummy-org/duplicate",
    ]);

    await new GitHubEventPoller({
      repos: ["dummy-org/duplicate", "other-org/explicit"],
      orgs: [{ org: "dummy-org", excludedRepos: ["dummy-org/excluded"] }],
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async () => undefined,
    }).pollOnce();

    expect(client.polledRepos).toEqual([
      "dummy-org/duplicate",
      "other-org/explicit",
      "dummy-org/included",
    ]);
  });

  it("emits a repo-scoped push when an explicit repository deploy branch advances", async () => {
    const client = new MockPollIssueClient();
    const branchKey = "example-org/service-repo@master";
    client.branchHeads.set(branchKey, "sha-before");
    const events: Array<{
      event: string;
      payload: Record<string, unknown>;
      deliveryId?: string;
    }> = [];
    const poller = new GitHubEventPoller({
      repos: ["example-org/service-repo"],
      deployBranch: "master",
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload, deliveryId) => {
        events.push({ event, payload, deliveryId });
      },
    });

    await poller.pollOnce();
    client.branchHeads.set(branchKey, "sha-after");
    await poller.pollOnce();

    expect(events).toEqual([
      {
        event: "push",
        payload: {
          before: "sha-before",
          after: "sha-after",
          repository: {
            full_name: "example-org/service-repo",
            name: "service-repo",
            owner: { login: "example-org" },
          },
        },
        deliveryId: "poll:example-org/service-repo:push:master:sha-after",
      },
    ]);
    expect(events[0].payload).not.toHaveProperty("ref");
    expect(deriveGitHubInboxNotification("push", events[0].payload)?.resource).toBe(
      "github:example-org/service-repo"
    );
  });

  it("maps a polled mesh:deliver issue comment to webhook-shaped payload", async () => {
    const client = new MockPollIssueClient();
    client.comments = [
      {
        id: 10,
        issueNumber: 42,
        author: "mock-bot",
        body: "done\n<!-- mesh:deliver worker-1 -->",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
    ];
    client.pollIssues.set(42, {
      number: 42,
      title: "Work item",
      body: "issue body",
      author: "someone",
      state: "open",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      isPullRequest: false,
      draft: false,
    });
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(events).toHaveLength(1);
    const [event, payload] = events[0];
    expect(event).toBe("issue_comment");
    expect(payload).toMatchObject({
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      sender: { login: "mock-bot" },
      comment: {
        id: 10,
        body: "done\n<!-- mesh:deliver worker-1 -->",
        user: { login: "mock-bot" },
      },
      issue: { number: 42, body: "issue body" },
    });
    expect(parseDirectedDeliveryDirective((payload.comment as { body: string }).body)).toBe(
      "worker-1"
    );
  });

  it("maps PR comments with issue.pull_request so routing treats them as PR resources", async () => {
    const client = new MockPollIssueClient();
    client.comments = [
      {
        id: 11,
        issueNumber: 7,
        author: "reviewer",
        body: "comment",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
    ];
    client.pollIssues.set(7, {
      number: 7,
      title: "PR",
      body: "pr issue wrapper",
      author: "author",
      state: "open",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      isPullRequest: true,
      draft: false,
    });
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(events[0][1]).toMatchObject({
      issue: { number: 7, pull_request: {} },
      sender: { login: "reviewer" },
    });
  });

  it("maps PR-backed issue records to pull_request events", async () => {
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 9,
        title: "Poller PR",
        body: "pr body\n<!-- mesh:deliver worker-2 -->",
        author: "mock-bot",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        isPullRequest: true,
        draft: false,
      },
      {
        number: 10,
        title: "Polled draft",
        body: "draft body",
        author: "mock-bot",
        state: "open",
        createdAt: "2026-07-03T00:02:00.000Z",
        updatedAt: "2026-07-03T00:02:00.000Z",
        isPullRequest: true,
        draft: true,
      },
    ];
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(events).toHaveLength(2);
    expect(events[0][0]).toBe("pull_request");
    expect(events[0][1]).toMatchObject({
      action: "edited",
      sender: { login: "mock-bot" },
      pull_request: {
        number: 9,
        body: "pr body\n<!-- mesh:deliver worker-2 -->",
        user: { login: "mock-bot" },
      },
    });
    // Draft state rides along so a polled draft opening is held exactly like
    // the webhook form.
    expect((events[0][1].pull_request as Record<string, unknown>).draft).toBe(false);
    expect(events[1][1]).toMatchObject({
      action: "opened",
      pull_request: { number: 10, draft: true },
    });
  });

  it("synthesizes ready_for_review when a polled draft PR later reports not-draft", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    const statePath = join(home, "poller-state.json");
    const draftRecord: PollIssueOrPullRequest = {
      number: 11,
      title: "Draft then ready",
      body: "body",
      author: "mock-bot",
      state: "open",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      isPullRequest: true,
      draft: true,
    };
    client.issues = [draftRecord];
    const events: Array<[string, Record<string, unknown>]> = [];
    const poller = (): GitHubEventPoller =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        home,
        statePath,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (event, payload) => {
          events.push([event, payload]);
        },
      });

    await poller().pollOnce();
    // The draft opening is held at the PR: opened, carrying draft.
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      action: "opened",
      pull_request: { number: 11, draft: true },
    });

    // The next poll sees the same PR no longer a draft. Polling reports state,
    // not transitions, so the remembered draft is what makes this the
    // ready_for_review that climbs to the repo owner rather than a plain edit.
    client.issues = [{ ...draftRecord, draft: false, updatedAt: "2026-07-03T00:05:00.000Z" }];
    await poller().pollOnce();
    expect(events).toHaveLength(2);
    expect(events[1][1]).toMatchObject({
      action: "ready_for_review",
      pull_request: { number: 11, draft: false },
    });
    expect(deriveGitHubInboxNotification(events[1][0], events[1][1])?.payload).toEqual({
      type: "pull_request.ready_for_review",
    });

    // Once ready, an ordinary later update is an edit again.
    client.issues = [{ ...draftRecord, draft: false, updatedAt: "2026-07-03T00:09:00.000Z" }];
    await poller().pollOnce();
    expect(events).toHaveLength(3);
    expect(events[2][1]).toMatchObject({ action: "edited" });
  });

  it("persists watermark and dedupes across restarts", async () => {
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 1,
        title: "One",
        body: "body",
        author: "author",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        isPullRequest: false,
        draft: false,
      },
    ];
    const events: Array<[string, Record<string, unknown>]> = [];
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        state,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (event, payload) => {
          events.push([event, payload]);
        },
      });

    await makePoller().pollOnce();
    await makePoller().pollOnce();

    expect(events).toHaveLength(1);
    expect(client.issueSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:01:00.000Z",
    ]);
    expect(client.commentSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ]);
    expect(state.getCursors("dummy-org/dummy-repo")).toEqual({
      issuesWatermark: "2026-07-03T00:01:00.000Z",
      commentsWatermark: "1970-01-01T00:00:00.000Z",
    });
  });

  it("tracks issue/PR and comment watermarks independently", async () => {
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 1,
        title: "One",
        body: "body",
        author: "author",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:10:00.000Z",
        isPullRequest: false,
        draft: false,
      },
    ];
    client.comments = [
      {
        id: 20,
        issueNumber: 1,
        author: "commenter",
        body: "late comment",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:05:00.000Z",
      },
    ];
    client.pollIssues.set(1, client.issues[0]);
    const events: Array<[string, Record<string, unknown>]> = [];
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        state,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (event, payload) => {
          events.push([event, payload]);
        },
      });

    await makePoller().pollOnce();
    await makePoller().pollOnce();

    expect(events.map(([event]) => event).sort()).toEqual(["issue_comment", "issues"]);
    expect(client.issueSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:10:00.000Z",
    ]);
    expect(client.commentSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:05:00.000Z",
    ]);
  });

  it("polls on the configured interval", async () => {
    vi.useFakeTimers();
    const client = new MockPollIssueClient();
    const poller = new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 12,
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async () => {},
    });

    poller.start();
    await Promise.resolve();
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.issueSinceCalls).toHaveLength(2);
    poller.close();
  });

  it("falls back to a 300s interval when none is supplied, instead of a hot loop ", async () => {
    vi.useFakeTimers();
    const client = new MockPollIssueClient();
    const poller = new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      // intervalSeconds deliberately absent — this is the config.yaml-omits-the-key
      // case. Before the fix it multiplied out to NaN, which setInterval coerces
      // to 0, so the assertions below would see hundreds of polls rather than one.
      state,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async () => {},
    });

    poller.start();
    await Promise.resolve();
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.issueSinceCalls).toHaveLength(2);
    poller.close();
  });

  it("forwards poll methods through a GitBridgeIssueClient delegate ", async () => {
    const delegate = new RecordingBridgeDelegate();
    delegate.comments = [
      {
        id: 30,
        issueNumber: 1218,
        author: "mock-bot",
        body: "ack",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    ];
    delegate.pollIssues.set(1218, {
      number: 1218,
      title: "Bridge poll regression",
      body: "body",
      author: "author",
      state: "open",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      isPullRequest: false,
      draft: false,
    });

    const bridgeClient = new GitBridgeIssueClient(delegate, { port: 9091 });
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      state,
      issueClient: bridgeClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(delegate.calls).toEqual([
      {
        method: "listUpdatedIssuesAndPullRequests",
        repo: "dummy-org/dummy-repo",
        since: "1970-01-01T00:00:00.000Z",
      },
      {
        method: "listUpdatedIssueComments",
        repo: "dummy-org/dummy-repo",
        since: "1970-01-01T00:00:00.000Z",
      },
      { method: "getPollIssue", repo: "dummy-org/dummy-repo", issueNumber: 1218 },
      { method: "getPollBranchHead", repo: "dummy-org/dummy-repo", branch: "master" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe("issue_comment");
  });

  it("re-emits an event whose delivery crashed before its position was written", async () => {
    // The write ordering under test: deliver, then record. A crash in between
    // must re-emit under the same delivery id next cycle rather than skip the
    // event, so the durable inbox — not the poller — is what makes it once-only.
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 1,
        title: "One",
        body: "body",
        author: "author",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        isPullRequest: false,
      },
    ];
    const deliveries: Array<string | undefined> = [];
    let crashNext = true;
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        state,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (_event, _payload, deliveryId) => {
          deliveries.push(deliveryId);
          if (crashNext) {
            crashNext = false;
            throw new Error("delivery crashed after the event left the poller");
          }
        },
      });

    await expect(makePoller().pollOnce()).rejects.toThrow(/delivery crashed/);
    // Nothing was recorded, so the next cycle still asks from the old position.
    expect(state.getCursors("dummy-org/dummy-repo")).toBeUndefined();

    await makePoller().pollOnce();
    await makePoller().pollOnce();

    expect(deliveries).toEqual([
      "poll:dummy-org/dummy-repo:issues:1:2026-07-03T00:01:00.000Z",
      "poll:dummy-org/dummy-repo:issues:1:2026-07-03T00:01:00.000Z",
    ]);
    expect(state.getCursors("dummy-org/dummy-repo")?.issuesWatermark).toBe(
      "2026-07-03T00:01:00.000Z"
    );
  });

  it("does not skip a batch-mate when a later delivery in the same batch crashes", async () => {
    // The hazard a per-event cursor advance would create: the endpoint answers
    // newest-first, and one of the events sharing the newest timestamp crashes
    // while a sibling at that same timestamp has not gone out yet. A cursor
    // moved after each delivery would sit at that timestamp with the sibling
    // undelivered, and only an inclusive `since` could ever return it. The
    // cursor moves once the batch is fully processed instead, so the next
    // cycle re-fetches the whole window and the seen keys suppress the repeats.
    const issue = (number: number, updatedAt: string) => ({
      number,
      title: `Issue ${number}`,
      body: "body",
      author: "author",
      state: "open" as const,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt,
      isPullRequest: false,
    });
    const client = new MockPollIssueClient();
    client.issues = [
      issue(3, "2026-07-03T00:10:00.000Z"),
      issue(2, "2026-07-03T00:10:00.000Z"),
      issue(1, "2026-07-03T00:01:00.000Z"),
    ];
    const delivered: number[] = [];
    let crashAfter = 1;
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        state,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (_event, payload) => {
          if (crashAfter-- === 0) throw new Error("crashed part-way through the batch");
          delivered.push((payload.issue as { number: number }).number);
        },
      });

    await expect(makePoller().pollOnce()).rejects.toThrow(/part-way through the batch/);
    // Oldest first, despite the newest-first response; and no window closed.
    expect(delivered).toEqual([1]);
    expect(state.getCursors("dummy-org/dummy-repo")).toEqual({
      issuesWatermark: "1970-01-01T00:00:00.000Z",
      commentsWatermark: "1970-01-01T00:00:00.000Z",
    });

    await makePoller().pollOnce();
    await makePoller().pollOnce();

    // Issue 3 crashed and issue 2 never got its turn; both are delivered on
    // the retry, each exactly once, and issue 1 is not delivered twice.
    expect(delivered).toEqual([1, 3, 2]);
    expect(client.issueSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:10:00.000Z",
    ]);
    expect(state.getCursors("dummy-org/dummy-repo")?.issuesWatermark).toBe(
      "2026-07-03T00:10:00.000Z"
    );
  });

  it("keeps a re-emitted delivery to a single durable inbox row", async () => {
    // End to end over one mesh.db: the poller's re-emission after a crash and
    // the inbox's idempotency key are the two halves of "no duplicate
    // deliveries", so they are exercised together rather than each in isolation.
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 1,
        title: "One",
        body: "body",
        author: "author",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        isPullRequest: false,
      },
    ];
    const inbox = new InboxRepository(db);
    const resolver: EventRoutingKernel = {
      resolveOwner: () => {
        throw new Error("poller ingress must not resolve ownership");
      },
      resolveRecipients: () => ({ directed: false, ownerIds: ["actor-gh"], subscriberIds: [] }),
    };
    const eventManager = new EventManager({ inboxStore: inbox, resolver });
    let crashNext = true;
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        state,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (event, payload, deliveryId) => {
          eventManager.handleExternalEvent({
            sourceType: "github",
            rawPayload: { event, payload },
            idempotencyKey: `github:${deliveryId}`,
          });
          if (crashNext) {
            crashNext = false;
            throw new Error("crashed after the inbox row was appended");
          }
        },
      });

    await expect(makePoller().pollOnce()).rejects.toThrow(/crashed after/);
    await makePoller().pollOnce();

    expect(inbox.list("actor-gh").entries).toHaveLength(1);
  });

  it("delivers a deploy-branch push exactly once across a restart, from the durable head", async () => {
    // Deleting the retired state file used to lose the previous head, and a
    // head learned for the first time never emits — so the push that landed
    // during the gap was dropped, not replayed. The head is durable now: a
    // restart mid-gap still reports `before` as the last head this mesh saw.
    const client = new MockPollIssueClient();
    const branchKey = "example-org/service-repo@master";
    client.branchHeads.set(branchKey, "sha-before");
    const events: Array<{ payload: Record<string, unknown>; deliveryId?: string }> = [];
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["example-org/service-repo"],
        deployBranch: "master",
        state,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (_event, payload, deliveryId) => {
          events.push({ payload, deliveryId });
        },
      });

    await makePoller().pollOnce();
    expect(state.getBranchHead("example-org/service-repo", "master")).toBe("sha-before");

    client.branchHeads.set(branchKey, "sha-after");
    await makePoller().pollOnce();
    await makePoller().pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ before: "sha-before", after: "sha-after" });
    expect(events[0].deliveryId).toBe("poll:example-org/service-repo:push:master:sha-after");
  });
});

class RecordingBridgeDelegate implements IssueClient, GitHubPollingIssueClient {
  calls: Array<
    | { method: "listPollOrganizationRepositories"; org: string }
    | { method: "getPollBranchHead"; repo: string; branch: string }
    | { method: "listUpdatedIssuesAndPullRequests"; repo: string; since: string }
    | { method: "listUpdatedIssueComments"; repo: string; since: string }
    | { method: "getPollIssue"; repo: string; issueNumber: number }
  > = [];
  comments: PollIssueComment[] = [];
  pollIssues = new Map<number, PollIssueOrPullRequest>();

  async listPollOrganizationRepositories(org: string): Promise<string[]> {
    this.calls.push({ method: "listPollOrganizationRepositories", org });
    return [];
  }

  async getPollBranchHead(repo: string, branch: string): Promise<null> {
    this.calls.push({ method: "getPollBranchHead", repo, branch });
    return null;
  }

  async listUpdatedIssuesAndPullRequests(
    repo: string,
    since: string
  ): Promise<PollIssueOrPullRequest[]> {
    this.calls.push({ method: "listUpdatedIssuesAndPullRequests", repo, since });
    return [];
  }

  async listUpdatedIssueComments(repo: string, since: string): Promise<PollIssueComment[]> {
    this.calls.push({ method: "listUpdatedIssueComments", repo, since });
    return this.comments;
  }

  async getPollIssue(repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    this.calls.push({ method: "getPollIssue", repo, issueNumber });
    const issue = this.pollIssues.get(issueNumber);
    if (!issue) throw new Error(`missing issue ${issueNumber}`);
    return issue;
  }

  // IssueClient stub surface: the bridge also delegates these, but this test
  // targets the poll methods that were previously missing.
  createPullRequest = notImplemented;
  createIssue = notImplemented;
  getOpenPullRequestsByAuthor = notImplemented;
  getOpenPullRequests = notImplemented;
  listIssues = notImplemented;
  getPullRequestDetails = notImplemented;
  getPullRequestChecksStatus = notImplemented;
  getIssue = notImplemented;
  listIssueComments = notImplemented;
  postComment = notImplemented;
  updateIssueBody = notImplemented;
  addLabel = notImplemented;
  removeLabel = notImplemented;
  closeIssue = notImplemented;
  reopenIssue = notImplemented;
  mergePullRequest = notImplemented;
  createPullRequestReview = notImplemented;
  createPrReviewComment = notImplemented;
  addReaction = notImplemented;
  addCommentReaction = notImplemented;
  getPrReviewComments = notImplemented;
  getPullRequestReview = notImplemented;
  getParentIssueNumber = notImplemented;
  getRootIssueNumber = notImplemented;
  hasSubIssues = notImplemented;
  addSubIssue = notImplemented;
  removeSubIssue = notImplemented;
}

function notImplemented(..._args: unknown[]): never {
  throw new Error("not implemented in test delegate");
}
