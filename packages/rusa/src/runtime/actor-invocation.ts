import { Actor, type ActorOptions } from "../actor/actor.js";
import type { MeshActor } from "../actor/actor-mesh.js";

/**
 * The one construction input for a live actor invocation.
 *
 * Composition builds the complete runtime options before this boundary. That
 * keeps durable records, parent/child policy, and capability-to-MCP projection
 * in their existing owners while ensuring configured roots and workers use the
 * same final construction path. `ActorOptions` remains intact here so this
 * behavior-preserving slice does not move lifecycle wiring; #385 owns replacing
 * those current callbacks with the lifecycle contract.
 */
export interface ActorInvocationInput {
  /** The sole source of constructor values, including opaque actor identity and sandbox policy. */
  actorOptions: ActorOptions;
  /** Optional E2E/remote execution driver; absent means the local Actor driver. */
  driver?: (options: ActorOptions) => MeshActor;
}

/**
 * Construct one configured, spawned, or rehydrated actor through the same
 * invocation boundary. The boundary has no durable record or topology inputs:
 * it only dispatches the explicitly composed runtime options to its driver.
 */
export function constructActorFromInvocation(input: ActorInvocationInput): MeshActor {
  return input.driver?.(input.actorOptions) ?? new Actor(input.actorOptions);
}
