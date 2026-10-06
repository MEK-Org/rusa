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
import { CompletionMatcherEvaluator } from "./completion-matcher-evaluator.js";

describe("CompletionMatcherEvaluator", () => {
  let repository: ObligationRepository;
  const pr = "github:MEK-Org/rusa/pulls/190";

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

  const evaluator = (details: { state: string; merged?: boolean }, onClosedUnmerged = vi.fn()) =>
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
    });

  it("completes a late-set merged PR matcher through the shared evaluator", async () => {
    repository.create({ id: "matched", title: "matched", ownerId: "human:operator" });
    repository.setCompletionMatcher("matched", { kind: "pr_merged", pr }, "human:operator");

    await expect(evaluator({ state: "closed", merged: true }).evaluate("matched")).resolves.toBe(
      "satisfied"
    );
    expect(repository.require("matched")).toMatchObject({
      status: "done",
      resolutionRef: pr,
      terminalNote: "Completion matcher satisfied: PR #190 merged",
    });
  });

  it("reconciles an already-merged PR at boot", async () => {
    repository.create({ id: "boot", title: "boot", ownerId: "actor-a" });
    repository.setCompletionMatcher("boot", { kind: "pr_merged", pr }, "actor-a");

    await evaluator({ state: "closed", merged: true }).reconcileAtBoot();

    expect(repository.require("boot")).toMatchObject({ status: "done", resolutionRef: pr });
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

  it("records an unmerged close and processes a later merge for the same matcher", async () => {
    repository.create({ id: "matched", title: "matched", ownerId: "actor-a" });
    repository.setCompletionMatcher("matched", { kind: "pr_merged", pr }, "actor-a");
    const notice = vi.fn();
    const pending = evaluator({ state: "closed", merged: false }, notice);

    await expect(pending.evaluate("matched")).resolves.toBe("closed_unmerged");
    expect(repository.require("matched")).toMatchObject({
      status: "ready",
      completionMatcher: { closedUnmergedAt: expect.any(String) },
    });
    expect(notice).toHaveBeenCalledTimes(1);

    await expect(pending.evaluate("matched")).resolves.toBe("closed_unmerged");
    expect(notice).toHaveBeenCalledTimes(1);

    await pending.handlePullRequestClosed({ repo: "MEK-Org/rusa", number: 190, merged: true });
    expect(repository.require("matched")).toMatchObject({ status: "done", resolutionRef: pr });
  });
});
