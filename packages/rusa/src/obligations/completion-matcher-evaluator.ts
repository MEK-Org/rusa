import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import type { IssueClient } from "../gitops/issue-client.js";
import { asGitHubIssue, parseReference } from "../references/reference.js";
import {
  type CompletionMatcher,
  canonicalPullRequestTarget,
  type Obligation,
} from "./obligation.js";

export type CompletionMatcherEvaluation = "satisfied" | "pending" | "unchecked" | "closed_unmerged";

export interface CompletionMatcherEvaluatorDeps {
  obligations: Pick<
    ObligationRepository,
    | "get"
    | "listLiveCompletionMatchers"
    | "satisfyCompletionMatcher"
    | "recordCompletionMatcherClosedUnmerged"
  >;
  issueClient: Pick<IssueClient, "getPullRequestDetails">;
  deployedSha: () => string;
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  repository: string | null;
  instanceName: string;
  /**
   * Owner attention for a recorded unmerged close. Called on every observation
   * of that durable fact, so the sink must deduplicate by matcher installation;
   * boot reconciliation re-derives the same attention from stored state.
   */
  onClosedUnmerged?: (obligation: Obligation, matcher: CompletionMatcher) => void;
  log?: (message: string) => void;
}

function matcherKey(
  matcher: CompletionMatcher
): Pick<CompletionMatcher, "kind" | "target" | "setAt"> {
  return { kind: matcher.kind, target: matcher.target, setAt: matcher.setAt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prTarget(matcher: CompletionMatcher): { repo: string; number: number } {
  const target = asGitHubIssue(parseReference(matcher.target));
  if (target?.collection !== "pulls")
    throw new Error(`invalid pr_merged target: ${matcher.target}`);
  return { repo: `${target.owner}/${target.repo}`, number: target.number };
}

/**
 * The only place that turns matcher observations into durable transitions. It
 * deliberately has no event-routing dependency: webhook ingress invokes it
 * before delivery filters, while boot and MCP reuse the same evaluator.
 */
export class CompletionMatcherEvaluator {
  constructor(private readonly deps: CompletionMatcherEvaluatorDeps) {}

  /**
   * Never throws: a read, checkout, or repository failure is logged and
   * reported as `unchecked`, so callers that already committed the matcher
   * (create/set) never surface a retryable tool error for durable work.
   */
  async evaluate(id: string): Promise<CompletionMatcherEvaluation> {
    try {
      const obligation = this.deps.obligations.get(id);
      if (
        !obligation?.completionMatcher ||
        obligation.status === "done" ||
        obligation.status === "cancelled"
      ) {
        return "unchecked";
      }
      const matcher = obligation.completionMatcher;
      if (matcher.satisfiedAt !== null) return "satisfied";
      return matcher.kind === "pr_merged"
        ? await this.evaluatePr(obligation, matcher)
        : await this.evaluateDeployed(obligation, matcher);
    } catch (error) {
      this.deps.log?.(
        `[completion-matcher] evaluation unchecked for ${id}: ${errorMessage(error)}`
      );
      return "unchecked";
    }
  }

  /** Each row is isolated by {@link evaluate}; one bad matcher cannot skip the rest. */
  async reconcileAtBoot(): Promise<void> {
    for (const obligation of this.deps.obligations.listLiveCompletionMatchers()) {
      await this.evaluate(obligation.id);
    }
  }

  async handlePullRequestClosed(input: {
    repo: string;
    number: number;
    merged: boolean;
  }): Promise<void> {
    const target = canonicalPullRequestTarget(input.repo, input.number);
    for (const obligation of this.deps.obligations.listLiveCompletionMatchers(
      "pr_merged",
      target
    )) {
      const matcher = obligation.completionMatcher;
      if (matcher === null) continue;
      try {
        if (input.merged) {
          this.satisfyPr(obligation, matcher, input.number);
        } else {
          this.recordClosedUnmerged(obligation, matcher);
        }
      } catch (error) {
        // Boot reconciliation re-reads the PR, so a failed write here is
        // retried there; the remaining matchers still see this event.
        this.deps.log?.(
          `[completion-matcher] live PR event unchecked for ${obligation.id}: ${errorMessage(error)}`
        );
      }
    }
  }

  private async evaluatePr(
    obligation: Obligation,
    matcher: CompletionMatcher
  ): Promise<CompletionMatcherEvaluation> {
    const target = prTarget(matcher);
    try {
      const details = await this.deps.issueClient.getPullRequestDetails(target.repo, target.number);
      if (details.merged === true) {
        this.satisfyPr(obligation, matcher, target.number);
        return "satisfied";
      }
      if (details.state.toLowerCase() === "closed") {
        this.recordClosedUnmerged(obligation, matcher);
        return "closed_unmerged";
      }
      return "pending";
    } catch (error) {
      this.deps.log?.(
        `[completion-matcher] PR read unchecked for ${matcher.target}: ${errorMessage(error)}`
      );
      return "unchecked";
    }
  }

  private async evaluateDeployed(
    obligation: Obligation,
    matcher: CompletionMatcher
  ): Promise<CompletionMatcherEvaluation> {
    if (this.deps.repository === null) {
      this.deps.log?.(
        "[completion-matcher] deployed matcher is pending: no local GitHub repository is configured"
      );
      return "pending";
    }
    const deployed = this.deps.deployedSha().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(deployed)) {
      this.deps.log?.(
        `[completion-matcher] deployed matcher ${matcher.target} is pending: running revision is unknown (${deployed})`
      );
      return "pending";
    }
    try {
      if (!(await this.deps.isAncestor(matcher.target, deployed))) return "pending";
    } catch (error) {
      // Includes a commit this checkout does not know: v2 keeps it pending.
      this.deps.log?.(
        `[completion-matcher] deployment ancestry unchecked for ${matcher.target}: ${errorMessage(error)}`
      );
      return "pending";
    }
    const resolutionRef = `github:${this.deps.repository}/commits/${deployed}`;
    this.deps.obligations.satisfyCompletionMatcher(obligation.id, matcherKey(matcher), {
      resolutionRef,
      note: `Completion matcher satisfied: instance ${this.deps.instanceName} running ${deployed.slice(0, 7)} contains ${matcher.target.slice(0, 7)}`,
    });
    return "satisfied";
  }

  private satisfyPr(obligation: Obligation, matcher: CompletionMatcher, number: number): void {
    this.deps.obligations.satisfyCompletionMatcher(obligation.id, matcherKey(matcher), {
      resolutionRef: matcher.target,
      note: `Completion matcher satisfied: PR #${number} merged`,
    });
  }

  private recordClosedUnmerged(obligation: Obligation, matcher: CompletionMatcher): void {
    const current = this.deps.obligations.recordCompletionMatcherClosedUnmerged(
      obligation.id,
      matcherKey(matcher)
    );
    if (!current?.completionMatcher?.closedUnmergedAt) return;
    // The durable fact is committed first. The notice is keyed by matcher
    // installation, so every observation may retry it; a failure here is
    // repaired by the next observation or the boot attention reconciliation.
    try {
      this.deps.onClosedUnmerged?.(current, current.completionMatcher);
    } catch (error) {
      this.deps.log?.(
        `[completion-matcher] unmerged-close notice deferred for ${obligation.id}: ${errorMessage(error)}`
      );
    }
  }
}

/**
 * The `owner/repo` a GitHub remote URL names, or null for anything else. This
 * identifies the repository the running checkout was built from; the
 * subscription list in config is unrelated and may name several repositories.
 */
export function githubRepositoryFromRemote(remoteUrl: string | null): string | null {
  const match = remoteUrl?.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Set-time scope check for a `deployed` matcher: its commit must belong to
 * this instance's own repository. A commit the checkout already has passes; an
 * unknown one is fetched by SHA from the checkout's own remote, and a remote
 * that refuses it ("not our ref") means foreign or mistyped, so it is refused
 * instead of being stored as a matcher that can never fire. A remote that
 * cannot be asked does not fail the set; evaluation keeps it pending and logs.
 */
export async function validateDeployedCompletionMatcher(
  commit: string,
  deps: {
    repository: string | null;
    git: {
      hasCommit(sha: string): Promise<boolean>;
      fetchCommit(sha: string): Promise<boolean>;
    } | null;
    log?: (message: string) => void;
  }
): Promise<void> {
  if (deps.repository === null || deps.git === null) {
    throw new Error(
      "deployed completion matchers need this instance's own GitHub checkout, and none is identifiable"
    );
  }
  const sha = commit.trim().toLowerCase();
  if (await deps.git.hasCommit(sha)) return;
  let ownCommit: boolean;
  try {
    ownCommit = await deps.git.fetchCommit(sha);
  } catch (error) {
    deps.log?.(
      `[completion-matcher] could not confirm ${sha} in ${deps.repository}; keeping it pending: ${errorMessage(error)}`
    );
    return;
  }
  if (!ownCommit) {
    throw new Error(
      `deployed completion matcher commit ${sha} is not in this instance's repository ${deps.repository}`
    );
  }
}
