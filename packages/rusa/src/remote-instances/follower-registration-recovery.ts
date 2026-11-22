import type { ActorMesh, MeshActor } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import type { ActorLiveness } from "../actor/workspace-sweep.js";
import type { Logger } from "../observability/logger.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { FollowerHub } from "./follower-hub.js";
import type { RemoteInstance } from "./remote-instance.js";

type ReattachableActor = MeshActor & { attachHost?: (host: unknown) => void };

/**
 * Send `workspaceSweep` when a follower actor exits if the leader's registry
 * already marks that actor retired on this follower (#1338).
 *
 * The follower emits `{ type: "exit" }` only after removing the actor from its
 * live runtime map, so sweeping here avoids racing against a still-closing
 * runtime while keeping the follower stateless (one sweep rule, one deletion
 * site). Empty or unreadable registries never send a sweep.
 */
export function sweepRetiredFollowerActorOnExit(deps: {
  followerId: string;
  actorId: string;
  actors: Pick<ActorRepository, "list"> & Partial<Pick<ActorRepository, "get">>;
  sweepWorkspaces: (followerId: string, actors: readonly ActorLiveness[]) => void;
  onError?: (err: unknown) => void;
}): boolean {
  try {
    const record = deps.actors.get
      ? deps.actors.get(deps.actorId)
      : deps.actors.list().find((entry) => entry.id === deps.actorId);
    if (
      !record ||
      record.status !== "retired" ||
      record.executionConfig?.executionTarget !== deps.followerId
    ) {
      return false;
    }
    const allActors = deps.actors.list();
    if (allActors.length === 0) return false;
    deps.sweepWorkspaces(
      deps.followerId,
      allActors.map((entry) => ({ id: entry.id, retired: entry.status === "retired" }))
    );
    return true;
  } catch (err) {
    deps.onError?.(err);
    return false;
  }
}

export interface FollowerRegistrationRecoveryDeps {
  actors: Pick<ActorRepository, "list"> & Partial<Pick<ActorRepository, "get">>;
  hub: Pick<
    FollowerHub,
    "onRegister" | "onPlacementReleased" | "rebindHost" | "stopActor" | "sweepWorkspaces"
  > &
    Partial<Pick<FollowerHub, "onActorExit">>;
  log: Pick<Logger, "warn">;
  mesh: Pick<ActorMesh, "dispatch" | "get" | "rehydrate">;
}

/**
 * Reconcile leader-side actor handles whenever a follower generation registers.
 *
 * This is deliberately a shared composition seam: `rusa start` installs it as
 * the hub listener, while the synthetic relaunch regression drives this exact
 * body through a real hub registration. A dispatch is content-free and rereads
 * the durable inbox and its priority (#568), so it recovers work left unhandled
 * while the old follower was absent without turning registration into a second
 * producer.
 *
 * The same seam owns the dispatch when a follower's update hold lifts (#1272):
 * runs that hold deferred are asked for again once, from the durable inbox.
 */
export function registerFollowerRegistrationRecovery({
  actors,
  hub,
  log,
  mesh,
}: FollowerRegistrationRecoveryDeps): () => void {
  const unregisterReleased = hub.onPlacementReleased((followerId) => {
    for (const record of actors.list()) {
      if (record.executionConfig?.executionTarget !== followerId) continue;
      if (record.status !== "active" || !mesh.get(record.id)) continue;
      mesh
        .dispatch(record.id)
        .catch((err) =>
          log.warn("follower_release_dispatch_failed", { actorId: record.id, followerId, err })
        );
    }
  });
  const unregisterRegister = hub.onRegister((follower: RemoteInstance) => {
    let allActors: ActorRecord[];
    try {
      allActors = actors.list();
    } catch (err) {
      log.warn("follower_register_registry_read_failed", { followerId: follower.id, err });
      return;
    }
    for (const record of allActors) {
      if (record.executionConfig?.executionTarget !== follower.id) continue;
      if (record.status !== "active") {
        hub.stopActor(follower.id, record.id);
        continue;
      }
      const existing = mesh.get(record.id);
      const dispatch = () =>
        mesh.dispatch(record.id).catch((err) =>
          log.warn("follower_register_dispatch_failed", {
            actorId: record.id,
            followerId: follower.id,
            err,
          })
        );
      if (!existing) {
        mesh.rehydrate(record);
        void dispatch();
        continue;
      }
      const reattachable = existing as ReattachableActor;
      if (typeof reattachable.attachHost !== "function") continue;
      try {
        reattachable.attachHost(hub.rebindHost(follower.id, record.id));
      } catch (err) {
        log.warn("follower_reconnect_attach_failed", {
          actorId: record.id,
          followerId: follower.id,
          err,
        });
        continue;
      }
      void dispatch();
    }
    if (allActors.length > 0) {
      hub.sweepWorkspaces(
        follower.id,
        allActors.map((record) => ({ id: record.id, retired: record.status === "retired" }))
      );
    }
  });
  const unregisterExit =
    hub.onActorExit?.((follower, actorId) => {
      sweepRetiredFollowerActorOnExit({
        followerId: follower.id,
        actorId,
        actors,
        sweepWorkspaces: (id, list) => hub.sweepWorkspaces(id, list),
        onError: (err) =>
          log.warn("follower_exit_sweep_registry_read_failed", {
            followerId: follower.id,
            actorId,
            err,
          }),
      });
    }) ?? (() => {});
  return () => {
    unregisterExit();
    unregisterRegister();
    unregisterReleased();
  };
}
