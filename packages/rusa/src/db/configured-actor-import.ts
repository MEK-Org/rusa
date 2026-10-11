import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { ActorRecord, ContextConfig, ExecutionConfig } from "../actor/actor-record.js";
import { DEFAULT_ROOT_CHARTER } from "../actor/handle-generator.js";
import { ROOT_ACTOR_CHARTER } from "../actor/root-prompt.js";
import { isReservedWorkerDirectory } from "../actor/workspace-sweep.js";
import type { ProviderModelConfig } from "../providers/model-config.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { LegacyImportReceiptRepository } from "./repositories/legacy-import-receipt-repository.js";

/**
 * One-time import of the configured actor (#1002, under #465).
 *
 * Until this import, every boot picked "the" configured actor as the sole
 * parentless record and rebuilt its charter, context and execution settings
 * from `rootActor` in `config.yaml`, so config kept overwriting durable actor
 * state. The import runs exactly once. It resolves which actor the
 * configuration describes, fills only values that actor genuinely lacks, and
 * records the actor id in a receipt. From then on the receipt, not topology,
 * names the configured actor, and the actor's own row is authoritative for
 * everything config used to supply. Editing or removing `rootActor` afterwards
 * cannot overwrite that row, replay a grant, revive a retired actor, or mint a
 * replacement.
 *
 * The receipt is provenance only. Being the imported actor grants nothing:
 * capabilities stay in `capability_grants`, and topology stays topology.
 *
 * Resolution and every consistency check happen before any write. The writes
 * (a created or patched actor row plus the receipt) commit in one transaction,
 * so an interrupted import leaves either nothing or everything and the next
 * boot simply runs or skips it. The one write outside the database, copying a
 * configured avatar into the actor's image cache, runs first and is
 * idempotent: it never overwrites an existing image, so a retry after an
 * interruption finds it already done.
 */

/** Receipt source for the configured-actor import. */
export const CONFIGURED_ACTOR_IMPORT_SOURCE = "config.yaml:rootActor";

/**
 * Startup refused to resolve or import the configured actor. Carries what an
 * operator can do about it, in words that fit one journal line, and the
 * candidate ids it considered so the choice can be made explicitly.
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

/**
 * What `rootActor` (plus boot-time intent) can supply. Each value is used only
 * where the actor has none: a created row takes all of them, an existing row
 * only the ones it genuinely lacks.
 */
export interface ConfiguredActorSeed {
  /** `rootActor.charter`; unset means the built-in root charter. */
  charter?: string;
  /** `rootActor.context`, for a created row or one with no stored context. */
  context?: ContextConfig;
  /** The resolved display handle (`rootActor.handle`, else the default). */
  handle: string;
  /** `rootActor.avatar`, a path to an image file. */
  avatarPath?: string;
  /** Execution intent for a created row. */
  executionConfig: ExecutionConfig;
  /** A legacy root session deferred until the first root row exists. */
  sessionId?: string;
  /**
   * The validated pool to seed a row that carries none, for an actor whose
   * context is (or is not) portable. Called only when one is needed, so a
   * persisted pool never has to validate the file tuple. It throws when the
   * tuple cannot be run, before anything is written.
   */
  modelConfig: (portable: boolean, actorId: string) => ProviderModelConfig[];
}

export interface ConfiguredActorImportOptions {
  db: Database.Database;
  actors: ActorRepository;
  receipts: Pick<LegacyImportReceiptRepository, "actorFor" | "has" | "record">;
  seed: ConfiguredActorSeed;
  /** Directory holding spawned actors' workspaces, used as identity evidence. */
  workersDir: string;
  /** Where the configured actor's image is cached. */
  avatarCachePath: string;
  /** Explicit operator choice (`rusa start --import-actor`), for ambiguous state. */
  selectedActorId?: string;
  idgen?: () => string;
  now?: () => string;
}

/** What the plan decided, before any write. */
export type ConfiguredActorImportPlan =
  /** A receipt already names the actor; nothing to import. */
  | { kind: "completed"; actorId: string }
  /** An empty actor table: create the configured actor from config. */
  | { kind: "create"; actorId: string }
  /** An existing actor becomes the imported one; config fills its gaps. */
  | { kind: "adopt"; actorId: string; selected: boolean };

