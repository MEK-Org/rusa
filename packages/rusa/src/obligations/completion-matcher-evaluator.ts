import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import type { IssueClient } from "../gitops/issue-client.js";
import { asGitHubIssue, parseReference } from "../references/reference.js";
import type { CompletionMatcher, Obligation } from "./obligation.js";

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
  onClosedUnmerged?: (obligation: Obligation, matcher: CompletionMatcher) => void;
  log?: (message: string) => void;
}

function matcherKey(
  matcher: CompletionMatcher
): Pick<CompletionMatcher, "kind" | "target" | "setAt"> {
  return { kind: matcher.kind, target: matcher.target, setAt: matcher.setAt };
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

  async evaluate(id: string): Promise<CompletionMatcherEvaluation> {
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
      ? this.evaluatePr(obligation, matcher)
      : this.evaluateDeployed(obligation, matcher);
  }

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
    const target = `github:${input.repo}/pulls/${input.number}`;
    for (const obligation of this.deps.obligations.listLiveCompletionMatchers("pr_merged")) {
      const matcher = obligation.completionMatcher;
      if (matcher === null || matcher.target.toLowerCase() !== target.toLowerCase()) continue;
      if (input.merged) {
        this.satisfyPr(obligation, matcher, input.number);
      } else {
        this.recordClosedUnmerged(obligation, matcher);
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
        `[completion-matcher] PR read unchecked for ${matcher.target}: ${
          error instanceof Error ? error.message : String(error)
        }`
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
    if (!/^[0-9a-f]{40}$/.test(deployed)) return "pending";
    try {
      if (!(await this.deps.isAncestor(matcher.target, deployed))) return "pending";
    } catch (error) {
      this.deps.log?.(
        `[completion-matcher] deployment ancestry unchecked for ${matcher.target}: ${
          error instanceof Error ? error.message : String(error)
        }`
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
    // The durable fact is idempotent. Only its first observation earns the
    // owner notice; a later boot reconciliation or duplicate webhook must not
    // create a second notification for the same matcher installation.
    if (matcher.closedUnmergedAt === null && current?.completionMatcher)
      this.deps.onClosedUnmerged?.(current, current.completionMatcher);
  }
}
