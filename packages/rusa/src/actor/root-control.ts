import type { ModelConfigInput, ProviderModelConfig } from "../providers/model-config.js";
import type { ActorHandle, ContextConfig, ThreadRecord } from "./thread-registry.js";

export type RootControlPrincipal = "root-llm" | "human:operator" | "e2e-controller";

export interface RootChildRequest {
  charter: string;
  modelConfig: ModelConfigInput;
  context?: ContextConfig;
  maxRuns?: number;
  conversationId?: string;
  title?: string;
}

export interface RootControlMesh {
  spawn(request: {
    charter: string;
    parentId: string;
    modelConfig: ModelConfigInput;
    context?: ContextConfig;
    budget?: { maxRuns: number };
    conversationId?: string;
    title?: string;
  }): string;
  sendMessage(
    toId: string,
    body: string,
    fromId: string,
    sessionId?: string,
    deliverAt?: string
  ): {
    delivered: boolean;
    status?: string;
  };
  grantHandle(holderId: string, handle: ActorHandle): void;
  isAncestorOf(ancestorId: string, id: string): boolean;
  retire(id: string, opts?: { force?: boolean; forceQueued?: boolean }): void;
  interrupt(id: string, by?: string): { interrupted: boolean; status?: string };
  runNow(id: string, source?: string): { queued: boolean };
  recordEvent(event: {
    kind: "root_control_action";
    actorId: string;
    detail?: string;
    payload?: string;
  }): void;
  list(): ThreadRecord[];
}

export interface RootControlOptions {
  mesh: RootControlMesh;
  rootId?: string;
  providers?: string[];
}

/**
 * Commands performed with the root actor's authority, independent of transport.
 * The ownership graph continues to name `root`; the principal is recorded as
 * provenance rather than masquerading as the logical actor.
 */
export class RootControlService {
  readonly rootId: string;
  readonly providers: string[];

  constructor(private readonly options: RootControlOptions) {
    this.rootId = options.rootId ?? "root";
    this.providers = [...new Set(options.providers ?? [])].sort();
  }

  spawnChild(request: RootChildRequest, principal: RootControlPrincipal): string {
    const charter = request.charter?.trim();
    if (!charter) throw new Error("charter is required");
    const pool: readonly ProviderModelConfig[] = Array.isArray(request.modelConfig)
      ? request.modelConfig
      : [request.modelConfig];
    if (pool.length === 0) throw new Error("modelConfig is required");
    if (this.providers.length > 0) {
      for (const { provider } of pool) {
        if (!this.providers.includes(provider)) {
          throw new Error(`unknown provider: ${provider}`);
        }
      }
    }
    if (
      request.maxRuns !== undefined &&
      (!Number.isInteger(request.maxRuns) || request.maxRuns < 1)
    ) {
      throw new Error("maxRuns must be a positive integer");
    }
    const id = this.options.mesh.spawn({
      charter,
      parentId: this.rootId,
      modelConfig: request.modelConfig,
      context: normalizeContext(request.context),
      budget: request.maxRuns ? { maxRuns: request.maxRuns } : undefined,
      conversationId: optionalTrimmed(request.conversationId),
      title: optionalTrimmed(request.title),
    });
    this.record(principal, "spawn_child", id, {
      modelConfig: pool,
      context: normalizeContext(request.context),
    });
    return id;
  }

  sendMessage(
    toId: string,
    body: string,
    principal: RootControlPrincipal,
    deliverAt?: string
  ): void {
    const text = body.trim();
    if (!text) throw new Error("message body is required");
    const result = this.options.mesh.sendMessage(toId, text, this.rootId, undefined, deliverAt);
    if (!result.delivered) {
      if (!result.status) {
        throw new Error(`unknown thread id: ${toId}`);
      }
      throw new Error(`dropped — recipient ${toId} is not live (status: ${result.status})`);
    }
    this.record(principal, "send_message", toId, { deliverAt });
  }

  grantHandle(holderId: string, handle: ActorHandle, principal: RootControlPrincipal): void {
    this.options.mesh.grantHandle(holderId, handle);
    this.record(principal, "grant_handle", handle.id, { holderId });
  }

  /**
   * Retire a root descendant. Refused while that subtree has a run in flight
   * unless `force` is set.
   *
   * The operator keeps the override that the actor-facing `retire_thread` tool does not
   * get: an actor must never be able to end a busy sibling's run, but a human looking at
   * a wedged thread must still be able to end it, or the guard becomes a way to make a
   * stuck actor immortal. The override is audited — `force` lands in the control record.
   */
  retireChild(
    id: string,
    principal: RootControlPrincipal,
    opts: { force?: boolean; forceQueued?: boolean } = {}
  ): void {
    if (id === this.rootId || !this.options.mesh.isAncestorOf(this.rootId, id)) {
      throw new Error("root control may only retire root descendants");
    }
    this.options.mesh.retire(id, { force: opts.force, forceQueued: opts.forceQueued });
    this.record(
      principal,
      "retire_child",
      id,
      opts.force ? { force: true } : opts.forceQueued ? { forceQueued: true } : {}
    );
  }

  interruptChild(
    id: string,
    principal: RootControlPrincipal
  ): { interrupted: boolean; status?: string } {
    if (id !== this.rootId && !this.options.mesh.isAncestorOf(this.rootId, id)) {
      throw new Error("root control may only interrupt root descendants");
    }
    const result = this.options.mesh.interrupt(id, principal);
    this.record(principal, "interrupt_child", id, { interrupted: result.interrupted });
    return result;
  }

  runNowChild(id: string, principal: RootControlPrincipal): { queued: boolean } {
    if (id !== this.rootId && !this.options.mesh.isAncestorOf(this.rootId, id)) {
      throw new Error("root control may only run root descendants");
    }
    const result = this.options.mesh.runNow(id, principal);
    this.record(principal, "run_now_child", id);
    return result;
  }

  listChildren(): ThreadRecord[] {
    return this.options.mesh.list().filter((record) => record.parentId === this.rootId);
  }

  recordDriverAttached(principal: RootControlPrincipal): void {
    this.record(principal, "attach_driver", this.rootId);
  }

  private record(
    principal: RootControlPrincipal,
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {}
  ): void {
    this.options.mesh.recordEvent({
      kind: "root_control_action",
      actorId: this.rootId,
      detail: `${principal} ${action}`,
      payload: JSON.stringify({ principal, action, targetId, ...metadata }),
    });
  }
}

function normalizeContext(context: ContextConfig | undefined): ContextConfig | undefined {
  if (!context) return undefined;
  if (context.type === "native") return { type: "native" };
  return {
    type: "portable",
    mode: context.mode,
    compactionModel: optionalTrimmed(context.compactionModel),
  };
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