export interface ConfiguredActorImportResult {
  plan: ConfiguredActorImportPlan;
  actorId: string;
  /** Fields the import wrote from config; empty when it was already complete. */
  filled: string[];
  /** Whether the configured avatar was copied into the image cache. */
  avatarImported: boolean;
  /**
   * The configured avatar path, resolved, when it named no file and nothing
   * was cached either. The import is the last read of `rootActor.avatar`, so
   * boot warns rather than letting the skip pass silently.
   */
  avatarMissing?: string;
}

/**
 * The charter the configured actor's prompt runs on. The previous binary
 * stored DEFAULT_ROOT_CHARTER when `rootActor.charter` was unset, while its
 * prompt actually ran on ROOT_ACTOR_CHARTER, so that stored placeholder means
 * "no charter configured". The import replaces it once; reading it the same
 * way here covers a row that a rolled-back binary rewrote after the import.
 */
export function configuredActorCharter(stored: string): string {
  return stored === DEFAULT_ROOT_CHARTER ? ROOT_ACTOR_CHARTER : stored;
}

const SELECT_ACTION =
  "restart once with `rusa start --import-actor <id>` naming the actor that config.yaml's rootActor describes; startup never picks one on its own or creates a substitute";

/**
 * Decide which actor the configuration describes, without writing anything.
 * Throws {@link ConfiguredActorImportError} when that cannot be decided
 * safely.
 */
export function planConfiguredActorImport(options: {
  actors: Pick<ActorRepository, "list">;
  receipts: Pick<LegacyImportReceiptRepository, "actorFor" | "has">;
  workersDir: string;
  selectedActorId?: string;
  idgen?: () => string;
}): ConfiguredActorImportPlan {
  const { actors, receipts, selectedActorId } = options;
  const records = actors.list();
  const byId = new Map(records.map((record) => [record.id, record]));

  if (receipts.has(CONFIGURED_ACTOR_IMPORT_SOURCE)) {
    const actorId = receipts.actorFor(CONFIGURED_ACTOR_IMPORT_SOURCE);
    if (actorId === undefined) {
      throw new ConfiguredActorImportError(
        "the configured-actor import receipt names no actor",
        "restore the receipt's actor_id in mesh.db's legacy_import_receipts table; startup will not guess which actor it imported"
      );
    }
    if (selectedActorId !== undefined && selectedActorId !== actorId) {
      throw new ConfiguredActorImportError(
        `--import-actor names ${selectedActorId}, but the configured actor was already imported as ${actorId}`,
        "drop --import-actor; the import ran once and its choice stands",
        [actorId]
      );
    }
    const record = byId.get(actorId);
    if (!record) {
      throw new ConfiguredActorImportError(
        `the imported configured actor ${actorId} has no actor record`,
        "restore its row in mesh.db's actors table from a backup; startup will not create a replacement for an imported actor",
        [actorId]
      );
    }
    if (record.status !== "active") {
      throw new ConfiguredActorImportError(
        `the imported configured actor ${actorId} is retired`,
        "startup will not revive a retired actor or create a replacement for it; restore a backup taken before the retirement",
        [actorId]
      );
    }
    // Part of the single top-level guard (ActorMesh.assertSingleTopLevel), not
    // of the import: the imported actor having a parent is only wrong because
    // the runtime still boots exactly one top-level actor. Forest boot (#1003)
    // removes this refusal together with that guard.
    if (record.parentId !== null) {
      throw new ConfiguredActorImportError(
        `the imported configured actor ${actorId} is no longer top-level (parent ${record.parentId})`,
        "until forest boot lands the runtime boots its configured actor as the single top-level actor; restore its null parent_id in mesh.db's actors table",
        [actorId]
      );
    }
    return { kind: "completed", actorId };
  }

  const parentless = records.filter((record) => record.parentId === null);
  const parentlessIds = parentless.map((record) => record.id);

  if (selectedActorId !== undefined) {
    const record = byId.get(selectedActorId);
    if (!record) {
      throw new ConfiguredActorImportError(
        `--import-actor names ${selectedActorId}, which has no actor record`,
        SELECT_ACTION,
        parentlessIds
      );
    }
    assertImportable(record, parentless, "--import-actor names");
    return { kind: "adopt", actorId: record.id, selected: true };
  }

  if (records.length === 0) {
    return { kind: "create", actorId: (options.idgen ?? randomUUID)() };
  }

  if (parentless.length !== 1) {
    throw new ConfiguredActorImportError(
      parentless.length === 0
        ? `no top-level actor among ${records.length} actor record(s), so none can be the configured actor`
        : `${parentless.length} top-level actors (${parentlessIds.join(", ")}); the configured actor is ambiguous`,
      SELECT_ACTION,
      parentlessIds
    );
  }

  const candidate = parentless[0] as ActorRecord;
  assertImportable(candidate, parentless, "the sole top-level actor");
  const inconsistencies = consistencyFindings(candidate, records, options.workersDir);
  if (inconsistencies.length > 0) {
    throw new ConfiguredActorImportError(
      `the sole top-level actor ${candidate.id} does not look like the configured actor: ${inconsistencies.join("; ")}`,
      SELECT_ACTION,
      parentlessIds
    );
  }
  return { kind: "adopt", actorId: candidate.id, selected: false };
}

