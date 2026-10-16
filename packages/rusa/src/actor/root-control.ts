import type { AvailabilityHoldScope } from "../db/repositories/availability-hold-repository.js";
import {
  assertConcreteModelConfig,
  type ConcreteModelConfigInput,
  type ModelConfigInput,
  type ProviderModelConfig,
} from "../providers/model-config.js";
import type { ActorHandle, ActorRecord, ContextConfig } from "./actor-record.js";
import { defaultGrantRecipient } from "./administrative-capabilities.js";
import type { AvailabilityHolds, ClearedHolds } from "./availability-holds.js";

/**
 * UUID string format representing a durable user principal ID.
 */
export type UserPrincipalId = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Principals authorized to execute root-level control actions.
 * Constrained to well-known infrastructure literals or a verified user principal UUID.
 */
export type RootControlPrincipal = "root-llm" | "e2e-controller" | UserPrincipalId;

export interface RootChildRequest {
  executionTarget?: string;
  charter: string;
  modelConfig: ModelConfigInput;
  context?: ContextConfig;
  conversationId?: string;
  title?: string;
}

export interface RootControlMesh {
  spawn(request: {
    executionTarget?: string;
    charter: string;
    parentId: string | null;
    modelConfig: ModelConfigInput;
    context?: ContextConfig;
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
  interrupt(id: string, by: string): { interrupted: boolean; status?: string };
  runNow(id: string, source?: string): { queued: boolean };
  recordEvent(event: {
    kind: "root_control_action";
    actorId: string;
    detail?: string;
    payload?: string;
  }): void;
  list(): ActorRecord[];
}

export interface RootControlOptions {
  mesh: RootControlMesh;
  rootId?: string;
  providers?: string[];
  /**
   * The live durable-hold service. Its release callback restores eligibility
   * and replays any admission it previously cancelled.
   */
  availabilityHolds?: Pick<AvailabilityHolds, "clear">;
  /**
   * Resolves a named model class reference against the runtime database before
   * anything else inspects the request. Wired in by the runtime, which owns the store;
   * without it a class reference is rejected rather than silently mis-read.
   */
  resolveModelConfig?: (input: ModelConfigInput) => ConcreteModelConfigInput;
}

/**
 * Commands performed with the root actor's authority, independent of transport.
 * The ownership graph continues to name `root`; the principal is recorded as
 * provenance rather than masquerading as the logical actor.
 */
export class RootControlService {
  get rootId(): string | undefined {
    return this.options.rootId ?? defaultGrantRecipient(this.options.mesh.list())?.id;
  }
  readonly providers: string[];

  constructor(private readonly options: RootControlOptions) {
    this.providers = [...new Set(options.providers ?? [])].sort();
  }

  spawnChild(request: RootChildRequest, principal: RootControlPrincipal): string {
    const rootId = this.rootId;
    if (rootId === undefined && principal === "root-llm") {
      throw new Error("only an authenticated operator may create a top-level actor");
    }
    const charter = request.charter?.trim();
    if (!charter) throw new Error("charter is required");
    // Resolve named model classes first: the provider allowlist below, the
    // audit record, and the mesh all have to see the same concrete pool.
    const requested = this.options.resolveModelConfig
      ? this.options.resolveModelConfig(request.modelConfig)
      : assertConcreteModelConfig(request.modelConfig);
    const rawPool = Array.isArray(requested) ? requested : [requested];
    if (rawPool.length === 0) throw new Error("modelConfig is required");
    if (this.providers.length > 0) {
      for (const { provider } of rawPool) {
        if (!this.providers.includes(provider)) {
          throw new Error(`unknown provider: ${provider}`);
        }
      }
    }
    // The real config-aware validation (including the required-model check,
    // #169) happens inside mesh.spawn; this local pool is only for the
    // provider-allowlist check above and the event-log record below, so it
    // must not silently accept a missing model either.
    const pool: readonly ProviderModelConfig[] = rawPool.map((entry) => {
      const model = entry.model?.trim();
      if (!model)
        throw new Error(`modelConfig entry for provider "${entry.provider}" is missing a model`);
      return { provider: entry.provider, model, effort: entry.effort };
    });
    const id = this.options.mesh.spawn({
      // Every *defined* target is forwarded, blank included: mesh.spawn is the
      // fail-closed gate, and a target erased here would reach it as an
      // omission, i.e. as "run locally".
      ...(request.executionTarget !== undefined
        ? { executionTarget: request.executionTarget }
        : {}),
      charter,
      parentId: rootId ?? null,
      // Keep the original declaration for mesh.spawn. Root control uses the
      // resolved snapshot above only for its provider allowlist; mesh is the
      // authoritative resolution/validation boundary and derives provenance
      // from this original class reference rather than a caller-settable field.
      modelConfig: request.modelConfig,
      context: normalizeContext(request.context),
      conversationId: optionalTrimmed(request.conversationId),
      title: optionalTrimmed(request.title),
    });
    this.record(
      principal,
      "spawn_child",
      id,
      {
        modelConfig: pool,
        context: normalizeContext(request.context),
      },
      rootId ?? id
    );
    return id;
  }

  sendMessage(
    toId: string,
    body: string,
    principal: RootControlPrincipal,
    deliverAt?: string,
    sessionId?: string
  ): void {
    const rootId = this.requireRootId();
    const text = body.trim();
    if (!text) throw new Error("message body is required");
    const result = this.options.mesh.sendMessage(toId, text, rootId, sessionId, deliverAt);
    if (!result.delivered) {
      if (!result.status) {
        throw new Error(`unknown thread id: ${toId}`);
      }
      throw new Error(`dropped — recipient ${toId} is not live (status: ${result.status})`);
    }
    this.record(principal, "send_message", toId, { deliverAt });
  }

  grantHandle(holderId: string, handle: ActorHandle, principal: RootControlPrincipal): void {
    this.requireRootId();
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
    const rootId = this.requireRootId();
    if (id === rootId || !this.options.mesh.isAncestorOf(rootId, id)) {
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
    const rootId = this.requireRootId();
    if (id !== rootId && !this.options.mesh.isAncestorOf(rootId, id)) {
      throw new Error("root control may only interrupt root descendants");
    }
    const result = this.options.mesh.interrupt(id, principal);
    this.record(principal, "interrupt_child", id, { interrupted: result.interrupted });
    return result;
  }

  runNowChild(id: string, principal: RootControlPrincipal): { queued: boolean } {
    const rootId = this.requireRootId();
    if (id !== rootId && !this.options.mesh.isAncestorOf(rootId, id)) {
      throw new Error("root control may only run root descendants");
    }
    const result = this.options.mesh.runNow(id, principal);
    this.record(principal, "run_now_child", id);
    return result;
  }

  /**
   * Clear durable availability holds from the authenticated dashboard control
   * boundary. This is deliberately independent of any actor MCP endpoint or
   * model run: the hold service performs the release/replay transition itself.
   */
  clearAvailabilityHolds(
    scope: AvailabilityHoldScope,
    principal: RootControlPrincipal
  ): ClearedHolds {
    const availabilityHolds = this.options.availabilityHolds;
    if (!availabilityHolds) throw new Error("availability hold recovery is unavailable");
    const rootId = this.requireRootId();
    const result = availabilityHolds.clear(scope);
    if (result.released.length + result.expired.length > 0) {
      this.record(principal, "clear_availability_holds", rootId, {
        provider: scope.provider,
        models: scope.models ?? [],
        released: result.released.length,
        expiredRemoved: result.expired.length,
      });
    }
    return result;
  }

  listChildren(): ActorRecord[] {
    const rootId = this.requireRootId();
    return this.options.mesh.list().filter((record) => record.parentId === rootId);
  }

  recordDriverAttached(principal: RootControlPrincipal): void {
    this.record(principal, "attach_driver", this.requireRootId());
  }

  private record(
    principal: RootControlPrincipal,
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
    actorId: string = this.requireRootId()
  ): void {
    this.options.mesh.recordEvent({
      kind: "root_control_action",
      actorId,
      detail: `${principal} ${action}`,
      payload: JSON.stringify({ principal, action, targetId, ...metadata }),
    });
  }

  private requireRootId(): string {
    if (this.rootId) return this.rootId;
    throw new Error("root control is unavailable until an operator creates an actor");
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
