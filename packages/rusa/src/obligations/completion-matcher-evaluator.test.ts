import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { obligations } from "../db/migrations/0016_obligations.js";
import { obligationPriority } from "../db/migrations/0017_obligation_priority.js";
import { obligationTimestamps } from "../db/migrations/0025_obligation_timestamps.js";
import { obligationTerminalNote } from "../db/migrations/0026_obligation_terminal_note.js";
import { obligationTitle } from "../db/migrations/0027_obligation_title.js";
import { obligationArtifacts } from "../db/migrations/0028_obligation_artifacts.js";
import { recurringObligations } from "../db/migrations/0035_recurring_obligations.js";
import { obligationDependencies } from "../db/migrations/0037_obligation_dependencies.js";
import { obligationCheckpoint } from "../db/migrations/0043_obligation_checkpoint.js";
import { obligationHistory } from "../db/migrations/0045_obligation_history.js";
import { obligationResponsive } from "../db/migrations/0049_obligation_responsive.js";
import { dropObligationReadyHeads } from "../db/migrations/0050_drop_obligation_ready_heads.js";
import { obligationSnooze } from "../db/migrations/0052_obligation_snooze.js";
import { obligationCompletionMatchers } from "../db/migrations/0059_obligation_completion_matchers.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import {
  CompletionMatcherEvaluator,
  githubRepositoryFromRemote,
  validateDeployedCompletionMatcher,
} from "./completion-matcher-evaluator.js";
import type { CompletionMatcher, Obligation } from "./obligation.js";

