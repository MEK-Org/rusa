import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExhaustionClassifier } from "../providers/exhaustion-classifier.js";
import type { CodingProvider, RunResult } from "../providers/types.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { MechanicalInboxForensics } from "./actor-mesh.js";

/** How much of a failed run's output to include in the mechanical notice. */
const TAIL_LEN = 800;

export interface FailureSinkDeps {
  actors: Pick<ActorRepository, "get">;
  /** Deliver to the parent's durable ISSUE_NUM actor inbox. */
  sendToParent: (
    toId: string,
    body: string,
    fromId: string,
    forensics?: MechanicalInboxForensics
  ) => void;
  /** Mechanical post to the configured error chat, or null if unconfigured. */
  postToErrorChat: ((text: string) => void) | null;
  /** Id of the root actor (the one with no parent). */
  rootId: string;
  /** Backstop sink (journal). */
  log: (message: string) => void;
  /** Optional workers home directory to check for unpushed work on SIGTERM. */
  workersDir?: string;
  /**
   * Optional exhaustion classifier . When set, a failed run's output is
   * classified before the notice is built; if it classifies as quota
   * exhaustion, the notice LEADS with a named condition — a worker can no
   * longer self-heal onto a fallback, so the parent needs to see the cause up
   * front to judge: wait, respawn on another provider/tier, or re-scope.
   */
  classify?: ExhaustionClassifier;
}

/**
 * Format a `<provider>/<model>` label for a failure notice's exhaustion lead
 * line. `runModel` — what the provider reported it actually ran (`RunResult.model`)
 * — takes precedence over the configured/pinned model, because the decision the
 * parent has to make (wait out the timer, respawn on another tier, re-scope)
 * turns on which model is the one that ran out.
 *
 * Falling back to the pin is sound HERE and nowhere that makes a claim: this is a
 * label on a notice that is being sent regardless, so a configured-model name beats
 * no name. A gate asserting two runs used the same model may not fall back the same
 * way — see `harness/model-identity.ts`.
 */
export function formatProviderLabel(provider: CodingProvider, runModel?: string): string {
  const name = provider.providerName ?? provider.name;
  const model = runModel ?? provider.model;
  const selection = model ? `${name}/${model}` : name;
  return provider.effort ? `${selection} @ ${provider.effort}` : selection;
}

function isGitRepoDirtyOrAhead(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    // Check if it's a git repo. Set timeout to ensure the host coordinator's single-threaded
    // event loop is never blocked by a wedged git command or stuck filesystem.
    execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "ignore", timeout: 5000 });

    // Check for dirty files
    const status = execSync("git status --porcelain", {
      encoding: "utf8",
      cwd: dir,
      timeout: 5000,
    }).trim();
    if (status.length > 0) return true;

    // Check for unpushed commits
    let aheadCount = 0;
    try {
      const countStr = execSync("git rev-list --count @{u}..HEAD", {
        encoding: "utf8",
        cwd: dir,
        timeout: 5000,
      }).trim();
      aheadCount = parseInt(countStr, 10);
    } catch {
      // Fallback if no upstream set
      try {
        const countStr = execSync("git rev-list --count HEAD --not --remotes", {
          encoding: "utf8",
          cwd: dir,
          timeout: 5000,
        }).trim();
        aheadCount = parseInt(countStr, 10);
      } catch {
        // Fallback if no remotes at all
        aheadCount = 0;
      }
    }
    if (aheadCount > 0) return true;
  } catch {
    // Not a git repo or other git error
  }
  return false;
}

function findDirtyOrAheadRepoPath(workerDir: string): string | null {
  if (!existsSync(workerDir)) return null;

  // First check if workerDir itself is a git repo
  if (isGitRepoDirtyOrAhead(workerDir)) {
    return workerDir;
  }

  // Otherwise check immediate subdirectories
  try {
    const files = readdirSync(workerDir);
    for (const file of files) {
      const fullPath = join(workerDir, file);
      if (statSync(fullPath).isDirectory()) {
        if (isGitRepoDirtyOrAhead(fullPath)) {
          return fullPath;
        }
      }
    }
  } catch {
    // ignore read errors
  }
  return null;
}

/**
 * Route a failed run to its supervisor — deliberately rote, never clever. When an
 * actor's run fails (often it couldn't even start, so there's no agent to report),
 * the system must mechanically forward the failure without trying to decide where
 * it "should" go:
 *
 *  - sub-actor (has a parent) → append to the parent's inbox; the parent is a live
 *    actor that wakes and applies judgment. Failures bubble up one live supervisor
 *    at a time.
 *  - root (no parent) → post to the statically configured error chat (unless the
 *    failure was caused by a human operator interrupt/cancellation, which is
 *    suppressed to avoid noisy chat alerts, ISSUE_NUM). No judgment is possible
 *    (nothing above it), so it's a fixed destination from config.
 *  - parent gone, or unknown actor → journal and drop (a subtree being torn down
 *    has no live supervisor that cares; we don't want teardown races as noise).
 *
 * The parent-gone case is handled for free: the mesh's sendMessage drops-and-logs
 * when the target isn't live.
 *
 * When {@link FailureSinkDeps.classify} is set, the failed run's output is
 * classified first . A worker has no fallback of its own anymore — its
 * parent is the one who judges what quota exhaustion means (wait, respawn on
 * another provider/tier, or re-scope) — so an exhaustion classification leads
 * the notice with a named condition, ahead of the usual exit-code/tail
 * summary. `providerLabel` (typically `<provider>/<model> @ <effort>`, via
 * {@link formatProviderLabel}) attributes both exhaustion and native selection
 * rejection to the exact requested provider selection.
 */