function assertImportable(
  record: ActorRecord,
  parentless: readonly ActorRecord[],
  subject: string
): void {
  if (record.status !== "active") {
    throw new ConfiguredActorImportError(
      `${subject} ${record.id}, which is retired`,
      "startup will not revive a retired actor; name an active actor with --import-actor, or restore a backup",
      parentless.map((other) => other.id)
    );
  }
  if (record.parentId !== null) {
    throw new ConfiguredActorImportError(
      `${subject} ${record.id}, which is not top-level (parent ${record.parentId})`,
      SELECT_ACTION,
      parentless.map((other) => other.id)
    );
  }
  const others = parentless.filter((other) => other.id !== record.id);
  if (others.length > 0) {
    throw new ConfiguredActorImportError(
      `${subject} ${record.id}, but ${others.map((other) => other.id).join(", ")} ${others.length === 1 ? "is" : "are"} also top-level`,
      "until forest boot lands the runtime boots exactly one top-level actor; reparent or remove the others in mesh.db first, then name the configured actor with --import-actor",
      parentless.map((other) => other.id)
    );
  }
}

/**
 * Evidence that a sole top-level record is not the actor config describes.
 * Every actor must descend from it; for non-reserved candidates, it must not have run as a spawned actor
 * (which would have given it a workspace under `workers/`); and its native
 * session must be its own.
 */
