import type Database from "better-sqlite3";
import { InboxRepository } from "./inbox-repository.js";
import { MaintenanceRepository } from "./maintenance-repository.js";
import { MeshChatRepository } from "./mesh-chat-repository.js";
import { MeshEventRepository } from "./mesh-event-repository.js";
import { ModelScrapeRepository } from "./model-scrape-repository.js";
import { ObligationRepository } from "./obligation-repository.js";
import { QuotaScrapeRepository } from "./quota-scrape-repository.js";
import { RawInputRepository } from "./raw-input-repository.js";

/**
 * Aggregate of the entity repositories the actor mesh + the retained
 * `understanding/` subsystem use. The v2 orchestrator/dashboard repositories
 * were removed in the legacy cleanup ; only these three remain:
 *  - meshEvents  — actor-mesh observability (`rusa report`)
 *  - rawInputs   — understanding ingest
 *  - maintenance — the distillation work queue
 */
export class Repositories {
  readonly meshEvents: MeshEventRepository;
  readonly rawInputs: RawInputRepository;
  readonly maintenance: MaintenanceRepository;
  readonly inbox: InboxRepository;
  readonly meshChat: MeshChatRepository;
  readonly quotaScrapes: QuotaScrapeRepository;
  readonly modelScrapes: ModelScrapeRepository;
  readonly obligations: ObligationRepository;

  constructor(db: Database.Database) {
    this.meshEvents = new MeshEventRepository(db);
    this.rawInputs = new RawInputRepository(db);
    this.maintenance = new MaintenanceRepository(db);
    this.inbox = new InboxRepository(db);
    this.meshChat = new MeshChatRepository(db);
    this.quotaScrapes = new QuotaScrapeRepository(db);
    this.modelScrapes = new ModelScrapeRepository(db);
    this.obligations = new ObligationRepository(db);
  }
}

export { InboxRepository } from "./inbox-repository.js";
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
