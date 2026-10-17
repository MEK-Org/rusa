import type Database from "better-sqlite3";
import type { CapabilityGrantStore } from "../../actor/capability-grants.js";
import type { ExperimentEnrollmentStore } from "../../actor/experiments.js";
import type { HostJobStore } from "../../actor/host-job-store.js";
import type { ObligationActivationScheduler } from "../../actor/os-scheduler.js";
import type { InstanceRole } from "../../config/types.js";
import type { ActorRepository } from "../../repositories/actor-repository.js";
import type { InboxRepository } from "../../repositories/inbox-repository.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import { AvailabilityHoldRepository } from "./availability-hold-repository.js";
import { DbCapabilityGrantStore } from "./capability-grant-repository.js";
import { ChatRoomRepository } from "./chat-room-repository.js";
import { DbEventSourceOwnerStore } from "./event-source-owner-repository.js";
import { DbEventSourceSubscriptionStore } from "./event-source-subscription-repository.js";
import { DbExperimentEnrollmentStore } from "./experiment-enrollment-repository.js";
import { DbHostJobStore } from "./host-job-repository.js";
import { InboxFocusRepository } from "./inbox-focus-repository.js";
import { LegacyImportReceiptRepository } from "./legacy-import-receipt-repository.js";
import { MaintenanceRepository } from "./maintenance-repository.js";
import { MeshChatRepository } from "./mesh-chat-repository.js";
import { MeshEventRepository } from "./mesh-event-repository.js";
import { ModelClassRepository } from "./model-class-repository.js";
import { ModelScrapeRepository } from "./model-scrape-repository.js";
import { ObligationRepository } from "./obligation-repository.js";
import { DbPortableContextStore } from "./portable-context-repository.js";
import { PrincipalRepository } from "./principal-repository.js";
import { QuotaScrapeRepository } from "./quota-scrape-repository.js";
import { RawInputRepository } from "./raw-input-repository.js";
import { ReferenceCacheRepository } from "./reference-cache-repository.js";
import { RunPromptRepository } from "./run-prompt-repository.js";
import { SqliteActorRepository } from "./sqlite-actor-repository.js";
import {
  type InboxListenerErrorHandler,
  SqliteInboxRepository,
} from "./sqlite-inbox-repository.js";

export class RoleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleAuthorityError";
  }
}

const OBLIGATION_MUTATING_METHODS = new Set([
  "create",
  "addPrerequisite",
  "removePrerequisite",
  "setExternalRef",
  "setCheckpoint",
  "reparent",
  "reassign",
  "reorder",
  "attachArtifact",
  "setCompletionMatcher",
  "setRecurrence",
  "setTerminalStatus",
  "markResponsive",
  "reconcileScheduledObligations",
  "activateScheduled",
  "wakeScheduled",
  "setSnooze",
  "expireDueSnoozes",
  "setPriorityInternal",
  "movePriorityInternal",
  "inheritRetiringActorObligationsInternal",
  "satisfyCompletionMatcher",
  "recordCompletionMatcherClosedUnmerged",
]);

const ACTOR_MUTATING_METHODS = new Set(["upsert", "setModelSelection", "patch"]);

const PRINCIPAL_MUTATING_METHODS = new Set([
  "ensureActorPrincipal",
  "createUser",
  "ensureImplicitUser",
  "bindExternalIdentity",
  "claimUnboundUserByEmail",
  "updateEmail",
  "setRootActor",
  "setDisabled",
  "recordAuthentication",
  "setGoogleAccountId",
]);

const MODEL_CLASS_MUTATING_METHODS = new Set(["upsert", "delete"]);

const AVAILABILITY_HOLD_MUTATING_METHODS = new Set(["set", "clear", "clearAll"]);

const CAPABILITY_GRANT_MUTATING_METHODS = new Set(["grant", "revoke"]);

const CHAT_ROOM_MUTATING_METHODS = new Set(["add", "remove"]);

const EVENT_SOURCE_OWNER_MUTATING_METHODS = new Set([
  "subscribe",
  "unsubscribe",
  "restore",
  "setConfig",
]);

