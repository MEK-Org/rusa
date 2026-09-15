import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_POLL_EPOCH } from "../../github/poll-state-store.js";
import { runMigrations } from "../migrations/runner.js";
import { DbGitHubPollStateStore } from "./github-poll-state-repository.js";

const REPO = "example-org/service-repo";

describe("DbGitHubPollStateStore", () => {
  let db: Database.Database;
  let store: DbGitHubPollStateStore;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    store = new DbGitHubPollStateStore(db, () => "2026-09-15T00:00:00.000Z");
  });

  afterEach(() => {
    db.close();
  });

  it("reports no cursors for a repository that has never been polled", () => {
    expect(store.getCursors(REPO)).toBeUndefined();
    expect(store.hasSeen(REPO, "issues:1:2026-07-03T00:01:00Z")).toBe(false);
    expect(store.getBranchHead(REPO, "master")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("records an emitted event and advances only its own stream's cursor, atomically", () => {
    store.recordEmitted(REPO, {
      key: "issues:1:2026-07-03T00:10:00Z",
      stream: "issues",
      updatedAt: "2026-07-03T00:10:00Z",
    });

    expect(store.hasSeen(REPO, "issues:1:2026-07-03T00:10:00Z")).toBe(true);
    expect(store.getCursors(REPO)).toEqual({
      issuesWatermark: "2026-07-03T00:10:00Z",
      commentsWatermark: GITHUB_POLL_EPOCH,
    });

    store.recordEmitted(REPO, {
      key: "issue_comment:20:2026-07-03T00:05:00Z",
      stream: "comments",
      updatedAt: "2026-07-03T00:05:00Z",
    });
    expect(store.getCursors(REPO)).toEqual({
      issuesWatermark: "2026-07-03T00:10:00Z",
      commentsWatermark: "2026-07-03T00:05:00Z",
    });
  });

  it("never rewinds a cursor when an older event is recorded after a newer one", () => {
    store.recordEmitted(REPO, {
      key: "issues:2:2026-07-03T00:10:00Z",
      stream: "issues",
      updatedAt: "2026-07-03T00:10:00Z",
    });
    store.recordEmitted(REPO, {
      key: "issues:1:2026-07-03T00:01:00Z",
      stream: "issues",
      updatedAt: "2026-07-03T00:01:00Z",
    });
    expect(store.getCursors(REPO)?.issuesWatermark).toBe("2026-07-03T00:10:00Z");
    expect(store.hasSeen(REPO, "issues:1:2026-07-03T00:01:00Z")).toBe(true);
  });

  it("is idempotent for a repeated key", () => {
    const event = {
      key: "pull_request:9:2026-07-03T00:01:00Z",
      stream: "issues" as const,
      updatedAt: "2026-07-03T00:01:00Z",
    };
    store.recordEmitted(REPO, event);
    store.recordEmitted(REPO, event);
    expect(store.list()[0]?.seen).toHaveLength(1);
  });

  it("prunes each stream's seen keys against its own cursor, keeping keys at the cursor", () => {
    // Issues cursor lands at 00:10; comments cursor at 00:05. GitHub's `since`
    // is inclusive, so a key exactly at its stream's cursor can be returned
    // again and must survive; anything strictly older cannot and must not.
    store.recordEmitted(REPO, {
      key: "issues:1:2026-07-03T00:01:00Z",
      stream: "issues",
      updatedAt: "2026-07-03T00:01:00Z",
    });
    store.recordEmitted(REPO, {
      key: "issues:2:2026-07-03T00:10:00Z",
      stream: "issues",
      updatedAt: "2026-07-03T00:10:00Z",
    });
    store.recordEmitted(REPO, {
      key: "issues:3:2026-07-03T00:10:00Z",
      stream: "issues",
      updatedAt: "2026-07-03T00:10:00Z",
    });
    store.recordEmitted(REPO, {
      key: "issue_comment:20:2026-07-03T00:05:00Z",
      stream: "comments",
      updatedAt: "2026-07-03T00:05:00Z",
    });
    // A comment older than the comments cursor but newer than nothing in the
    // issues stream: it must be judged by the comments cursor only.
    store.recordEmitted(REPO, {
      key: "issue_comment:19:2026-07-03T00:04:00Z",
      stream: "comments",
      updatedAt: "2026-07-03T00:04:00Z",
    });

    store.pruneSeen(REPO);

    expect(store.list()[0]?.seen.map((event) => event.key)).toEqual([
      "issue_comment:20:2026-07-03T00:05:00Z",
      "issues:2:2026-07-03T00:10:00Z",
      "issues:3:2026-07-03T00:10:00Z",
    ]);
  });

  it("prunes one repository without touching another", () => {
    const other = "example-org/other-repo";
    for (const repo of [REPO, other]) {
      store.recordEmitted(repo, {
        key: "issues:1:2026-07-03T00:01:00Z",
        stream: "issues",
        updatedAt: "2026-07-03T00:01:00Z",
      });
      store.recordEmitted(repo, {
        key: "issues:2:2026-07-03T00:10:00Z",
        stream: "issues",
        updatedAt: "2026-07-03T00:10:00Z",
      });
    }

    store.pruneSeen(REPO);

    const byRepo = Object.fromEntries(store.list().map((state) => [state.repo, state.seen.length]));
    expect(byRepo).toEqual({ [REPO]: 1, [other]: 2 });
  });

  it("records and replaces a branch head, creating the repository row on first use", () => {
    store.recordBranchHead(REPO, "master", "sha-before");
    expect(store.getBranchHead(REPO, "master")).toBe("sha-before");
    expect(store.getCursors(REPO)).toEqual({
      issuesWatermark: GITHUB_POLL_EPOCH,
      commentsWatermark: GITHUB_POLL_EPOCH,
    });

    store.recordBranchHead(REPO, "master", "sha-after");
    expect(store.getBranchHead(REPO, "master")).toBe("sha-after");
    expect(store.getBranchHead(REPO, "release")).toBeUndefined();
  });

  it("round-trips a whole repository through importRepo and list", () => {
    const state = {
      repo: REPO,
      issuesWatermark: "2026-07-03T00:10:00Z",
      commentsWatermark: "2026-07-03T00:05:00Z",
      seen: [
        {
          key: "issue_comment:20:2026-07-03T00:05:00Z",
          stream: "comments" as const,
          updatedAt: "2026-07-03T00:05:00Z",
        },
        {
          key: "issues:1:2026-07-03T00:10:00Z",
          stream: "issues" as const,
          updatedAt: "2026-07-03T00:10:00Z",
        },
      ],
      branchHeads: { master: "sha-before", release: "sha-release" },
    };

    store.importRepo(state);

    expect(store.list()).toEqual([state]);
    expect(store.getCursors(REPO)).toEqual({
      issuesWatermark: "2026-07-03T00:10:00Z",
      commentsWatermark: "2026-07-03T00:05:00Z",
    });
    expect(store.hasSeen(REPO, "issues:1:2026-07-03T00:10:00Z")).toBe(true);
    expect(store.getBranchHead(REPO, "release")).toBe("sha-release");
  });

  it("is visible to a second connection without a process-local cache", () => {
    // A second `Repositories`-style reader over the same file sees the committed
    // position; the poller and the dashboard must never disagree on it.
    const dir = mkdtempSync(join(tmpdir(), "rusa-poll-state-"));
    const writerDb = new Database(join(dir, "mesh.db"));
    runMigrations(writerDb);
    const readerDb = new Database(join(dir, "mesh.db"));
    try {
      const writer = new DbGitHubPollStateStore(writerDb);
      const reader = new DbGitHubPollStateStore(readerDb);
      writer.recordEmitted(REPO, {
        key: "issues:1:2026-07-03T00:10:00Z",
        stream: "issues",
        updatedAt: "2026-07-03T00:10:00Z",
      });
      expect(reader.getCursors(REPO)?.issuesWatermark).toBe("2026-07-03T00:10:00Z");
      expect(reader.hasSeen(REPO, "issues:1:2026-07-03T00:10:00Z")).toBe(true);
    } finally {
      readerDb.close();
      writerDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
