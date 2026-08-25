import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_EXCLUDED_BODY_PREFIXES } from "../../actor/mesh-events.js";
import { cleanupIntermediateMechanicalChatRows } from "./0007_cleanup_intermediate_mechanical_chat_rows.js";
import { runMigrations } from "./runner.js";

/** A representative full note body for a mechanical prefix. */
function mechanicalBody(prefix: (typeof CHAT_EXCLUDED_BODY_PREFIXES)[number]): string {
  return prefix === "[yield/" ? "[yield/complete] actor-a: done" : `${prefix} actor-a: details`;
}

function insertChat(db: Database.Database, row: { id: string; body: string; ts?: string }): void {
  db.prepare(
    `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
     VALUES (@id, @ts, 'sender', 'recipient', @body, NULL)`
  ).run({ id: row.id, ts: row.ts ?? "2026-07-19T03:00:00.000Z", body: row.body });
}

function chatIds(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM mesh_chat ORDER BY id ASC").all() as { id: string }[]).map(
    (r) => r.id
  );
}

describe("0007_cleanup_intermediate_mechanical_chat_rows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    runMigrations(db);
    vi.mocked(console.log).mockClear();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("deletes live-vintage mechanical rows, keeps legit and bf: rows, logs the count, and is idempotent", () => {
    // Live-vintage mechanical rows (one per reserved prefix) — the leak this cleans.
    for (const [index, prefix] of CHAT_EXCLUDED_BODY_PREFIXES.entries()) {
      insertChat(db, { id: `live-mech-${index}`, body: mechanicalBody(prefix) });
    }
    // Live-vintage genuine messages that merely resemble tagged text must survive.
    insertChat(db, { id: "live-real", body: "hey, the run failed earlier — can you retry?" });
    insertChat(db, { id: "live-bracketed", body: "[self-scheduled 08:12Z] Morning digest time" });
    // Legacy backfill rows are out of scope, even one crafted to carry a mechanical prefix.
    insertChat(db, { id: "bf:legacy-real", body: "legacy conversation body" });
    insertChat(db, { id: "bf:legacy-mechish", body: "[capped] legacy note kept by guard" });

    const before = chatIds(db);
    expect(before).toContain("live-mech-0");
    expect(before).toHaveLength(CHAT_EXCLUDED_BODY_PREFIXES.length + 4);

    cleanupIntermediateMechanicalChatRows.up(db);

    expect(chatIds(db)).toEqual([
      "bf:legacy-mechish",
      "bf:legacy-real",
      "live-bracketed",
      "live-real",
    ]);
    expect(console.log).toHaveBeenCalledWith(
      `Removed ${CHAT_EXCLUDED_BODY_PREFIXES.length} intermediate-vintage mechanical rows from mesh_chat.`
    );

    // Idempotent: a second pass removes nothing.
    vi.mocked(console.log).mockClear();
    cleanupIntermediateMechanicalChatRows.up(db);
    expect(chatIds(db)).toEqual([
      "bf:legacy-mechish",
      "bf:legacy-real",
      "live-bracketed",
      "live-real",
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "Removed 0 intermediate-vintage mechanical rows from mesh_chat."
    );
  });
});
