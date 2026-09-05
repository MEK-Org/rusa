import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActorRecord } from "../actor/actor-record.js";
import type { ScheduledMessage, ScheduledMessageScheduler } from "../actor/os-scheduler.js";
import { normalizeModelEffortSelection } from "../providers/reasoning-effort.js";
import type { Repositories } from "./repositories/index.js";

/** The read-only slice of {@link Repositories} a plan is allowed to touch. */
interface PlanRepositories {
  actors: Pick<Repositories["actors"], "list">;
}

const handleSchema = z.object({ id: z.string().min(1), role: z.string().optional() }).strict();
const contextSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("native") }).passthrough(),
  z
    .object({
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger"]),
      compactionModel: z.string().optional(),
    })
    .passthrough(),
]);
const pendingSchema = z
  .object({
    id: z.string().min(1),
    fromId: z.string().min(1),
    body: z.string(),
    deliverAt: z.string().datetime({ offset: true }),
    sessionId: z.string().optional(),
  })
  .strict();
const legacyActorSchema = z
  .object({
    id: z.string().min(1),
    charter: z.string(),
    parentId: z.string().nullable(),
    handles: z.array(handleSchema).optional(),
    provider: z.string().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().optional(),
    desiredProvider: z.string().optional(),
    desiredModel: z.string().optional(),
    desiredEffort: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    context: contextSchema.optional(),
    title: z.string().optional(),
    isRoot: z.boolean().optional(),
    status: z.enum(["active", "retired"]),
    pendingDeliveries: z.array(pendingSchema).optional(),
    humanUnlocked: z.boolean().optional(),
    lastChatSessionId: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  // Historical budget fields and other retired JSON-only state are intentionally discarded.
  .passthrough();
const legacyFileSchema = z.object({ threads: z.array(legacyActorSchema) }).strict();
const rootSessionSchema = z.object({ sessionId: z.string().min(1) }).strict();

type LegacyActor = z.infer<typeof legacyActorSchema>;

/** Normalize model/effort qualifiers found in the retired JSON representation. */
function migrateLegacyActorModelEffort(
  record: ActorRecord,
  providerCapabilityName: (providerName: string) => string
): ActorRecord {
  const provider = providerCapabilityName(record.provider ?? "");
  if (record.status === "retired" && (record.model === null || provider !== record.provider)) {
    return record;
  }

  const current = normalizeModelEffortSelection(provider, record.model, record.effort);
  const desiredProvider = providerCapabilityName(record.desiredProvider ?? record.provider ?? "");
  const desired = record.desiredModel
    ? normalizeModelEffortSelection(
        desiredProvider,
        record.desiredModel,
        typeof record.desiredEffort === "string" ? record.desiredEffort : undefined
      )
    : undefined;
  const desiredEffort = desired
    ? record.desiredEffort === null
      ? null
      : desired.effort
    : record.desiredEffort;
  if (
    current.model === record.model &&
    current.effort === record.effort &&
    (!desired || (desired.model === record.desiredModel && desiredEffort === record.desiredEffort))
  ) {
    return record;
  }
  return {
    ...record,
    model: current.model,
    effort: current.effort,
    ...(desired ? { desiredModel: desired.model, desiredEffort } : {}),
  };
}

export interface LegacyActorImportResult {
  importedActors: number;
  importedScheduledMessages: number;
  backupFiles: string[];
  /** Present only for a session-only legacy install whose root has not yet been created. */
  deferredRootSessionId?: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Legacy actor import: cannot parse ${path}`, { cause });
  }
}

/** Normalize an accepted ISO-8601 datetime (Z or offset form) to canonical trailing-Z. */
function toCanonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function backupPath(path: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  let candidate = `${path}.imported-${timestamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${path}.imported-${timestamp}-${suffix++}.bak`;
  return candidate;
}

function archive(path: string): string {
  const destination = backupPath(path);
  renameSync(path, destination);
  return destination;
}

function durableRecord(
  legacy: LegacyActor,
  rootSessionId: string | undefined,
  providerCapabilityName: (providerName: string) => string
): ActorRecord {
  const context =
    legacy.context?.type === "portable"
      ? {
          type: "portable" as const,
          mode: legacy.context.mode,
          ...(legacy.context.compactionModel
            ? { compactionModel: legacy.context.compactionModel }
            : {}),
        }
      : legacy.context?.type === "native"
        ? ({ type: "native" } as const)
        : undefined;
  const record: ActorRecord = {
    id: legacy.id,
    charter: legacy.charter,
    parentId: legacy.parentId,
    ...(legacy.handles ? { handles: legacy.handles } : {}),
    ...(legacy.provider ? { provider: legacy.provider } : {}),
    ...(legacy.model ? { model: legacy.model } : {}),
    ...(legacy.effort ? { effort: legacy.effort } : {}),
    ...(context ? { context } : {}),
    ...(legacy.title ? { title: legacy.title } : {}),
    ...(legacy.sessionId ? { sessionId: legacy.sessionId } : {}),
    status: legacy.status,
    createdAt: toCanonicalTimestamp(legacy.createdAt),
  };
  if (record.parentId === null) {
    record.isRoot = true;
    if (rootSessionId && record.context?.type !== "portable") record.sessionId = rootSessionId;
  }
  if (record.sessionId && !record.context) record.context = { type: "native" };
  // desired-* and human projection fields are intentionally absent: the former
  // are process-local and the latter are derived from mesh_chat.
  return migrateLegacyActorModelEffort(record, providerCapabilityName);
}

function canonical(record: ActorRecord): string {
  return JSON.stringify({
    id: record.id,
    charter: record.charter,
    parentId: record.parentId,
    handles: [...(record.handles ?? [])]
      .map((handle) => ({ id: handle.id, ...(handle.role ? { role: handle.role } : {}) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    provider: record.provider ?? null,
    model: record.model ?? null,
    effort: record.effort ?? null,
    sessionId: record.sessionId ?? null,
    context: record.context ?? null,
    title: record.title ?? null,
    status: record.status,
    createdAt: record.createdAt,
  });
}

function validateGraph(records: ActorRecord[], pending: ScheduledMessage[]): ActorRecord[] {
  const byId = new Map<string, ActorRecord>();
  for (const record of records) {
    if (byId.has(record.id)) throw new Error(`Legacy actor import: duplicate actor '${record.id}'`);
    byId.set(record.id, record);
  }
  const roots = records.filter((record) => record.parentId === null);
  if (records.length > 0 && roots.length !== 1) {
    throw new Error(`Legacy actor import: expected exactly one root actor, found ${roots.length}`);
  }
  for (const record of records) {
    if (record.parentId !== null && !byId.has(record.parentId)) {
      throw new Error(
        `Legacy actor import: actor '${record.id}' has missing parent '${record.parentId}'`
      );
    }
    for (const handle of record.handles ?? []) {
      if (!byId.has(handle.id)) {
        throw new Error(
          `Legacy actor import: actor '${record.id}' has missing handle target '${handle.id}'`
        );
      }
    }
  }
  const pendingIds = new Set<string>();
  for (const delivery of pending) {
    if (pendingIds.has(delivery.id)) {
      throw new Error(`Legacy actor import: duplicate scheduled message '${delivery.id}'`);
    }
    pendingIds.add(delivery.id);
    if (!byId.has(delivery.fromId)) {
      throw new Error(
        `Legacy actor import: scheduled message '${delivery.id}' has missing sender '${delivery.fromId}'`
      );
    }
  }

  const ordered: ActorRecord[] = [];
  const remaining = new Map(byId);
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(
      (record) => record.parentId === null || !remaining.has(record.parentId)
    );
    if (ready.length === 0)
      throw new Error("Legacy actor import: actor parent graph contains a cycle");
    ready.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
    for (const record of ready) {
      ordered.push(record);
      remaining.delete(record.id);
    }
  }
  return ordered;
}

/** A read-only plan of what {@link applyLegacyActorImport} would do, with no writes performed. */
export type LegacyActorImportPlan =
  | { kind: "noop" }
  | { kind: "deferred-root-session"; sessionId: string }
  | { kind: "adopt-root-session"; rootId: string; sessionId: string; shouldPatchSession: boolean }
  | { kind: "deferred-empty-threads"; sessionId: string }
  | {
      kind: "import";
      records: ActorRecord[];
      pending: ScheduledMessage[];
      existingCount: number;
    };

export interface LegacyActorImportPlanResult {
  plan: LegacyActorImportPlan;
  hasThreads: boolean;
  hasSession: boolean;
  threadsPath: string;
  sessionPath: string;
  plannedActors: number;
  plannedScheduledMessages: number;
}

function planSummary(plan: LegacyActorImportPlan): {
  plannedActors: number;
  plannedScheduledMessages: number;
} {
  if (plan.kind !== "import") return { plannedActors: 0, plannedScheduledMessages: 0 };
  return {
    plannedActors: plan.existingCount === 0 ? plan.records.length : 0,
    plannedScheduledMessages: plan.pending.length,
  };
}

/**
 * Parse, normalize, and validate the retired `threads.json`/root session
 * files against the current actor projection — including the divergence
 * check that guards SQLite from being overwritten — without performing any
 * write. Only accepts a read-only slice of {@link Repositories} (`actors.list`
 * alone), so it cannot open a DB transaction, patch/upsert an actor, record
 * mesh chat/events, install a scheduler job, or archive a legacy file: every
 * mutating capability is simply absent from its inputs. This is what `rusa
 * db-check` calls directly to report what an import would do.
 */
export function planLegacyActorImport(options: {
  mcHome: string;
  repositories: PlanRepositories;
  providerCapabilityName?: (providerName: string) => string;
}): LegacyActorImportPlanResult {
  const threadsPath = join(options.mcHome, "threads.json");
  const sessionPath = join(options.mcHome, "root-agent", "session.json");
  const hasThreads = existsSync(threadsPath);
  const hasSession = existsSync(sessionPath);
  const base = { hasThreads, hasSession, threadsPath, sessionPath };
  if (!hasThreads && !hasSession) {
    return { ...base, plan: { kind: "noop" }, plannedActors: 0, plannedScheduledMessages: 0 };
  }

  const rootSessionId = hasSession
    ? rootSessionSchema.parse(readJson(sessionPath)).sessionId
    : undefined;
  if (!hasThreads) {
    const roots = options.repositories.actors.list().filter((record) => record.parentId === null);
    if (roots.length === 0) {
      const plan: LegacyActorImportPlan = rootSessionId
        ? { kind: "deferred-root-session", sessionId: rootSessionId }
        : { kind: "noop" };
      return { ...base, plan, plannedActors: 0, plannedScheduledMessages: 0 };
    }
    if (roots.length !== 1) throw new Error("Legacy actor import: database has multiple roots");
    const root = roots[0];
    let shouldPatchSession = false;
    if (root.context?.type !== "portable") {
      if (root.sessionId && root.sessionId !== rootSessionId) {
        throw new Error("Legacy actor import: root session file diverges from SQLite");
      }
      shouldPatchSession = !root.sessionId && !!rootSessionId;
    }
    return {
      ...base,
      plan: {
        kind: "adopt-root-session",
        rootId: root.id,
        sessionId: rootSessionId ?? "",
        shouldPatchSession,
      },
      plannedActors: shouldPatchSession ? 1 : 0,
      plannedScheduledMessages: 0,
    };
  }

  const parsed = legacyFileSchema.parse(readJson(threadsPath));
  const normalizeProvider = options.providerCapabilityName ?? ((name) => name);
  const records = parsed.threads.map((legacy) =>
    durableRecord(legacy, rootSessionId, normalizeProvider)
  );
  const pending = parsed.threads.flatMap((legacy) =>
    (legacy.pendingDeliveries ?? []).map((delivery) => ({
      ...delivery,
      deliverAt: toCanonicalTimestamp(delivery.deliverAt),
      toId: legacy.id,
    }))
  );
  const ordered = validateGraph(records, pending);
  const existing = options.repositories.actors.list();

  if (ordered.length === 0 && existing.length === 0 && rootSessionId) {
    return {
      ...base,
      plan: { kind: "deferred-empty-threads", sessionId: rootSessionId },
      plannedActors: 0,
      plannedScheduledMessages: 0,
    };
  }

  if (existing.length > 0) {
    const expectedById = new Map(records.map((record) => [record.id, canonical(record)]));
    const actualById = new Map(existing.map((record) => [record.id, canonical(record)]));
    if (
      expectedById.size !== actualById.size ||
      [...expectedById].some(([id, value]) => actualById.get(id) !== value)
    ) {
      throw new Error(
        "Legacy actor import: threads.json diverges from SQLite; refusing to overwrite durable actors"
      );
    }
  }

  const plan: LegacyActorImportPlan = {
    kind: "import",
    records: ordered,
    pending,
    existingCount: existing.length,
  };
  return { ...base, plan, ...planSummary(plan) };
}

/**
 * Apply a {@link LegacyActorImportPlan} produced by {@link planLegacyActorImport}
 * for the same home: write the durable rows, install scheduler jobs, and
 * archive the legacy sources. SQLite is authoritative for actors after
 * commit; `at` is authoritative for pending messages after their jobs are
 * installed. If a crash leaves the source file in place, a later boot
 * re-plans, verifies the actor projection, replaces the same tagged host
 * jobs, and archives only after every schedule succeeds.
 */
export function applyLegacyActorImport(
  planResult: LegacyActorImportPlanResult,
  options: {
    db: Database.Database;
    repositories: Repositories;
    scheduledMessages?: ScheduledMessageScheduler;
  }
): LegacyActorImportResult {
  const { plan, threadsPath, sessionPath, hasSession } = planResult;

  switch (plan.kind) {
    case "noop":
      return { importedActors: 0, importedScheduledMessages: 0, backupFiles: [] };

    case "deferred-root-session":
      return {
        importedActors: 0,
        importedScheduledMessages: 0,
        backupFiles: [],
        deferredRootSessionId: plan.sessionId,
      };

    case "adopt-root-session": {
      if (plan.shouldPatchSession) {
        options.repositories.actors.patch(plan.rootId, { sessionId: plan.sessionId });
      }
      return {
        importedActors: 0,
        importedScheduledMessages: 0,
        backupFiles: hasSession ? [archive(sessionPath)] : [],
      };
    }

    case "deferred-empty-threads":
      return {
        importedActors: 0,
        importedScheduledMessages: 0,
        backupFiles: [archive(threadsPath)],
        deferredRootSessionId: plan.sessionId,
      };

    case "import": {
      const { records, pending, existingCount } = plan;
      if (pending.length > 0 && !options.scheduledMessages) {
        throw new Error(
          "Legacy actor import: pending messages require the host OS scheduler; run `rusa start` to import them"
        );
      }

      if (existingCount === 0) {
        options.db.transaction(() => {
          // Parent rows must exist before children, and all actor rows must exist
          // before address-book foreign keys can be inserted.
          for (const record of records)
            options.repositories.actors.upsert({ ...record, handles: [] });
          for (const record of records) {
            if (record.handles?.length)
              options.repositories.actors.patch(record.id, { handles: record.handles });
          }
        })();
      }

      options.db.transaction(() => {
        for (const delivery of pending) {
          options.repositories.meshChat.record({
            id: delivery.id,
            senderId: delivery.fromId,
            recipientId: delivery.toId,
            body: delivery.body,
            sessionId: delivery.sessionId,
          });
          options.repositories.meshEvents.record({
            id: `${delivery.id}:sent`,
            kind: "message_sent",
            actorId: delivery.fromId,
            detail: delivery.sessionId,
            payload: JSON.stringify({ messageId: delivery.id, to: delivery.toId }),
          });
        }
      })();
      for (const delivery of pending) options.scheduledMessages?.scheduleMessageDelivery(delivery);

      const backupFiles = [archive(threadsPath)];
      if (hasSession) backupFiles.push(archive(sessionPath));
      return {
        importedActors: existingCount === 0 ? records.length : 0,
        importedScheduledMessages: pending.length,
        backupFiles,
      };
    }
  }
}

/**
 * Import the retired `threads.json`/root session files exactly once: plan,
 * then apply. See {@link planLegacyActorImport} and {@link applyLegacyActorImport}.
 */
export function importLegacyActorState(options: {
  mcHome: string;
  db: Database.Database;
  repositories: Repositories;
  scheduledMessages?: ScheduledMessageScheduler;
  providerCapabilityName?: (providerName: string) => string;
}): LegacyActorImportResult {
  const planResult = planLegacyActorImport(options);
  return applyLegacyActorImport(planResult, options);
}

/** Finish the rare session-only import once startup has minted its first root actor. */
export function finishDeferredRootSessionImport(mcHome: string): string | undefined {
  const sessionPath = join(mcHome, "root-agent", "session.json");
  return existsSync(sessionPath) ? archive(sessionPath) : undefined;
}
