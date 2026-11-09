import type { ActorRecord } from "../actor/actor-record.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { LegacyImportReceiptRepository } from "./repositories/legacy-import-receipt-repository.js";

/** Receipt source for the configured-actor import. */
export const CONFIGURED_ACTOR_IMPORT_SOURCE = "config.yaml:rootActor";

/**
 * Startup refused to resolve the configured actor from its import receipt.
 * Carries what an operator can do about it, in words that fit one journal line,
 * and the candidate ids it considered.
 */
export class ConfiguredActorImportError extends Error {
  override readonly name = "ConfiguredActorImportError";
  readonly action: string;
  readonly candidates: string[];

  constructor(message: string, action: string, candidates: string[] = []) {
    super(message);
    this.action = action;
    this.candidates = candidates;
  }
}

export interface ResolveConfiguredActorOptions {
  receipts: Pick<LegacyImportReceiptRepository, "has" | "actorFor" | "rowCount">;
  actors: Pick<ActorRepository, "get">;
}

/**
 * Resolves the configured root actor from its durable legacy import receipt (#1002, #1261).
 *
 * The one-time configured actor import ran in earlier releases (#1002). In #1261,
 * the `rootActor` configuration block and the import planner/executor were removed:
 * boot reads the existing receipt and writes nothing.
 *
 * Returns:
 * - The stored `ActorRecord` when a receipt names an existing actor.
 * - `undefined` when no receipt exists (e.g. a fresh install created after #1261)
 *   or when a 0-row receipt exists (from an empty store boot in an earlier release).
 *
 * Throws {@link ConfiguredActorImportError} if a receipt row exists but is broken:
 * - A receipt row exists with non-zero row count but names no actor.
 * - A receipt row names an actor that has no row in the actors table.
 */
export function resolveConfiguredActor(
  options: ResolveConfiguredActorOptions
): ActorRecord | undefined {
  const { receipts, actors } = options;

  if (!receipts.has(CONFIGURED_ACTOR_IMPORT_SOURCE)) {
    return undefined;
  }

  const actorId = receipts.actorFor(CONFIGURED_ACTOR_IMPORT_SOURCE);
  if (actorId === undefined && receipts.rowCount(CONFIGURED_ACTOR_IMPORT_SOURCE) === 0) {
    return undefined;
  }

  if (actorId === undefined) {
    throw new ConfiguredActorImportError(
      "the configured-actor import receipt names no actor",
      "restore the receipt's actor_id in mesh.db's legacy_import_receipts table; startup will not guess which actor it imported"
    );
  }

  const record = actors.get(actorId);
  if (!record) {
    throw new ConfiguredActorImportError(
      `the imported configured actor ${actorId} has no actor record`,
      "restore its row in mesh.db's actors table from a backup; startup will not create a replacement for an imported actor",
      [actorId]
    );
  }

  return record;
}
