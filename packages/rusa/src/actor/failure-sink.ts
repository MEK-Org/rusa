import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { ExhaustionClassifier } from "../providers/exhaustion-classifier.js";
import type { CodingProvider, RunResult } from "../providers/types.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { MechanicalInboxForensics } from "./actor-mesh.js";

/** Code points of failure diagnostic a mechanical notice may carry. */
export const FAILURE_DIAGNOSTIC_BUDGET = 800;

export interface FailureSinkDeps {
  actors: Pick<ActorRepository, "get">;
  /** Deliver to the parent's durable ISSUE_NUM actor inbox. */
  sendToParent: (
    toId: string,
    body: string,
    fromId: string,
    forensics?: MechanicalInboxForensics,
    delivery?: { responsive: boolean }
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
  /**
   * Durable principals, so an interrupt attributed to a user principal id is
   * recognized as a human cancellation (#460) rather than a failure to report.
   */
  principals?: Pick<PrincipalRepository, "getUser">;
  /**
   * Optional per-child backoff for waking the parent responsively (#189).
   * Absent, every failure notice keeps ordinary priority.
   */
  escalation?: Pick<FailureEscalationBackoff, "mayEscalate" | "recordEscalation">;
}

/**
 * Decides which child failures may wake the parent past provider pacing (#189).
 *
 * A child's first failure escalates. Repeats inside the backoff window are
 * still delivered, just at ordinary priority, so a crash loop cannot turn the
 * bypass into a tight loop on the parent. Each escalation that lands soon after
 * the previous window doubles the next window up to `maxMs`; a full window of
 * quiet past the last one resets the child to `baseMs`. A child's budget is
 * spent only once its responsive notice is delivered, so a delivery that
 * throws leaves the next failure free to escalate. Process-local by
 * design: a restart forgets the backoff and at worst grants one extra
 * responsive wake per failing child.
 */
export class FailureEscalationBackoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, { until: number; windowMs: number }>();

