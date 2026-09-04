import { initialSchema } from "./0001_initial_schema.js";
import { meshEventsActorKindIndex } from "./0002_mesh_events_actor_kind_index.js";
import { actorInbox } from "./0003_actor_inbox.js";
import { meshEventsActorTsIndex } from "./0004_mesh_events_actor_ts_index.js";
import { meshChatAndEventsSplit } from "./0005_mesh_chat_and_events_split.js";
import { backfillMeshChatFromLegacyEvents } from "./0006_backfill_mesh_chat_from_legacy_events.js";
import { cleanupIntermediateMechanicalChatRows } from "./0007_cleanup_intermediate_mechanical_chat_rows.js";
import { runLifecycleTaxonomy } from "./0008_run_lifecycle_taxonomy.js";
import { quotaScrapeHistory } from "./0009_quota_scrape_history.js";
import { runTokenRecords } from "./0010_run_token_records.js";
import { actorInboxSeen } from "./0012_actor_inbox_seen.js";
import { removePrimaryExhaustion } from "./0013_remove_primary_exhaustion.js";
import { cleanupRegressedMechanicalChatRows } from "./0014_cleanup_regressed_mechanical_chat_rows.js";
import { actorInboxHandledNote } from "./0015_actor_inbox_handled_note.js";
import { obligations } from "./0016_obligations.js";
import { obligationPriority } from "./0017_obligation_priority.js";
import { dropMeshEventsCreatedAt } from "./0018_drop_mesh_events_created_at.js";
import { modelScrapes } from "./0019_model_scrapes.js";
import { obligationCaptureReceipts } from "./0020_obligation_capture_receipts.js";
import { inferredParsedState } from "./0022_inferred_parsed_state.js";
import { dropMeshEventsPeerId } from "./0023_drop_mesh_events_peer_id.js";
import { renameThreadEvents } from "./0024_rename_thread_events.js";
import { obligationTimestamps } from "./0025_obligation_timestamps.js";
import { obligationTerminalNote } from "./0026_obligation_terminal_note.js";
import { obligationTitle } from "./0027_obligation_title.js";
import { obligationArtifacts } from "./0028_obligation_artifacts.js";
import { referenceGrammar } from "./0029_reference_grammar.js";
import { actorRuns } from "./0030_actor_runs.js";
import { inboxRunFocus } from "./0031_inbox_run_focus.js";
import { actorRunsFocusFold } from "./0032_actor_runs_focus_fold.js";
import { referenceCache } from "./0033_reference_cache.js";
import { actorRuntimeState } from "./0034_actor_runtime_state.js";
import { recurringObligations } from "./0035_recurring_obligations.js";
import { correctActorSchema } from "./0036_correct_actor_schema.js";
import type { Migration } from "./types.js";

/**
 * Registry of all database migrations in the order they should be applied.
 *
 * Squashed during the v1/v2 legacy cleanup : the old 0002–0019 chain was
 * collapsed into {@link initialSchema}. New schema changes append here as
 * 0002_…, 0003_…, etc.
 */
export const migrations: Migration[] = [
  initialSchema,
  meshEventsActorKindIndex,
  actorInbox,
  meshEventsActorTsIndex,
  meshChatAndEventsSplit,
  backfillMeshChatFromLegacyEvents,
  cleanupIntermediateMechanicalChatRows,
  runLifecycleTaxonomy,
  quotaScrapeHistory,
  runTokenRecords,
  actorInboxSeen,
  removePrimaryExhaustion,
  cleanupRegressedMechanicalChatRows,
  actorInboxHandledNote,
  obligations,
  obligationPriority,
  dropMeshEventsCreatedAt,
  modelScrapes,
  obligationCaptureReceipts,
  inferredParsedState,
  dropMeshEventsPeerId,
  renameThreadEvents,
  obligationTimestamps,
  obligationTerminalNote,
  obligationTitle,
  obligationArtifacts,
  referenceGrammar,
  actorRuns,
  inboxRunFocus,
  actorRunsFocusFold,
  referenceCache,
  actorRuntimeState,
  recurringObligations,
  correctActorSchema,
];
