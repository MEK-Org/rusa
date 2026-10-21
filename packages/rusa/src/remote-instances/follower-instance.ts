import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ComputerUseLock } from "../actor/computer-use-lock.js";
import type { FollowerRepositories } from "../db/repositories/index.js";
import { createActorRuntime } from "./actor-runtime.js";
import { createProvider } from "./configured-provider.js";
import type { FollowerActorCommand, FollowerEvent } from "./follower-hub.js";
import type {
  FollowerFileOperation,
  FollowerFileOperationResult,
  ProviderFactory,
} from "./protocol.js";

/** Runs one leader-authorized provider download inside an actor's working directory (#1013). */
export type FollowerFileOps = (
  workDir: string,
  operation: FollowerFileOperation
) => Promise<FollowerFileOperationResult>;

export interface FollowerInstanceOptions {
  requireReconciliation?: boolean;
  repositories?: FollowerRepositories;
  /** Provider executable/settings belong to this host, never the leader Bootstrap. */
  providerOptions?: Record<string, unknown>;
  /** Without it, this follower refuses every `fileOp`. */
  fileOps?: FollowerFileOps;
}

/** Execution half of an instance: many ordinary Actors, one Node process. */
export class FollowerInstance {
  private actors = new Map<string, ReturnType<typeof createActorRuntime>>();
  private stopped = false;
  private draining = false;
  private reconciled: boolean;
  private readonly repositories?: FollowerRepositories;
  private readonly providerOptions?: Record<string, unknown>;
  private readonly computerUseLock = new ComputerUseLock();
  private readonly fileOps?: FollowerFileOps;

  constructor(
    private readonly home: string,
    private readonly sandbox: boolean,
    private readonly emit: (event: FollowerEvent) => void,
    private readonly providerFactory: ProviderFactory = createProvider,
    options?: FollowerInstanceOptions
  ) {
    mkdirSync(home, { recursive: true });
    this.reconciled = options?.requireReconciliation !== true;
    this.repositories = options?.repositories;
    this.providerOptions = options?.providerOptions;
    this.fileOps = options?.fileOps;
  }

  get isReconciled(): boolean {
    return this.reconciled;
  }

  markReconciled(): void {
    this.reconciled = true;
  }

  get actorIds(): string[] {
    return [...this.actors.keys()];
  }

  dispatch({ actorId, message }: FollowerActorCommand): void {
    if (this.stopped) return;
    // Commands, `fileOp` included, only arrive through `/poll`: `rusa start`
    // reconciles before its first poll and standalone follower.js never needs to.
    if (!this.reconciled) {
      throw new Error("Follower instance is not reconciled with leader; dispatch refused");
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(actorId)) throw new Error("Invalid actor ID");
    if (message.type === "fileOp") {
      void this.runFileOp(actorId, message.requestId, message.operation);
      return;
    }
    if (message.type !== "init") {
      this.actors.get(actorId)?.dispatch(message);
      return;
    }
    // Existing actors may finish normally during an update, but no new actor
    // is admitted once the follower has begun its bounded quiescence window.
    if (this.draining) return;
    const cwd = join(this.home, "workers", actorId);
    mkdirSync(cwd, { recursive: true });
    let actor = this.actors.get(actorId);
    if (actor) {
      if (!message.bootstrap.reconnect) {
        throw new Error("Actor already exists on follower");
      }
    } else {
      actor = createActorRuntime(
        this.providerFactory,
        (event) => this.emit({ eventId: randomUUID(), actorId, message: event }),
        () => {
          this.actors.delete(actorId);
          this.emit({
            eventId: randomUUID(),
            actorId,
            message: { type: "exit", code: 0, signal: null },
          });
        },
        this.computerUseLock,
        this.repositories
      );
      this.actors.set(actorId, actor);
    }
    actor.dispatch({
      type: "init",
      bootstrap: {
        ...message.bootstrap,
        id: actorId,
        cwd,
        providerOptions:
          this.providerOptions !== undefined || message.bootstrap.providerOptions !== undefined
            ? { ...message.bootstrap.providerOptions, ...this.providerOptions }
            : undefined,
        actorOptions: { ...message.bootstrap.actorOptions, addDirs: [], sandbox: this.sandbox },
      },
    });
  }

  private async runFileOp(
    actorId: string,
    requestId: string,
    operation: FollowerFileOperation
  ): Promise<void> {
    let outcome: { result: FollowerFileOperationResult } | { error: string };
    try {
      // Only an actor this process hosts has a working directory here to write into.
      if (!this.actors.has(actorId)) {
        throw new Error(`this follower does not host actor ${actorId}`);
      }
      if (!this.fileOps) throw new Error("this follower cannot run file operations");
      outcome = { result: await this.fileOps(join(this.home, "workers", actorId), operation) };
    } catch (err) {
      outcome = { error: err instanceof Error ? err.message : String(err) };
    }
    if (this.stopped) return;
    this.emit({
      eventId: randomUUID(),
      actorId,
      message: { type: "fileOpResult", requestId, ...outcome },
    });
  }

  beginDrain(): void {
    this.draining = true;
  }

  async waitForQuiescence(timeoutMs: number): Promise<{ quiesced: boolean; waitedMs: number }> {
    const startedAt = Date.now();
    while (this.actorIds.length && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { quiesced: this.actorIds.length === 0, waitedMs: Date.now() - startedAt };
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.computerUseLock.close();
    for (const actor of [...this.actors.values()]) actor.close();
  }
}