  constructor(opts: { baseMs?: number; maxMs?: number; now?: () => number } = {}) {
    this.baseMs = opts.baseMs ?? 60_000;
    this.maxMs = opts.maxMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Whether a failure from `childId` may wake its parent responsively now. Spends nothing. */
  mayEscalate(childId: string): boolean {
    const previous = this.windows.get(childId);
    return !previous || this.now() >= previous.until;
  }

  /** Spend `childId`'s escalation once its responsive notice has been delivered. */
  recordEscalation(childId: string): void {
    const t = this.now();
    for (const [id, w] of this.windows) {
      if (t >= w.until + w.windowMs) this.windows.delete(id);
    }
    const previous = this.windows.get(childId);
    const windowMs = previous ? Math.min(previous.windowMs * 2, this.maxMs) : this.baseMs;
    this.windows.set(childId, { until: t + windowMs, windowMs });
  }
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
export function formatProviderLabel(
  provider: Pick<CodingProvider, "providerName" | "model" | "effort"> &
    Partial<Pick<CodingProvider, "name">>,
  runModel?: string
): string {
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
 * {@link formatProviderLabel}) identifies the provider/model that produced the
 * failed run; it does not claim that selection itself failed.
 */
export async function routeRunFailure(
  deps: FailureSinkDeps,
  actorId: string,
  result: RunResult,
  providerLabel?: string,
  /** The durable run record, when the lifecycle owns one. */
  runId?: string
): Promise<void> {
  if (result.success) return;
  if (isResponsivePreemption(result)) {
    deps.log(`suppressing expected responsive preemption notice for ${actorId}`);
    return;
  }
  // A caught exception's own message says what went wrong; its stack does not,
  // and a long one would push the message out of the budget. Output (the stack,
  // or an ordinary CLI exit's own text) is the fallback only without a message.
  const message = result.failure?.message.trim() ? result.failure.message : undefined;
  const diagnostic = clipFailureDiagnostic(sanitizeFailureText(message ?? result.output ?? ""));
  const exitDesc = result.abortReason
    ? `exit ${result.exitCode}, ${result.abortReason}`
    : `exit ${result.exitCode}`;
  const summary = `(${exitDesc})${diagnostic ? `\n\n${diagnostic}` : ""}`;

  let leadLine: string | undefined;
  if (result.failure?.stage === "provider-selection") {
    // Established at the resolver boundary: nothing ran, so nothing exhausted.
    leadLine = `could not prepare ${providerLabel ?? "the configured provider/model"}.\nProvider was not invoked.`;
  } else if (deps.classify) {
    const classification = await deps.classify(result);
    if (classification.exhausted) {
      leadLine =
        `quota exhausted: ${providerLabel ?? "unknown provider/model"} — clears on a timer. ` +
        "Parent judgment needed: wait, respawn on another provider/tier, or re-scope.";
    }
  }

  if (!leadLine && providerLabel) {
    leadLine = `provider run ${providerLabel} failed.`;
  }
  // The run id, stage and selection sit outside the diagnostic budget, so
  // clipping can never cost the supervisor the record it needs to inspect.
  if (runId) leadLine = leadLine ? `Run ${runId}: ${leadLine}` : `Run ${runId} failed.`;
  const body = leadLine ? `${leadLine}\n\n${summary}` : summary;
  // A capped run is a failure too (#189); it keeps its own label so the parent
  // can tell a hit limit from a crash.
  const label = result.capped ? "capped" : "run failed";
  routeMechanicalFailureNotice(deps, actorId, label, body, result.exitCode, result, runId);
}

/**
 * Report a child that could not be instantiated (#189). With a parent, the
 * `[spawn failed]` notice spends the same per-child escalation budget as a run
 * failure; without one it goes to the error chat.
 */
export function routeSpawnFailure(
  deps: FailureSinkDeps,
  actorId: string,
  parentId: string | null | undefined,
  errorMsg: string
): void {
  if (parentId) {
    sendFailureToParent(deps, parentId, `[spawn failed] ${errorMsg}`, actorId);
  } else {
    deps.postToErrorChat?.(`⚠️ ${errorMsg}`);
  }
}

/**
 * Deliver a child's failure notice, responsive when the child's escalation
 * budget allows (#189). The budget is spent only after `sendToParent` returns:
 * a throwing delivery reached no one, so it must not cost the next failure its
 * responsive wake. Check, delivery and spend run in one synchronous turn, so no
 * other failure from the same child can interleave.
 */
function sendFailureToParent(
  deps: FailureSinkDeps,
  parentId: string,
  body: string,
  actorId: string,
  forensics?: MechanicalInboxForensics
): void {
  const responsive = deps.escalation?.mayEscalate(actorId) ?? false;
  deps.sendToParent(parentId, body, actorId, forensics, { responsive });
  if (responsive) deps.escalation?.recordEscalation(actorId);
}

/** Responsive inbox preemption is intentional scheduling, not a supervisor failure. */
export function isResponsivePreemption(result: RunResult): boolean {
  return Boolean(
    result.cancelled && result.interrupted && result.interruptSource === "responsive-notification"
  );
}

/**
 * Bound an already-sanitized diagnostic to `budget` Unicode code points by
 * keeping its beginning and end around a `… [N characters omitted] …` marker
 * (#980). The head carries what an exception or CLI said first and the tail
 * what it said last, so neither a long stack nor a late CLI error can crowd the
 * other out. The marker counts against the budget, N counts omitted code
 * points, and an odd remainder goes to the beginning. Text within the budget is
 * returned whole.
 */
export function clipFailureDiagnostic(text: string, budget = FAILURE_DIAGNOSTIC_BUDGET): string {
  const trimmed = text.trim();
  const points = Array.from(trimmed);
  if (points.length <= budget) return trimmed;
  // The marker's width depends on N, which depends on the marker's width;
  // widening it by a digit omits more, so the first width that fits is exact.
  for (let digits = 1; ; digits++) {
    const markerLength = "… [ characters omitted] …".length + digits;
    const kept = budget - markerLength;
    const omitted = points.length - kept;
    if (String(omitted).length > digits) continue;
    const head = Math.ceil(kept / 2);
    return `${points.slice(0, head).join("")}… [${omitted} characters omitted] …${points.slice(points.length - (kept - head)).join("")}`;
  }
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
export function isUserCancelled(
  result: RunResult,
  principals?: Pick<PrincipalRepository, "getUser">
): boolean {
  return Boolean(result.interruptSource && principals?.getUser(result.interruptSource));
}

function routeMechanicalFailureNotice(
  deps: FailureSinkDeps,
  actorId: string,
  label: "run failed" | "capped",
  summary: string,
  exitCode?: number,
  result?: RunResult,
  runId?: string
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
    sendFailureToParent(deps, record.parentId, `[${label}] ${summary}${extraMessage}`, actorId, {
      // Older direct callers have no durable run record. Lifecycle callers
      // pass the UUID so the parent can inspect the exact failed attempt.
      runId: runId ?? actorId,
      actorId,
      exitCode,
      abortReason: result?.abortReason,
    });
    return;
  }

  if (actorId === deps.rootId) {
    if (result && isUserCancelled(result, deps.principals)) {
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
