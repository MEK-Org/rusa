import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FollowerUpdateAttempt {
  status: "pending" | "success" | "failed";
  lastAttemptAt: string;
  error?: string;
  targetSha: string;
}

export interface FollowerUpdateTrigger {
  triggerId: string;
  targetSha: string;
  branch: string;
  createdAt: string;
  source: "leader-update" | "operator";
  autoReconcile: boolean;
  attempts: Record<string, FollowerUpdateAttempt>;
  completedAt?: string;
}

export interface CreateTriggerOptions {
  targetSha: string;
  branch: string;
  source?: "leader-update" | "operator";
  autoReconcile?: boolean;
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

  load(): FollowerUpdateTrigger | null {
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const content = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as FollowerUpdateTrigger;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.triggerId !== "string" ||
        typeof parsed.targetSha !== "string"
      ) {
        return null;
      }
      if (!parsed.attempts || typeof parsed.attempts !== "object") {
        parsed.attempts = {};
      }
      return parsed;
    } catch {
      return null;
    }
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

  createTrigger(options: CreateTriggerOptions): FollowerUpdateTrigger {
    const trigger: FollowerUpdateTrigger = {
      triggerId: randomBytes(16).toString("hex"),
      targetSha: options.targetSha,
      branch: options.branch,
      createdAt: new Date().toISOString(),
      source: options.source ?? "leader-update",
      autoReconcile: options.autoReconcile ?? true,
      attempts: {},
    };
    this.save(trigger);
    return trigger;
  }

  getActiveTrigger(): FollowerUpdateTrigger | null {
    const trigger = this.load();
    if (!trigger || trigger.completedAt) {
      return null;
    }
    return trigger;
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

  markCompleted(): FollowerUpdateTrigger | null {
    const trigger = this.getActiveTrigger();
    if (!trigger) return null;
    trigger.completedAt = new Date().toISOString();
    this.save(trigger);
    return trigger;
  }

  checkCompletion(connectedFollowerIds: string[]): boolean {
    const trigger = this.getActiveTrigger();
    if (!trigger) return false;
    if (connectedFollowerIds.length === 0) return false;

    const allSucceeded = connectedFollowerIds.every((id) => {
      const attempt = trigger.attempts[id];
      return attempt?.status === "success" && attempt?.targetSha === trigger.targetSha;
    });

    if (allSucceeded) {
      this.markCompleted();
      return true;
    }
    return false;
  }

  clear(): void {
    if (existsSync(this.filePath)) {
      try {
        rmSync(this.filePath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
