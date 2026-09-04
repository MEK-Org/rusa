import { randomUUID } from "node:crypto";
import type { ActorRepository } from "../repositories/actor-repository.js";

/** Select the durable root identity, minting one only for a completely empty repository. */
export function resolveRootActorId(
  actors: ActorRepository,
  idgen: () => string = randomUUID
): string {
  const roots = actors.list().filter((record) => record.parentId === null);
  if (roots.length > 1) {
    throw new Error(`multiple root records found: ${roots.map((record) => record.id).join(", ")}`);
  }
  return roots[0]?.id ?? idgen();
}