export async function routeRunFailure(
  deps: FailureSinkDeps,
  actorId: string,
  result: RunResult,
  providerLabel?: string
): Promise<void> {
  if (result.success) return;
  if (isResponsivePreemption(result)) {
    deps.log(`suppressing expected responsive preemption notice for ${actorId}`);
    return;
  }
  const tail = sanitizeFailureText(result.output ?? "")
    .slice(-TAIL_LEN)
    .trim();
  const summary = `(exit ${result.exitCode})${tail ? `\n\n${tail}` : ""}`;

  let leadLine: string | undefined;
  if (deps.classify) {
    const classification = await deps.classify(result);
    if (classification.exhausted) {
      leadLine =
        `quota exhausted: ${providerLabel ?? "unknown provider/model"} — clears on a timer. ` +
        "Parent judgment needed: wait, respawn on another provider/tier, or re-scope.";
    }
  }

  if (!leadLine && providerLabel) {
    leadLine = `provider selection ${providerLabel} failed.`;
  }
  const body = leadLine ? `${leadLine}\n\n${summary}` : summary;
  routeMechanicalFailureNotice(deps, actorId, "run failed", body, result.exitCode, result);
}

/** Responsive inbox preemption is intentional scheduling, not a supervisor failure. */
export function isResponsivePreemption(result: RunResult): boolean {
  return Boolean(
    result.cancelled && result.interrupted && result.interruptSource === "responsive-notification"
  );
}

export function sanitizeFailureText(text: string): string {
  if (!text) return "";
  const parsed = tryParseJson(text);
  if (parsed !== undefined) return JSON.stringify(scrubJson(parsed));
  return text
    .replace(
      /("(?:arguments|args|input|prompt|messages|body|content)"\s*:\s*)"(?:\\.|[^"\\])*"/gis,
      '$1"[scrubbed]"'
    )
    .replace(
      /("(?:arguments|args|input|prompt|messages|body|content)"\s*:\s*)(\{[\s\S]*?\}|\[[\s\S]*?\])/gis,
      '$1"[scrubbed]"'
    )
    .replace(/(<tool_call\b[^>]*>)[\s\S]*?(<\/tool_call>)/gis, "$1[scrubbed]$2")
    .replace(/(<request\b[^>]*>)[\s\S]*?(<\/request>)/gis, "$1[scrubbed]$2");
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function scrubJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (!value || typeof value !== "object") return value;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(arguments|args|input|prompt|messages|body|content)$/i.test(key)) {
      scrubbed[key] = "[scrubbed]";
    } else {
      scrubbed[key] = scrubJson(child);
    }
  }
  return scrubbed;
}

/**
 * Check if a run failure was caused by a human operator interrupt or cancellation .
 * Top-level error chat reporting suppresses notices for operator-initiated interrupts.
 */
export function isHumanOperatorCancelled(result: RunResult): boolean {
  if (result.interruptSource) {
    const by = result.interruptSource.toLowerCase();
    return (
      by === "human:operator" || by === "operator" || by === "human" || by.startsWith("human:")
    );
  }
  if (result.interrupted) {
    return true;
  }
  return false;
}

export function routeContinuationCapped(
  deps: FailureSinkDeps,
  actorId: string,
  continuationCount: number
): void {
  deps.log(
    `yield-elicitation exhausted for ${actorId} after ${continuationCount} corrective run(s)`
  );
  const summary = `yield-elicitation exhausted after ${continuationCount} corrective run(s)`;
  routeMechanicalFailureNotice(deps, actorId, "capped", summary);
}

function routeMechanicalFailureNotice(
  deps: FailureSinkDeps,
  actorId: string,
  label: "run failed" | "capped",
  summary: string,
  exitCode?: number,
  result?: RunResult
): void {
  const record = deps.actors.get(actorId);

  let extraMessage = "";
  if (exitCode === 143 && deps.workersDir) {
    try {
      const workerDir = join(deps.workersDir, actorId);
      const repoPath = findDirtyOrAheadRepoPath(workerDir);
      if (repoPath) {
        extraMessage = `\n\nin-progress work present at ${repoPath}`;
      }
    } catch {
      // Handle the edge cases gracefully — the check must NEVER throw and mask the kill notification
    }
  }

  if (record?.parentId) {
    deps.sendToParent(record.parentId, `[${label}] ${summary}${extraMessage}`, actorId, {
      runId: actorId,
      actorId,
      exitCode,
    });
    return;
  }

  if (actorId === deps.rootId) {
    if (result && isHumanOperatorCancelled(result)) {
      deps.log(`suppressing error chat for root ${label} — interrupted by human operator`);
      return;
    }
    if (deps.postToErrorChat) {
      deps.postToErrorChat(`⚠️ System Root's root ${label} ${summary}${extraMessage}`);
    } else {
      deps.log(`root ${label} but no error chat is configured ${summary}${extraMessage}`);
    }
    return;
  }

  deps.log(`${label} for ${actorId} dropped — no parent and not root ${summary}${extraMessage}`);
}