describe("CompletionMatcherEvaluator", () => {
  let repository: ObligationRepository;
  const pr = "github:MEK-Org/rusa/pulls/190";
  const canonicalPr = "github:mek-org/rusa/pulls/190";

  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);
    obligationTimestamps.up(db);
    obligationTerminalNote.up(db);
    obligationTitle.up(db);
    obligationArtifacts.up(db);
    recurringObligations.up(db);
    obligationDependencies.up(db);
    obligationCheckpoint.up(db);
    obligationHistory.up(db);
    obligationResponsive.up(db);
    obligationSnooze.up(db);
    dropObligationReadyHeads.up(db);
    obligationCompletionMatchers.up(db);
    repository = new ObligationRepository(db);
  });

  const evaluator = (
    details: { state: string; merged?: boolean },
    onClosedUnmerged: (obligation: Obligation, matcher: CompletionMatcher) => void = vi.fn(),
    log?: (message: string) => void
  ) =>
    new CompletionMatcherEvaluator({
      obligations: repository,
      issueClient: {
        getPullRequestDetails: vi.fn(async () => ({
          number: 190,
          title: "matched",
          body: "",
          htmlUrl: "https://example.test/pull/190",
          headRef: "branch",
          baseRef: "staging",
          headSha: "a".repeat(40),
          ...details,
        })),
      },
      deployedSha: () => "b".repeat(40),
      isAncestor: vi.fn(async () => false),
      repository: "MEK-Org/rusa",
      instanceName: "test-instance",
      onClosedUnmerged,
      log,
    });

  it("completes a late-set merged PR matcher through the shared evaluator", async () => {
    repository.create({ id: "matched", title: "matched", ownerId: "human:operator" });
    repository.setCompletionMatcher("matched", { kind: "pr_merged", pr }, "human:operator");

    await expect(evaluator({ state: "closed", merged: true }).evaluate("matched")).resolves.toBe(
      "satisfied"
    );
    expect(repository.require("matched")).toMatchObject({
      status: "done",
      resolutionRef: canonicalPr,
      terminalNote: "Completion matcher satisfied: PR #190 merged",
    });
  });

  it("reconciles an already-merged PR at boot", async () => {
    repository.create({ id: "boot", title: "boot", ownerId: "actor-a" });
    repository.setCompletionMatcher("boot", { kind: "pr_merged", pr }, "actor-a");

    await evaluator({ state: "closed", merged: true }).reconcileAtBoot();

    expect(repository.require("boot")).toMatchObject({
      status: "done",
      resolutionRef: canonicalPr,
    });
  });

  it("completes a deployed matcher only when the running build contains its commit", async () => {
    const commit = "a".repeat(40);
    const deployed = "b".repeat(40);
    repository.create({ id: "deploy", title: "deploy", ownerId: "actor-a" });
    repository.setCompletionMatcher("deploy", { kind: "deployed", commit }, "actor-a");
    const isAncestor = vi.fn(async () => true);
    const service = new CompletionMatcherEvaluator({
      obligations: repository,
      issueClient: { getPullRequestDetails: vi.fn() },
      deployedSha: () => deployed,
      isAncestor,
      repository: "MEK-Org/rusa",
      instanceName: "test-instance",
    });

    await expect(service.evaluate("deploy")).resolves.toBe("satisfied");
    expect(isAncestor).toHaveBeenCalledWith(commit, deployed);
    expect(repository.require("deploy")).toMatchObject({
      status: "done",
      resolutionRef: `github:MEK-Org/rusa/commits/${deployed}`,
    });
  });

  it("records an unmerged close, retries a failed notice, and processes a later merge", async () => {
    repository.create({ id: "matched", title: "matched", ownerId: "actor-a" });
    repository.setCompletionMatcher("matched", { kind: "pr_merged", pr }, "actor-a");
    const notice = vi.fn((_obligation: Obligation, _matcher: CompletionMatcher): void => {
      throw new Error("inbox append failed");
    });
    const log = vi.fn();
    const logged = evaluator({ state: "closed", merged: false }, notice, log);

    // The failed notice neither undoes the durable fact nor fails evaluation.
    await expect(logged.evaluate("matched")).resolves.toBe("closed_unmerged");
    expect(repository.require("matched")).toMatchObject({
      status: "ready",
      completionMatcher: { closedUnmergedAt: expect.any(String) },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("notice deferred"));

    // The next observation retries the same installation's notice; the sink
    // owns deduplication by matcher installation.
    notice.mockImplementation(() => undefined);
    await expect(logged.evaluate("matched")).resolves.toBe("closed_unmerged");
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice.mock.calls[0]?.[1].setAt).toBe(notice.mock.calls[1]?.[1].setAt);

    // A webhook names the PR in GitHub's casing; the stored target is canonical.
    await logged.handlePullRequestClosed({ repo: "MEK-Org/rusa", number: 190, merged: true });
    expect(repository.require("matched")).toMatchObject({
      status: "done",
      resolutionRef: "github:mek-org/rusa/pulls/190",
    });
  });

  it("isolates boot rows: one failing matcher does not skip the rest", async () => {
    repository.create({ id: "a-broken", title: "broken", ownerId: "actor-a" });
    repository.create({ id: "b-merged", title: "merged", ownerId: "actor-a" });
    repository.setCompletionMatcher(
      "a-broken",
      { kind: "pr_merged", pr: "github:MEK-Org/rusa/pulls/1" },
      "actor-a"
    );
    repository.setCompletionMatcher("b-merged", { kind: "pr_merged", pr }, "actor-a");
    const satisfy = repository.satisfyCompletionMatcher.bind(repository);
    vi.spyOn(repository, "satisfyCompletionMatcher").mockImplementation((id, ...rest) => {
      if (id === "a-broken") throw new Error("SQLITE_BUSY");
      return satisfy(id, ...rest);
    });
    const log = vi.fn();
    const service = new CompletionMatcherEvaluator({
      obligations: repository,
      issueClient: {
        getPullRequestDetails: vi.fn(async (_repo: string, number: number) => ({
          number,
          title: "",
          body: "",
          htmlUrl: "",
          headRef: "",
          baseRef: "",
          headSha: "",
          state: "closed",
          merged: true,
        })),
      },
      deployedSha: () => "b".repeat(40),
      isAncestor: vi.fn(async () => false),
      repository: "MEK-Org/rusa",
      instanceName: "test-instance",
      log,
    });

    await service.reconcileAtBoot();

    expect(repository.require("a-broken").status).toBe("ready");
    expect(repository.require("b-merged").status).toBe("done");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
  });

  it("reports unchecked instead of throwing when the repository write fails", async () => {
    repository.create({ id: "matched", title: "matched", ownerId: "actor-a" });
    repository.setCompletionMatcher("matched", { kind: "pr_merged", pr }, "actor-a");
    const service = evaluator({ state: "closed", merged: true });
    vi.spyOn(repository, "satisfyCompletionMatcher").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });

    await expect(service.evaluate("matched")).resolves.toBe("unchecked");
    await expect(
      service.handlePullRequestClosed({ repo: "MEK-Org/rusa", number: 190, merged: true })
    ).resolves.toBeUndefined();
  });

  it("logs a deployed matcher left pending by an unknown running revision", async () => {
    repository.create({ id: "deploy", title: "deploy", ownerId: "actor-a" });
    repository.setCompletionMatcher(
      "deploy",
      { kind: "deployed", commit: "a".repeat(40) },
      "actor-a"
    );
    const log = vi.fn();
    const service = new CompletionMatcherEvaluator({
      obligations: repository,
      issueClient: { getPullRequestDetails: vi.fn() },
      deployedSha: () => "unknown",
      isAncestor: vi.fn(async () => true),
      repository: "MEK-Org/rusa",
      instanceName: "test-instance",
      log,
    });

    await expect(service.evaluate("deploy")).resolves.toBe("pending");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("running revision is unknown"));
  });
});

