import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_POLL_EPOCH } from "../github/poll-state-store.js";
import {
  applyLegacyGitHubPollStateImport,
  GITHUB_POLL_STATE_FILENAME,
  GITHUB_POLL_STATE_IMPORT_SOURCE,
  importLegacyGitHubPollState,
  parseLegacySeenKey,
  planLegacyGitHubPollStateImport,
} from "./legacy-github-poll-state-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

const REPO = "example-org/service-repo";

/** A file exactly as the retired poller wrote it after a couple of cycles. */
const legacyRepo = {
  issuesWatermark: "2026-07-03T00:10:00Z",
  commentsWatermark: "2026-07-03T00:05:00Z",
  seen: [
    "issues:1:2026-07-03T00:10:00Z",
    "pull_request:9:2026-07-03T00:01:00Z",
    "issue_comment:20:2026-07-03T00:05:00Z",
  ],
  branchHeads: { master: "sha-before" },
};

describe("parseLegacySeenKey", () => {
  it("splits on the second colon so the timestamp's own colons survive", () => {
    expect(parseLegacySeenKey("issue_comment:20:2026-07-03T00:05:00Z")).toEqual({
      key: "issue_comment:20:2026-07-03T00:05:00Z",
      stream: "comments",
      updatedAt: "2026-07-03T00:05:00Z",
    });
    expect(parseLegacySeenKey("issues:1:2026-07-03T00:10:00Z")?.stream).toBe("issues");
    expect(parseLegacySeenKey("pull_request:9:2026-07-03T00:01:00Z")?.stream).toBe("issues");
  });

  it("rejects keys the poller never wrote", () => {
    expect(parseLegacySeenKey("issues:1")).toBeUndefined();
    expect(parseLegacySeenKey("issues:1:not-a-time")).toBeUndefined();
    expect(parseLegacySeenKey("push:master:2026-07-03T00:10:00Z")).toBeUndefined();
    expect(parseLegacySeenKey("")).toBeUndefined();
  });
});