const EVENT_SOURCE_SUBSCRIPTION_MUTATING_METHODS = new Set(["subscribe", "unsubscribe"]);

const EXPERIMENT_ENROLLMENT_MUTATING_METHODS = new Set(["enroll", "unenroll"]);

const INBOX_MUTATING_METHODS = new Set([
  "append",
  "markHandled",
  "markSeen",
  "selectPrioritizedUnhandled",
  "pruneHandled",
  "replaceEntries",
]);

const INBOX_FOCUS_MUTATING_METHODS = new Set(["recordSelection"]);

const MESH_CHAT_MUTATING_METHODS = new Set(["record"]);

const MESH_EVENT_MUTATING_METHODS = new Set(["record", "pruneKind"]);

const RAW_INPUT_MUTATING_METHODS = new Set(["insert", "resetDistillation", "markProcessed"]);

const QUOTA_SCRAPE_MUTATING_METHODS = new Set(["recordRaw", "recordParsed", "recordParseError"]);

const MODEL_SCRAPE_MUTATING_METHODS = new Set(["recordRaw", "recordParsed", "recordParseError"]);

const LEGACY_IMPORT_RECEIPT_MUTATING_METHODS = new Set(["record"]);

const REFERENCE_CACHE_MUTATING_METHODS = new Set(["set", "delete"]);

function guardRoleAuthority<T extends object>(
  target: T,
  blockedMethodNames: Set<string>,
  role: InstanceRole,
  repoName: string
): T {
  if (role === "leader") return target;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string" && blockedMethodNames.has(prop)) {
        return (..._args: unknown[]) => {
          throw new RoleAuthorityError(
            `Role authority violation: follower role cannot execute "${repoName}.${prop}"`
          );
        };
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
}

/**
 * Aggregate of the entity repositories the actor mesh + the retained
 * `understanding/` subsystem use. The v2 orchestrator/dashboard repositories
 * were removed in the legacy cleanup ; only these three remain:
 *  - meshEvents  — actor-mesh observability (`rusa report`)
 *  - rawInputs   — understanding ingest
 *  - maintenance — the distillation work queue
 */
export class Repositories {
  readonly role: InstanceRole;
  readonly runPrompts: RunPromptRepository;
  readonly actorRuns: ActorRunRepository;
  readonly actors: ActorRepository;
  readonly availabilityHolds: AvailabilityHoldRepository;
  readonly capabilityGrants: CapabilityGrantStore;
  readonly chatRoom: ChatRoomRepository;
  readonly eventSourceOwners: DbEventSourceOwnerStore;
  readonly experimentEnrollments: ExperimentEnrollmentStore;
  readonly eventSourceSubscriptions: DbEventSourceSubscriptionStore;
  readonly hostJobs: HostJobStore;
  readonly legacyImportReceipts: LegacyImportReceiptRepository;
  readonly meshEvents: MeshEventRepository;
  readonly rawInputs: RawInputRepository;
  readonly maintenance: MaintenanceRepository;
  readonly inbox: InboxRepository;
  /**
   * The same object as {@link inbox}, kept concretely so wiring that only the
   * SQLite implementation offers stays reachable from the composition root
   * without widening the abstract contract every other caller sees.
   */
  private readonly sqliteInbox: SqliteInboxRepository;
  private readonly rawSqliteInbox: SqliteInboxRepository;
  readonly inboxFocus: InboxFocusRepository;
  readonly meshChat: MeshChatRepository;
  readonly quotaScrapes: QuotaScrapeRepository;
  readonly modelScrapes: ModelScrapeRepository;
  readonly modelClasses: ModelClassRepository;
  readonly obligations: ObligationRepository;
  private readonly rawObligations: ObligationRepository;
  readonly portableContext: DbPortableContextStore;
  readonly principals: PrincipalRepository;
  readonly referenceCache: ReferenceCacheRepository;

