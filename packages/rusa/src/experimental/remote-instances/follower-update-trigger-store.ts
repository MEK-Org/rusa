import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isFullCommitSha, isSafeFollowerBranch } from "./follower-update-validation.js";

/**
 * Schema version of the on-disk trigger document.
 *
 * This exists for the diagnostic, not for forward-compatibility: it is what lets a
 * malformed or foreign document be *reported* as such rather than read as absence.
 * "No active trigger" is the silent do-nothing path, so it must not double as the
 * error path.
 */
export const FOLLOWER_UPDATE_TRIGGER_VERSION = 1;

export interface FollowerUpdateAttempt {
  status: "pending" | "success" | "failed";
  lastAttemptAt: string;
  error?: string;
  targetSha: string;
}

export interface FollowerUpdateTrigger {
  version: number;
  triggerId: string;
  targetSha: string;
  branch: string;
  createdAt: string;
  attempts: Record<string, FollowerUpdateAttempt>;
}

export interface CreateTriggerOptions {
  targetSha: string;
  branch: string;
}

/**
 * Outcome of reading the trigger document. `absent` and `invalid` are kept distinct so
 * an unreadable document is visible to an operator instead of looking like "nothing to do".
 */
export type TriggerLoadResult =
  | { kind: "absent" }
  | { kind: "ok"; trigger: FollowerUpdateTrigger }
  | { kind: "invalid"; reason: string };

const ATTEMPT_STATUSES = new Set(["pending", "success", "failed"]);

function isAttempt(value: unknown): value is FollowerUpdateAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (typeof a.status !== "string" || !ATTEMPT_STATUSES.has(a.status)) return false;
  if (typeof a.targetSha !== "string" || !isFullCommitSha(a.targetSha)) return false;
  if (typeof a.lastAttemptAt !== "string") return false;
  if (a.error !== undefined && typeof a.error !== "string") return false;
  return true;
}

/** Validates the one explicit shape this binary understands, reporting why it failed. */
function validate(parsed: unknown): TriggerLoadResult {
  if (!parsed || typeof parsed !== "object") {
    return { kind: "invalid", reason: "document is not an object" };
  }
  const t = parsed as Record<string, unknown>;
  if (t.version !== FOLLOWER_UPDATE_TRIGGER_VERSION) {
    return {
      kind: "invalid",
      reason: `unsupported schema version ${String(t.version)} (expected ${FOLLOWER_UPDATE_TRIGGER_VERSION})`,
    };
  }
  for (const field of ["triggerId", "targetSha", "branch", "createdAt"] as const) {
    if (typeof t[field] !== "string" || (t[field] as string).length === 0) {
      return { kind: "invalid", reason: `missing or invalid '${field}'` };
    }
  }
  if (!isFullCommitSha(t.targetSha as string)) {
    return {
      kind: "invalid",
      reason: `invalid 'targetSha': '${String(t.targetSha)}' is not a full commit SHA`,
    };
  }
  if (!isSafeFollowerBranch(t.branch as string)) {
    return {
      kind: "invalid",
      reason: `invalid 'branch': '${String(t.branch)}' is not a safe branch name`,
    };
  }
  if (!t.attempts || typeof t.attempts !== "object" || Array.isArray(t.attempts)) {
    return { kind: "invalid", reason: "missing or invalid 'attempts'" };
  }
  for (const [followerId, attempt] of Object.entries(t.attempts as Record<string, unknown>)) {
    if (!isAttempt(attempt)) {
      return { kind: "invalid", reason: `invalid attempt record for follower '${followerId}'` };
    }
  }
  return { kind: "ok", trigger: parsed as FollowerUpdateTrigger };
}

export class FollowerUpdateTriggerStore {
  readonly filePath: string;

  constructor(filePathOrDir: string) {
    if (filePathOrDir.endsWith(".json")) {
      this.filePath = filePathOrDir;
    } else {
      this.filePath = join(filePathOrDir, "follower-update-trigger.json");
    }
  }

  /**
   * Reads the trigger document, distinguishing absence from corruption. Callers surface
   * `invalid` through the application logger; it never throws, so a bad document cannot
   * block leader startup.
   */
  read(): TriggerLoadResult {
    if (!existsSync(this.filePath)) {
      return { kind: "absent" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch (err) {
      return {
        kind: "invalid",
        reason: `unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return validate(parsed);
  }

  load(): FollowerUpdateTrigger | null {
    const result = this.read();
    return result.kind === "ok" ? result.trigger : null;
  }

  save(trigger: FollowerUpdateTrigger): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = JSON.stringify(trigger, null, 2);
    try {
      writeFileSync(tempPath, payload, "utf-8");
      renameSync(tempPath, this.filePath);
    } catch (err) {
      try {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { force: true });
        }
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }

  /** Writing a new trigger supersedes any previous one, which is what bounds staleness. */
  createTrigger(options: CreateTriggerOptions): FollowerUpdateTrigger {
    const trigger: FollowerUpdateTrigger = {
      version: FOLLOWER_UPDATE_TRIGGER_VERSION,
      triggerId: randomBytes(16).toString("hex"),
      targetSha: options.targetSha,
      branch: options.branch,
      createdAt: new Date().toISOString(),
      attempts: {},
    };
    this.save(trigger);
    return trigger;
  }

  getActiveTrigger(): FollowerUpdateTrigger | null {
    return this.load();
  }

  recordAttempt(followerId: string, attempt: FollowerUpdateAttempt): FollowerUpdateTrigger | null {
    const trigger = this.getActiveTrigger();
    if (!trigger) return null;
    trigger.attempts[followerId] = attempt;
    this.save(trigger);
    return trigger;
  }

  recordSuccess(followerId: string, targetSha: string): FollowerUpdateTrigger | null {
    return this.recordAttempt(followerId, {
      status: "success",
      targetSha,
      lastAttemptAt: new Date().toISOString(),
    });
  }

  recordFailure(
    followerId: string,
    targetSha: string,
    error?: string
  ): FollowerUpdateTrigger | null {
    return this.recordAttempt(followerId, {
      status: "failed",
      targetSha,
      error,
      lastAttemptAt: new Date().toISOString(),
    });
  }

  hasFailed(followerId: string, targetSha: string): boolean {
    const trigger = this.getActiveTrigger();
    if (!trigger) return false;
    const attempt = trigger.attempts[followerId];
    return attempt?.status === "failed" && attempt?.targetSha === targetSha;
  }

  hasSucceeded(followerId: string, targetSha: string): boolean {
    const trigger = this.getActiveTrigger();
    if (!trigger) return false;
    const attempt = trigger.attempts[followerId];
    return attempt?.status === "success" && attempt?.targetSha === targetSha;
  }

  /**
   * Whether every follower in `followerIds` has reached the trigger's target.
   *
   * Deliberately an observation, not a state transition: the caller passes the followers
   * it can currently see, and the leader has no durable enrollment roster, so this can
   * never establish that *all* enrolled followers are current. Completing the trigger on
   * it would strand a follower that was offline during the leader update — which is the
   * case the durable document exists to serve.
   */
  allCurrent(followerIds: string[]): boolean {
    const trigger = this.getActiveTrigger();
    if (!trigger) return false;
    if (followerIds.length === 0) return false;

    return followerIds.every((id) => {
      const attempt = trigger.attempts[id];
      return attempt?.status === "success" && attempt?.targetSha === trigger.targetSha;
    });
  }
}