function consistencyFindings(
  candidate: ActorRecord,
  records: readonly ActorRecord[],
  workersDir: string
): string[] {
  const findings: string[] = [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const detached = records.filter((record) => {
    const seen = new Set<string>();
    let current: ActorRecord | undefined = record;
    while (current && current.parentId !== null) {
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return current?.id !== candidate.id;
  });
  if (detached.length > 0) {
    findings.push(`${detached.map((record) => record.id).join(", ")} do not descend from it`);
  }
  // Spawned identity is a registry and durable-tree fact; directory presence
  // under workers/ is only a tiebreaker. Reserved names defined by
  // workspace-sweep (canonical root, quota-probe-*, model-probe-*) share the
  // workers directory without representing a spawned actor workspace.
  // For any non-reserved candidate, a directory under workers/ indicates a spawned actor.
  if (!isReservedWorkerDirectory(candidate.id) && existsSync(join(workersDir, candidate.id))) {
    findings.push(`it has a spawned-actor workspace at workers/${candidate.id}`);
  }
  if (candidate.sessionId !== undefined) {
    const sharing = records.filter(
      (record) => record.id !== candidate.id && record.sessionId === candidate.sessionId
    );
    if (sharing.length > 0) {
      findings.push(
        `its session is also recorded for ${sharing.map((record) => record.id).join(", ")}`
      );
    }
  }
  return findings;
}

/**
 * Run the import if it has not run: plan, copy the avatar, then commit the
 * actor row and receipt together. Returns the configured actor's id either way.
 */
export function importConfiguredActor(
  options: ConfiguredActorImportOptions
): ConfiguredActorImportResult {
  const plan = planConfiguredActorImport(options);
  if (plan.kind === "completed") {
    return { plan, actorId: plan.actorId, filled: [], avatarImported: false };
  }

  const { actors, seed } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const existing = plan.kind === "adopt" ? actors.get(plan.actorId) : undefined;
  const filled: string[] = [];
  let record: ActorRecord;
  if (plan.kind === "create") {
    const portable = seed.context?.type === "portable";
    record = {
      id: plan.actorId,
      charter: seed.charter ?? ROOT_ACTOR_CHARTER,
      parentId: null,
      executionConfig: seed.executionConfig,
      modelConfig: seed.modelConfig(portable, plan.actorId),
      ...(seed.context ? { context: seed.context } : {}),
      ...(!portable && seed.sessionId !== undefined ? { sessionId: seed.sessionId } : {}),
      displayHandle: seed.handle,
      status: "active",
      createdAt: now(),
    };
    filled.push("charter", "executionConfig", "modelConfig", "displayHandle");
    if (seed.context) filled.push("context");
    if (!portable && seed.sessionId !== undefined) filled.push("sessionId");
  } else {
    if (!existing) {
      throw new ConfiguredActorImportError(
        `the configured actor ${plan.actorId} disappeared during import`,
        "restart; nothing was written"
      );
    }
    record = existing;
    // The previous binary rewrote the row's charter from `rootActor.charter`
    // on every boot and stored DEFAULT_ROOT_CHARTER when it was unset, while
    // its prompt actually ran on ROOT_ACTOR_CHARTER. That stored placeholder
    // is "no charter configured", so the text the actor really ran on (or a
    // charter configured now) fills it. Any other stored charter stands.
    if (existing.charter === DEFAULT_ROOT_CHARTER) {
      record = { ...record, charter: seed.charter ?? ROOT_ACTOR_CHARTER };
      filled.push("charter");
    }
    // No stored context (and so no native session) is "unset", which the
    // previous binary filled from `rootActor.context` on every boot. A stored
    // context, native or portable, is the actor's own and stands.
    if (existing.context === undefined && seed.context !== undefined) {
      record = { ...record, context: seed.context };
      filled.push("context");
    }
    if (existing.displayHandle === undefined) {
      record = { ...record, displayHandle: seed.handle };
      filled.push("displayHandle");
    }
  }
  // A class-bound record has no pool of its own; a broken class is reported by
  // the boot model check, never patched over with the file tuple.
  const seedPool =
    plan.kind === "adopt" &&
    existing?.modelClass === undefined &&
    (existing?.modelConfig === undefined || existing.modelConfig.length === 0)
      ? seed.modelConfig(record.context?.type === "portable", plan.actorId)
      : undefined;
  if (seedPool) filled.push("modelConfig");

  const avatar = importAvatar(seed.avatarPath, options.avatarCachePath);

  options.db.transaction(() => {
    if (plan.kind === "create") {
      actors.upsert(record);
    } else if (filled.some((field) => field !== "modelConfig")) {
      actors.patch(record.id, {
        charter: record.charter,
        context: record.context,
        displayHandle: record.displayHandle,
      });
    }
    if (seedPool) actors.setModelSelection(record.id, { modelConfig: seedPool });
    options.receipts.record(CONFIGURED_ACTOR_IMPORT_SOURCE, now(), 1, record.id);
  })();

  return {
    plan,
    actorId: record.id,
    filled,
    avatarImported: avatar === "imported",
    ...(avatar === "imported" || avatar === undefined ? {} : { avatarMissing: avatar.missing }),
  };
}

/**
 * Copy a configured avatar into the actor's image cache unless an image is
 * already there. An existing cached image is the actor's established picture
 * (uploaded or generated), and it already took precedence over the configured
 * path, so it stays. The copy goes through a temporary file and a rename, so
 * an interruption never leaves a partial image behind. Returns `undefined`
 * when nothing was configured or the cache already holds an image.
 */
function importAvatar(
  configuredPath: string | undefined,
  cachePath: string
): "imported" | { missing: string } | undefined {
  if (!configuredPath || existsSync(cachePath)) return undefined;
  const source = resolve(configuredPath);
  if (!existsSync(source)) return { missing: source };
  const temp = `${cachePath}.import-${process.pid}.tmp`;
  mkdirSync(dirname(cachePath), { recursive: true });
  try {
    copyFileSync(source, temp);
    renameSync(temp, cachePath);
  } finally {
    rmSync(temp, { force: true });
  }
  return "imported";
}