  constructor(db: Database.Database, role: InstanceRole = "leader") {
    this.role = role;
    this.runPrompts = new RunPromptRepository(db);
    this.actorRuns = new ActorRunRepository(db);
    // Constructed before the actor repository, which writes an actor's principal
    // in the same transaction as the actor row.
    this.principals = guardRoleAuthority(
      new PrincipalRepository(db),
      PRINCIPAL_MUTATING_METHODS,
      role,
      "principals"
    );
    // Constructed before the actor repository, which resolves a class-bound
    // actor's pool from the live class row on every read.
    this.modelClasses = guardRoleAuthority(
      new ModelClassRepository(db),
      MODEL_CLASS_MUTATING_METHODS,
      role,
      "modelClasses"
    );
    this.actors = guardRoleAuthority(
      new SqliteActorRepository(db, this.principals, this.modelClasses),
      ACTOR_MUTATING_METHODS,
      role,
      "actors"
    );
    this.availabilityHolds = guardRoleAuthority(
      new AvailabilityHoldRepository(db),
      AVAILABILITY_HOLD_MUTATING_METHODS,
      role,
      "availabilityHolds"
    );
    this.capabilityGrants = guardRoleAuthority(
      new DbCapabilityGrantStore(db),
      CAPABILITY_GRANT_MUTATING_METHODS,
      role,
      "capabilityGrants"
    );
    this.chatRoom = guardRoleAuthority(
      new ChatRoomRepository(db),
      CHAT_ROOM_MUTATING_METHODS,
      role,
      "chatRoom"
    );
    this.eventSourceOwners = guardRoleAuthority(
      new DbEventSourceOwnerStore(db),
      EVENT_SOURCE_OWNER_MUTATING_METHODS,
      role,
      "eventSourceOwners"
    );
    this.experimentEnrollments = guardRoleAuthority(
      new DbExperimentEnrollmentStore(db),
      EXPERIMENT_ENROLLMENT_MUTATING_METHODS,
      role,
      "experimentEnrollments"
    );
    this.eventSourceSubscriptions = guardRoleAuthority(
      new DbEventSourceSubscriptionStore(db),
      EVENT_SOURCE_SUBSCRIPTION_MUTATING_METHODS,
      role,
      "eventSourceSubscriptions"
    );
    this.hostJobs = new DbHostJobStore(db);
    this.legacyImportReceipts = guardRoleAuthority(
      new LegacyImportReceiptRepository(db),
      LEGACY_IMPORT_RECEIPT_MUTATING_METHODS,
      role,
      "legacyImportReceipts"
    );
    this.meshEvents = guardRoleAuthority(
      new MeshEventRepository(db),
      MESH_EVENT_MUTATING_METHODS,
      role,
      "meshEvents"
    );
    this.rawInputs = guardRoleAuthority(
      new RawInputRepository(db),
      RAW_INPUT_MUTATING_METHODS,
      role,
      "rawInputs"
    );
    this.maintenance = new MaintenanceRepository(db);
    this.rawSqliteInbox = new SqliteInboxRepository(db);
    this.sqliteInbox = guardRoleAuthority(
      this.rawSqliteInbox,
      INBOX_MUTATING_METHODS,
      role,
      "inbox"
    );
    this.inbox = this.sqliteInbox;
    this.inboxFocus = guardRoleAuthority(
      new InboxFocusRepository(db),
      INBOX_FOCUS_MUTATING_METHODS,
      role,
      "inboxFocus"
    );
    this.meshChat = guardRoleAuthority(
      new MeshChatRepository(db),
      MESH_CHAT_MUTATING_METHODS,
      role,
      "meshChat"
    );
    this.quotaScrapes = guardRoleAuthority(
      new QuotaScrapeRepository(db),
      QUOTA_SCRAPE_MUTATING_METHODS,
      role,
      "quotaScrapes"
    );
    this.modelScrapes = guardRoleAuthority(
      new ModelScrapeRepository(db),
      MODEL_SCRAPE_MUTATING_METHODS,
      role,
      "modelScrapes"
    );
    this.rawObligations = new ObligationRepository(db);
    this.rawObligations.setPrincipalKind((principalId) => this.principals.get(principalId)?.kind);
    this.obligations = guardRoleAuthority(
      this.rawObligations,
      OBLIGATION_MUTATING_METHODS,
      role,
      "obligations"
    );
    this.portableContext = new DbPortableContextStore(db);
    this.referenceCache = guardRoleAuthority(
      new ReferenceCacheRepository(db),
      REFERENCE_CACHE_MUTATING_METHODS,
      role,
      "referenceCache"
    );
  }

