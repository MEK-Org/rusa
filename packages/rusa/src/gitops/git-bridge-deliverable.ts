export interface GitBridgeDeliverableOptions {
  repo: string;
  head: string;
  base?: string;
  port: number;
}

export interface GitBridgeDeliverable {
  repo: string;
  branch: string;
  base: string;
  compareUrl: string;
  instructions: string;
}

export function buildGitBridgeDeliverable(opts: GitBridgeDeliverableOptions): GitBridgeDeliverable {
  const base = opts.base?.trim() || "main";
  const compareUrl = `http://localhost:${opts.port}/${opts.repo}/compare/${encodeURIComponent(
    opts.head
  )}`;
  const instructions = [
    "Local branch delivered to the Rusa git bridge.",
    "",
    `Compare: ${compareUrl}`,
    "",
    "Review locally:",
    "git fetch rusa",
    `git diff ${base}...rusa/${opts.head}`,
    "",
    "Pull the branch:",
    `git pull rusa ${opts.head}`,
  ].join("\n");

  return {
    repo: opts.repo,
    branch: opts.head,
    base,
    compareUrl,
    instructions,
  };
}

export function formatGitBridgePullRequestResult(deliverable: GitBridgeDeliverable): string {
  return [
    `Local compare: ${deliverable.compareUrl}`,
    "",
    "Review locally:",
    "git fetch rusa",
    `git diff ${deliverable.base}...rusa/${deliverable.branch}`,
    "",
    "Pull the branch:",
    `git pull rusa ${deliverable.branch}`,
  ].join("\n");
}
