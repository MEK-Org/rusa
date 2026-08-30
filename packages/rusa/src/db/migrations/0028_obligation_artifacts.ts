import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Let an obligation cite the things it came from and the thing that settled it.
 *
 * `external_ref` is **identity**: it asserts this obligation *is* that GitHub
 * issue, and the store enforces that at most one live obligation claims it.
 * That is deliberately not the same relation as "here is a message that bears
 * on this work" (operator, 2026-08-30), and overloading it would make the
 * uniqueness guarantee meaningless.
 *
 * So artifacts are a separate, many-per-obligation association. The motivating
 * case is a human-owned decision child: the actor asks a question, the operator
 * answers in chat, and the actor closes the question *citing the message that
 * answered it*. Today that answer survives only as prose in `terminal_note`,
 * which is the same "it was said once and then it was gone" failure the whole
 * branch exists to fix, one level down.
 *
 * `resolution_ref` denormalises which attached artifact closed the obligation.
 * It is a plain column rather than a flag on the artifact row because it is
 * one-per-obligation and reads alongside `terminal_note` — the note says why in
 * words, the ref says where to go look.
 *
 * This is the obligation-shaped half of PR #76's proposal 3 (reference-based
 * evidence). The portable ledger's `quote: string` remains a separate problem;
 * the ref grammar here is chosen so it can be shared when that lands.
 */
export const obligationArtifacts: Migration = {
  id: "0028_obligation_artifacts",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS obligation_artifacts (
        id            TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
        obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
        ref           TEXT NOT NULL CHECK (length(trim(ref)) > 0),
        label         TEXT CHECK (label IS NULL OR length(trim(label)) > 0),
        attached_by   TEXT CHECK (attached_by IS NULL OR length(trim(attached_by)) > 0),
        attached_at   TEXT NOT NULL,
        UNIQUE (obligation_id, ref)
      );
    `);

    // Read path is always "the artifacts of this obligation", newest last.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_obligation_artifacts_obligation
        ON obligation_artifacts(obligation_id, attached_at, id);
    `);

    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(obligations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    if (!columns.has("resolution_ref")) {
      db.exec(
        `ALTER TABLE obligations ADD COLUMN resolution_ref TEXT
           CHECK (resolution_ref IS NULL OR length(trim(resolution_ref)) > 0)`
      );
    }
  },
};
