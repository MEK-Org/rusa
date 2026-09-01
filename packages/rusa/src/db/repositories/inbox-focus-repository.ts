import type Database from "better-sqlite3";

export type InboxFocusResolution = "explicit" | "inferred" | "none" | "ambiguous";

export interface RunInboxFocus {
  runId: string;
  actorId: string;
  primaryObligationId: string | null;
  resolution: InboxFocusResolution;
  selectedAt: string;
  diagnostics: string[];
  entryIds: string[];
}

interface FocusRow {
  run_id: string;
  actor_id: string;
  primary_obligation_id: string | null;
  resolution: InboxFocusResolution;
  selected_at: string;
  diagnostics_json: string;
}

function parseDiagnostics(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("invalid actor run focus diagnostics");
  }
  return value;
}

/** Durable persistence for run focus and inbox-entry obligation associations. */
export class InboxFocusRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  recordSelection(input: {
    runId: string;
    actorId: string;
    entryIds: string[];
    primaryObligationId: string | null;
    resolution: InboxFocusResolution;
    diagnostics?: string[];
    associations?: ReadonlyMap<string, readonly string[]>;
  }): RunInboxFocus {
    const entryIds = [...input.entryIds];
    if (
      entryIds.length < 1 ||
      entryIds.length > 100 ||
      new Set(entryIds).size !== entryIds.length
    ) {
      throw new Error("run focus requires 1 to 100 unique inbox entry ids");
    }
    const diagnostics = input.diagnostics ?? [];
    if (diagnostics.some((diagnostic) => !diagnostic.trim())) {
      throw new Error("run focus diagnostics must be non-empty strings");
    }
    const selectedAt = this.now();
    if (!Number.isFinite(selectedAt.getTime())) throw new Error("invalid run focus timestamp");

    this.db.transaction(() => {
      const run = this.db
        .prepare("SELECT actor_id, outcome FROM actor_runs WHERE id = ?")
        .get(input.runId) as { actor_id: string; outcome: string | null } | undefined;
      if (!run || run.outcome !== null)
        throw new Error(`active actor run not found: ${input.runId}`);
      if (run.actor_id !== input.actorId) {
        throw new Error(`actor run ${input.runId} belongs to a different actor`);
      }

      const placeholders = entryIds.map(() => "?").join(", ");
      const owned = this.db
        .prepare(
          `SELECT id FROM actor_inbox_entries
           WHERE actor_id = ? AND id IN (${placeholders})`
        )
        .all(input.actorId, ...entryIds) as Array<{ id: string }>;
      if (owned.length !== entryIds.length) throw new Error("inbox entry not found");

      this.db
        .prepare(
          `INSERT INTO actor_run_focus
             (run_id, actor_id, primary_obligation_id, resolution, selected_at, diagnostics_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             actor_id = excluded.actor_id,
             primary_obligation_id = excluded.primary_obligation_id,
             resolution = excluded.resolution,
             selected_at = excluded.selected_at,
             diagnostics_json = excluded.diagnostics_json`
        )
        .run(
          input.runId,
          input.actorId,
          input.primaryObligationId,
          input.resolution,
          selectedAt.toISOString(),
          JSON.stringify(diagnostics)
        );
      this.db.prepare("DELETE FROM actor_run_focus_entries WHERE run_id = ?").run(input.runId);
      const insertEntry = this.db.prepare(
        `INSERT INTO actor_run_focus_entries (run_id, actor_id, entry_id)
         VALUES (?, ?, ?)`
      );
      for (const entryId of entryIds) insertEntry.run(input.runId, input.actorId, entryId);

      const insertAssociation = this.db.prepare(
        `INSERT INTO inbox_entry_obligations
           (actor_id, entry_id, obligation_id, associated_at, associated_by_run_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, entry_id, obligation_id) DO NOTHING`
      );
      for (const [entryId, obligationIds] of input.associations ?? []) {
        if (!entryIds.includes(entryId)) {
          throw new Error(`association entry was not selected in this run: ${entryId}`);
        }
        for (const obligationId of new Set(obligationIds)) {
          insertAssociation.run(
            input.actorId,
            entryId,
            obligationId,
            selectedAt.toISOString(),
            input.runId
          );
        }
      }
    })();

    const focus = this.getByRunId(input.runId);
    if (!focus) throw new Error("run focus was not persisted");
    return focus;
  }

  getByRunId(runId: string): RunInboxFocus | null {
    const row = this.db.prepare("SELECT * FROM actor_run_focus WHERE run_id = ?").get(runId) as
      | FocusRow
      | undefined;
    if (!row) return null;
    const entries = this.db
      .prepare(
        `SELECT entry_id FROM actor_run_focus_entries
         WHERE run_id = ? ORDER BY rowid`
      )
      .all(runId) as Array<{ entry_id: string }>;
    return {
      runId: row.run_id,
      actorId: row.actor_id,
      primaryObligationId: row.primary_obligation_id,
      resolution: row.resolution,
      selectedAt: row.selected_at,
      diagnostics: parseDiagnostics(row.diagnostics_json),
      entryIds: entries.map((entry) => entry.entry_id),
    };
  }

  listEntryObligationIds(actorId: string, entryId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT obligation_id FROM inbox_entry_obligations
         WHERE actor_id = ? AND entry_id = ?
         ORDER BY associated_at, obligation_id`
      )
      .all(actorId, entryId) as Array<{ obligation_id: string }>;
    return rows.map((row) => row.obligation_id);
  }
}
