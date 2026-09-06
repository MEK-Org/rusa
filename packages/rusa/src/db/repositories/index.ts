import type Database from "better-sqlite3";
import type { CapabilityGrantStore } from "../../actor/capability-grants.js";
import type { ObligationActivationScheduler } from "../../actor/os-scheduler.js";
import type { ActorRepository } from "../../repositories/actor-repository.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import { DbCapabilityGrantStore } from "./capability-grant-repository.js";
import { DbEventSourceOwnerStore } from "./event-source-owner-repository.js";
import { DbEventSourceSubscriptionStore } from "./event-source-subscription-repository.js";
import { InboxFocusRepository } from "./inbox-focus-repository.js";
import { InboxRepository } from "./inbox-repository.js";
import { LegacyImportReceiptRepository } from "./legacy-import-receipt-repository.js";
import { MaintenanceRepository } from "./maintenance-repository.js";
import { MeshChatRepository } from "./mesh-chat-repository.js";
import { MeshEventRepository } from "./mesh-event-repository.js";
import { ModelScrapeRepository } from "./model-scrape-repository.js";
import { ObligationRepository } from "./obligation-repository.js";
import { QuotaScrapeRepository } from "./quota-scrape-repository.js";
import { RawInputRepository } from "./raw-input-repository.js";
import { ReferenceCacheRepository } from "./reference-cache-repository.js";
import { SqliteActorRepository } from "./sqlite-actor-repository.js";

/**
 * Aggregate of the entity repositories the actor mesh + the retained
 * `understanding/` subsystem use. The v2 orchestrator/dashboard repositories
 * were removed in the legacy cleanup ; only these three remain:
 *  - meshEvents  — actor-mesh observability (`rusa report`)
 *  - rawInputs   — understanding ingest
 *  - maintenance — the distillation work queue
 */
export class Repositories {
  readonly actorRuns: ActorRunRepository;
  readonly actors: ActorRepository;
  readonly capabilityGrants: CapabilityGrantStore;
  readonly eventSourceOwners: DbEventSourceOwnerStore;
  readonly eventSourceSubscriptions: DbEventSourceSubscriptionStore;
  readonly legacyImportReceipts: LegacyImportReceiptRepository;
  readonly meshEvents: MeshEventRepository;
  readonly rawInputs: RawInputRepository;
  readonly maintenance: MaintenanceRepository;
  readonly inbox: InboxRepository;
  readonly inboxFocus: InboxFocusRepository;
  readonly meshChat: MeshChatRepository;
  readonly quotaScrapes: QuotaScrapeRepository;
  readonly modelScrapes: ModelScrapeRepository;
  readonly obligations: ObligationRepository;
  readonly referenceCache: ReferenceCacheRepository;

  constructor(db: Database.Database) {
    this.actorRuns = new ActorRunRepository(db);
    this.actors = new SqliteActorRepository(db);
    this.capabilityGrants = new DbCapabilityGrantStore(db);
    this.eventSourceOwners = new DbEventSourceOwnerStore(db);
    this.eventSourceSubscriptions = new DbEventSourceSubscriptionStore(db);
    this.legacyImportReceipts = new LegacyImportReceiptRepository(db);
    this.meshEvents = new MeshEventRepository(db);
    this.rawInputs = new RawInputRepository(db);
    this.maintenance = new MaintenanceRepository(db);
    this.inbox = new InboxRepository(db);
    this.inboxFocus = new InboxFocusRepository(db);
    this.meshChat = new MeshChatRepository(db);
    this.quotaScrapes = new QuotaScrapeRepository(db);
    this.modelScrapes = new ModelScrapeRepository(db);
    this.obligations = new ObligationRepository(db);
    this.referenceCache = new ReferenceCacheRepository(db);
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
    this.obligations.setActorExists(probe);
  }

  setOsScheduler(scheduler: ObligationActivationScheduler): void {
    this.obligations.setOsScheduler(scheduler);
  }
}

export type {
  ActorRun,
  ActorRunOutcome,
  PortableLedgerSource,
  PortableLedgerSourceKind,
} from "./actor-run-repository.js";
export { ActorRunRepository } from "./actor-run-repository.js";
export { DbEventSourceOwnerStore } from "./event-source-owner-repository.js";
export { DbEventSourceSubscriptionStore } from "./event-source-subscription-repository.js";
export type { InboxFocusResolution, RunInboxFocus } from "./inbox-focus-repository.js";
export { InboxFocusRepository } from "./inbox-focus-repository.js";
export { InboxRepository } from "./inbox-repository.js";
export { LegacyImportReceiptRepository } from "./legacy-import-receipt-repository.js";
export { MaintenanceRepository } from "./maintenance-repository.js";
export type { MeshChat } from "./mesh-chat-repository.js";
export { MeshChatRepository } from "./mesh-chat-repository.js";
export type { MeshEvent, MeshEventKind } from "./mesh-event-repository.js";
export { MeshEventRepository } from "./mesh-event-repository.js";
export type { ModelScrape } from "./model-scrape-repository.js";
export { ModelScrapeRepository } from "./model-scrape-repository.js";
export type {
  CreateObligationInput,
  ListOwnedObligationsOptions,
} from "./obligation-repository.js";
export { ObligationRepository } from "./obligation-repository.js";
export { QuotaScrapeRepository } from "./quota-scrape-repository.js";
export type { RawInput } from "./raw-input-repository.js";
export { RawInputRepository } from "./raw-input-repository.js";
export { ReferenceCacheRepository } from "./reference-cache-repository.js";
export { SqliteActorRepository } from "./sqlite-actor-repository.js";
