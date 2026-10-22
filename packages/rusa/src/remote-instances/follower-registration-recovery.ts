import type { ActorMesh, MeshActor } from "../actor/actor-mesh.js";
import type { Logger } from "../observability/logger.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { FollowerHub } from "./follower-hub.js";
import type { RemoteInstance } from "./remote-instance.js";

type ReattachableActor = MeshActor & { attachHost?: (host: unknown) => void };

export interface FollowerRegistrationRecoveryDeps {
  actors: Pick<ActorRepository, "list">;
  hub: Pick<FollowerHub, "rebindHost" | "stopActor">;
  log: Pick<Logger, "warn">;
  mesh: Pick<ActorMesh, "dispatch" | "get" | "rehydrate">;
}

/**
 * Reconcile leader-side actor handles whenever a follower generation registers.
 *
 * This is deliberately a shared composition seam: `rusa start` installs it as
 * the hub listener, while the synthetic relaunch regression drives this exact
 * body through a real hub registration. A dispatch is content-free and rereads
 * the durable inbox, so it recovers work left unhandled while the old follower
 * was absent without turning the registration event into a second producer.
 */
export function recoverFollowerRegistration(
  { actors, hub, log, mesh }: FollowerRegistrationRecoveryDeps,
  follower: RemoteInstance
): void {
  for (const record of actors.list()) {
    if (record.executionConfig?.executionTarget !== follower.id) continue;
    if (record.status !== "active") {
      hub.stopActor(follower.id, record.id);
      continue;
    }
    const existing = mesh.get(record.id);
    if (!existing) {
      mesh.rehydrate(record);
      mesh.dispatch(record.id);
      continue;
    }
    const reattachable = existing as ReattachableActor;
    if (typeof reattachable.attachHost !== "function") continue;
    try {
      reattachable.attachHost(hub.rebindHost(follower.id, record.id));
      mesh.dispatch(record.id);
    } catch (err) {
      log.warn("follower_reconnect_attach_failed", {
        actorId: record.id,
        followerId: follower.id,
        err,
      });
    }
  }
}

/** Kept explicit so the production registration listener and tests bind alike. */
export function registerFollowerRegistrationRecovery(
  deps: Omit<FollowerRegistrationRecoveryDeps, "hub"> & {
    hub: FollowerRegistrationRecoveryDeps["hub"] & Pick<FollowerHub, "onRegister">;
  }
): () => void {
  return deps.hub.onRegister((follower) => recoverFollowerRegistration(deps, follower));
}