describe("legacy GitHub poll state import", () => {
  let home: string;
  let filePath: string;
  let db: Database.Database;
  let repositories: Repositories;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-poll-state-import-"));
    filePath = join(home, GITHUB_POLL_STATE_FILENAME);
    db = new Database(join(home, "mesh.db"));
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    repositories = new Repositories(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const writeLegacy = (repos: Record<string, unknown>): void => {
    writeFileSync(filePath, JSON.stringify({ repos }, null, 2));
  };

  const backups = (): string[] => readdirSync(home).filter((name) => name.endsWith(".bak"));

  const runImport = (): ReturnType<typeof importLegacyGitHubPollState> =>
    importLegacyGitHubPollState({ mcHome: home, db, repositories });

  it("is a no-op when no legacy file is present, and creates none", () => {
    expect(runImport()).toEqual({ importedRepos: 0, backupFiles: [] });
    expect(repositories.githubPollState.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  it("imports cursors, seen keys and branch heads, then archives the source recoverably", () => {
    writeLegacy({ [REPO]: legacyRepo });

    const result = runImport();

    expect(result.importedRepos).toBe(1);
    expect(repositories.githubPollState.list()).toEqual([
      {
        repo: REPO,
        issuesWatermark: "2026-07-03T00:10:00Z",
        commentsWatermark: "2026-07-03T00:05:00Z",
        seen: [
          {
            key: "pull_request:9:2026-07-03T00:01:00Z",
            stream: "issues",
            updatedAt: "2026-07-03T00:01:00Z",
          },
          {
            key: "issue_comment:20:2026-07-03T00:05:00Z",
            stream: "comments",
            updatedAt: "2026-07-03T00:05:00Z",
          },
          {
            key: "issues:1:2026-07-03T00:10:00Z",
            stream: "issues",
            updatedAt: "2026-07-03T00:10:00Z",
          },
        ],
        branchHeads: { master: "sha-before" },
      },
    ]);
    expect(repositories.legacyImportReceipts.has(GITHUB_POLL_STATE_IMPORT_SOURCE)).toBe(true);

    // The source is renamed, never deleted: its bytes stay recoverable.
    expect(existsSync(filePath)).toBe(false);
    expect(result.backupFiles).toHaveLength(1);
    const restored = JSON.parse(readFileSync(result.backupFiles[0] as string, "utf8"));
    expect(restored.repos[REPO]).toEqual(legacyRepo);
  });

  it("resolves a pre-stream-cursor file the way the poller did on read", () => {
    // Before the streams split, one `watermark` served both endpoints; a file
    // written then and never rewritten still has it. A repository with no
    // cursor at all starts at the epoch, as the poller would have started it.
    writeLegacy({
      [REPO]: { watermark: "2026-06-01T00:00:00Z", seen: [] },
      "example-org/never-polled": { seen: [] },
    });

    runImport();

    const byRepo = Object.fromEntries(
      repositories.githubPollState.list().map((state) => [state.repo, state])
    );
    expect(byRepo[REPO]).toMatchObject({
      issuesWatermark: "2026-06-01T00:00:00Z",
      commentsWatermark: "2026-06-01T00:00:00Z",
      branchHeads: {},
    });
    expect(byRepo["example-org/never-polled"]).toMatchObject({
      issuesWatermark: GITHUB_POLL_EPOCH,
      commentsWatermark: GITHUB_POLL_EPOCH,
    });
  });

  it("re-running after a completed import is a no-op", () => {
    writeLegacy({ [REPO]: legacyRepo });
    runImport();
    const before = repositories.githubPollState.list();

    expect(runImport()).toEqual({ importedRepos: 0, backupFiles: [] });
    expect(repositories.githubPollState.list()).toEqual(before);
    expect(backups()).toHaveLength(1);
  });

  it("archives a source that reappears after the receipt without reading it", () => {
    writeLegacy({ [REPO]: legacyRepo });
    runImport();
    // The poller has since advanced; a restored file must not rewind it.
    repositories.githubPollState.recordEmitted(REPO, {
      key: "issues:2:2026-08-01T00:00:00Z",
      stream: "issues",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    writeLegacy({ [REPO]: legacyRepo });

    const result = runImport();

    expect(result.importedRepos).toBe(0);
    expect(result.backupFiles).toHaveLength(1);
    expect(existsSync(filePath)).toBe(false);
    expect(backups()).toHaveLength(2);
    expect(repositories.githubPollState.getCursors(REPO)?.issuesWatermark).toBe(
      "2026-08-01T00:00:00Z"
    );
  });

  it("refuses a file with a key the poller never wrote, and leaves it in place", () => {
    writeLegacy({ [REPO]: { ...legacyRepo, extra: true } });

    expect(() => runImport()).toThrow(/unresolved row\(s\)/);
    expect(existsSync(filePath)).toBe(true);
    expect(repositories.githubPollState.list()).toEqual([]);
    expect(repositories.legacyImportReceipts.has(GITHUB_POLL_STATE_IMPORT_SOURCE)).toBe(false);
  });

  it("refuses a seen key whose stream or timestamp cannot be recovered", () => {
    writeLegacy({ [REPO]: { ...legacyRepo, seen: ["issues:1"] } });

    expect(() => runImport()).toThrow(/seen key 'issues:1'/);
    expect(existsSync(filePath)).toBe(true);
    expect(repositories.githubPollState.list()).toEqual([]);
  });

  it("refuses an unparseable file rather than starting every cursor over", () => {
    writeFileSync(filePath, "{not json");

    expect(() => runImport()).toThrow(/cannot parse/);
    expect(existsSync(filePath)).toBe(true);
  });

  it("refuses to overwrite durable rows written without a receipt", () => {
    repositories.githubPollState.recordEmitted(REPO, {
      key: "issues:2:2026-08-01T00:00:00Z",
      stream: "issues",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    writeLegacy({ [REPO]: legacyRepo });

    expect(() => runImport()).toThrow(/without an import receipt/);
    expect(repositories.githubPollState.getCursors(REPO)?.issuesWatermark).toBe(
      "2026-08-01T00:00:00Z"
    );
    expect(existsSync(filePath)).toBe(true);
  });

  it("planning performs no writes", () => {
    writeLegacy({ [REPO]: legacyRepo });

    const planned = planLegacyGitHubPollStateImport({ mcHome: home, repositories });

    expect(planned.plan.kind).toBe("import");
    expect(planned.plannedRepos).toBe(1);
    expect(repositories.githubPollState.list()).toEqual([]);
    expect(repositories.legacyImportReceipts.has(GITHUB_POLL_STATE_IMPORT_SOURCE)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(backups()).toEqual([]);
  });

  it("an interruption before commit leaves the complete legacy view", () => {
    writeLegacy({ [REPO]: legacyRepo });
    const planned = planLegacyGitHubPollStateImport({ mcHome: home, repositories });

    // Fail inside the transaction: nothing may have landed.
    expect(() =>
      applyLegacyGitHubPollStateImport(planned, {
        db,
        repositories,
        now: () => {
          throw new Error("interrupted before commit");
        },
      })
    ).toThrow(/interrupted before commit/);

    expect(repositories.githubPollState.list()).toEqual([]);
    expect(repositories.legacyImportReceipts.has(GITHUB_POLL_STATE_IMPORT_SOURCE)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(backups()).toEqual([]);

    // The next boot re-plans against the intact file and imports it whole.
    expect(runImport().importedRepos).toBe(1);
  });

  it("an interruption after commit but before archive yields the complete database view", () => {
    writeLegacy({ [REPO]: legacyRepo });
    const planned = planLegacyGitHubPollStateImport({ mcHome: home, repositories });

    // Commit the rows and the receipt, but leave the file where it is — the
    // archive rename is the step that did not run.
    db.transaction(() => {
      if (planned.plan.kind !== "import") throw new Error("expected an import plan");
      for (const repo of planned.plan.repos) repositories.githubPollState.importRepo(repo);
      repositories.legacyImportReceipts.record(GITHUB_POLL_STATE_IMPORT_SOURCE, "t", 1);
    })();
    expect(existsSync(filePath)).toBe(true);

    const result = runImport();

    expect(result.importedRepos).toBe(0);
    expect(result.backupFiles).toHaveLength(1);
    expect(existsSync(filePath)).toBe(false);
    expect(repositories.githubPollState.list()).toHaveLength(1);
  });
});