describe("deployed matcher scope", () => {
  const commit = "a".repeat(40);
  const git = (has: boolean, fetch: () => Promise<boolean>) => ({
    hasCommit: vi.fn(async () => has),
    fetchCommit: vi.fn(fetch),
  });

  it("identifies the checkout's own GitHub repository from its remote", () => {
    expect(githubRepositoryFromRemote("https://github.com/MEK-Org/rusa.git")).toBe("MEK-Org/rusa");
    expect(githubRepositoryFromRemote("git@github.com:MEK-Org/rusa.git")).toBe("MEK-Org/rusa");
    expect(githubRepositoryFromRemote("https://example.test/MEK-Org/rusa.git")).toBeNull();
    expect(githubRepositoryFromRemote(null)).toBeNull();
  });

  it("refuses when this instance has no identifiable checkout", async () => {
    await expect(
      validateDeployedCompletionMatcher(commit, {
        repository: null,
        git: git(true, async () => true),
      })
    ).rejects.toThrow(/own GitHub checkout/);
    await expect(
      validateDeployedCompletionMatcher(commit, { repository: "MEK-Org/rusa", git: null })
    ).rejects.toThrow(/own GitHub checkout/);
  });

  it("accepts a commit the checkout has without asking the remote", async () => {
    const seam = git(true, async () => false);
    await validateDeployedCompletionMatcher(commit, { repository: "MEK-Org/rusa", git: seam });
    expect(seam.fetchCommit).not.toHaveBeenCalled();
  });

  it("refuses a commit its own remote does not have", async () => {
    await expect(
      validateDeployedCompletionMatcher(commit, {
        repository: "MEK-Org/rusa",
        git: git(false, async () => false),
      })
    ).rejects.toThrow(/not in this instance's repository MEK-Org\/rusa/);
  });

  it("keeps a commit pending, logged, when the remote cannot be asked", async () => {
    const log = vi.fn();
    await validateDeployedCompletionMatcher(commit, {
      repository: "MEK-Org/rusa",
      git: git(false, async () => {
        throw new Error("network unreachable");
      }),
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("keeping it pending"));
  });
});