  /**
   * Wire the actor-existence probe against the authoritative actor repository.
   *
   * Separate from construction to keep the obligation repository's callback explicit.
   * Called from `runStart`; without it the obligation store cannot tell a live
   * actor from a typo, which is the omission that let owner drift back in
   * through the write boundary.
   */
  setActorExists(probe: (actorId: string) => boolean): void {
    this.rawObligations.setActorExists(probe);
  }

  setOsScheduler(scheduler: ObligationActivationScheduler): void {
    this.rawObligations.setOsScheduler(scheduler);
  }

  /**
   * Journal failures of advisory `onItemsAppended` listeners. Built from a
   * Database alone, the container has no logger of its own; without this line
   * a listener that throws is contained and unrecorded.
   */
  setInboxListenerErrorHandler(handler: InboxListenerErrorHandler): void {
    this.rawSqliteInbox.setListenerErrorHandler(handler);
  }
}

export type {
  ActorRun,
  ActorRunOutcome,
  PortableLedgerSource,
  PortableLedgerSourceKind,
} from "./actor-run-repository.js";
export { ActorRunRepository } from "./actor-run-repository.js";
export type {
  AvailabilityHold,
  AvailabilityHoldScope,
  SetAvailabilityHold,
} from "./availability-hold-repository.js";
export { AvailabilityHoldRepository } from "./availability-hold-repository.js";
export type { ChatRoomMember } from "./chat-room-repository.js";
export { ChatRoomRepository } from "./chat-room-repository.js";
export { DbEventSourceOwnerStore } from "./event-source-owner-repository.js";
export { DbEventSourceSubscriptionStore } from "./event-source-subscription-repository.js";
export { DbExperimentEnrollmentStore } from "./experiment-enrollment-repository.js";
export { DbHostJobStore } from "./host-job-repository.js";
export type { InboxFocusResolution, RunInboxFocus } from "./inbox-focus-repository.js";
export { InboxFocusRepository } from "./inbox-focus-repository.js";
export { LegacyImportReceiptRepository } from "./legacy-import-receipt-repository.js";
export { MaintenanceRepository } from "./maintenance-repository.js";
export type { MeshChat } from "./mesh-chat-repository.js";
export { MeshChatRepository } from "./mesh-chat-repository.js";
export type { MeshEvent, MeshEventKind } from "./mesh-event-repository.js";
export { MeshEventRepository } from "./mesh-event-repository.js";
export type { ModelClass } from "./model-class-repository.js";
export { ModelClassRepository } from "./model-class-repository.js";
export type { ModelScrape } from "./model-scrape-repository.js";
export { ModelScrapeRepository } from "./model-scrape-repository.js";
export type {
  CreateObligationInput,
  ListOwnedObligationsOptions,
} from "./obligation-repository.js";
export { MAX_OBLIGATION_PAGE_LIMIT, ObligationRepository } from "./obligation-repository.js";
export { DbPortableContextStore } from "./portable-context-repository.js";
export type { CreateUserInput } from "./principal-repository.js";
export { normalizeEmail, PrincipalRepository } from "./principal-repository.js";
export { QuotaScrapeRepository } from "./quota-scrape-repository.js";
export type { RawInput } from "./raw-input-repository.js";
export { RawInputRepository } from "./raw-input-repository.js";
export { ReferenceCacheRepository } from "./reference-cache-repository.js";
export { SqliteActorRepository } from "./sqlite-actor-repository.js";
export type { InboxListenerErrorHandler } from "./sqlite-inbox-repository.js";
export { SqliteInboxRepository } from "./sqlite-inbox-repository.js";
