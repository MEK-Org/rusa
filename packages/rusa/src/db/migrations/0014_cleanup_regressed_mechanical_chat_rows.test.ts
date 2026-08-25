import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRegressedMechanicalChatRows } from "./0014_cleanup_regressed_mechanical_chat_rows.js";
import { runMigrations } from "./runner.js";

const TS = "2026-07-27T03:00:00.000Z";

function insertChat(
  db: Database.Database,
  row: { id: string; body: string; sender?: string; recipient?: string }
): void {
  db.prepare(
    `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
     VALUES (@id, @ts, @sender, @recipient, @body, NULL)`
  ).run({
    id: row.id,
    ts: TS,
    sender: row.sender ?? "child",
    recipient: row.recipient ?? "root",
    body: row.body,
  });
}

/** The regressed inbox payload: a `mesh.mechanical_note` that POINTS at a chat row. */
function insertInboxPointer(
  db: Database.Database,
  row: { id: string; actorId: string; messageId: string; extra?: Record<string, unknown> }
): void {
  const payload = {
    type: "mesh.mechanical_note",
    messageId: row.messageId,
    fromId: "child",
    ...row.extra,
  };
  db.prepare(
    `INSERT INTO actor_inbox_entries (id, actor_id, source, delivered_at, payload_json)
     VALUES (@id, @actorId, 'mesh:mechanical:child', @ts, @payload)`
  ).run({ id: row.id, actorId: row.actorId, ts: TS, payload: JSON.stringify(payload) });
}

/** The already-fixed inbox payload: a `mesh.mechanical_note` with the note INLINE. */
function insertInboxInline(
  db: Database.Database,
  row: { id: string; actorId: string; note: string }
): void {
  const payload = { type: "mesh.mechanical_note", note: row.note, fromId: "child" };
  db.prepare(
    `INSERT INTO actor_inbox_entries (id, actor_id, source, delivered_at, payload_json)
     VALUES (@id, @actorId, 'mesh:mechanical:child', @ts, @payload)`
  ).run({ id: row.id, actorId: row.actorId, ts: TS, payload: JSON.stringify(payload) });
}

/** The two spine events `recordMessageEmitted` writes for a message. */
function insertMessageEvents(
  db: Database.Database,
  row: { sentId: string; recvId: string; messageId: string; fromId: string; toId: string }
): void {
  const insert = db.prepare(
    `INSERT INTO mesh_events (id, ts, kind, actor_id, payload)
     VALUES (@id, @ts, @kind, @actorId, @payload)`
  );
  insert.run({
    id: row.sentId,
    ts: TS,
    kind: "message_sent",
    actorId: row.fromId,
    payload: JSON.stringify({ messageId: row.messageId, to: row.toId }),
  });
  insert.run({
    id: row.recvId,
    ts: TS,
    kind: "message_received",
    actorId: row.toId,
    payload: JSON.stringify({ messageId: row.messageId, from: row.fromId }),
  });
}

function chatIds(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM mesh_chat ORDER BY id ASC").all() as { id: string }[]).map(
    (r) => r.id
  );
}

function inboxPayload(db: Database.Database, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT payload_json FROM actor_inbox_entries WHERE id = ?").get(id) as
    | { payload_json: string }
    | undefined;
  if (!row) throw new Error(`no inbox row ${id}`);
  return JSON.parse(row.payload_json);
}

function eventKind(db: Database.Database, id: string): string | undefined {
  return (db.prepare("SELECT kind FROM mesh_events WHERE id = ?").get(id) as { kind: string })
    ?.kind;
}

/** messageIds of every row still selectable as an inbound `message_received`. */
function receivedMessageIds(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT json_extract(payload, '$.messageId') AS mid FROM mesh_events WHERE kind = 'message_received' ORDER BY mid ASC"
      )
      .all() as { mid: string }[]
  ).map((r) => r.mid);
}

describe("0014_cleanup_regressed_mechanical_chat_rows", () => {
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

  function seedFixture(): void {
    // Regressed yield notice A: full three-part shape (chat + events + pointer inbox row).
    insertChat(db, { id: "m-A", body: "[yield/complete] root: done" });
    insertMessageEvents(db, {
      sentId: "ev-sent-A",
      recvId: "ev-recv-A",
      messageId: "m-A",
      fromId: "child",
      toId: "root",
    });
    insertInboxPointer(db, {
      id: "ibx-A",
      actorId: "root",
      messageId: "m-A",
      extra: { runId: "run-A", status: "complete" },
    });

    // Regressed scheduled-drop notice B: the runless class (no runId in the payload).
    insertChat(db, { id: "m-B", body: "[scheduled message dropped] child: capped at 3" });
    insertMessageEvents(db, {
      sentId: "ev-sent-B",
      recvId: "ev-recv-B",
      messageId: "m-B",
      fromId: "child",
      toId: "root",
    });
    insertInboxPointer(db, { id: "ibx-B", actorId: "root", messageId: "m-B" });

    // GENUINE message that merely BEGINS with a reserved tag, with real spine events,
    // and NO mechanical-note pointer. Provenance scoping must leave it fully intact —
    // this is the case a body-prefix predicate would wrongly destroy.
    insertChat(db, { id: "g-real", body: "[yield/ actually a human musing about yields]" });
    insertMessageEvents(db, {
      sentId: "ev-sent-G",
      recvId: "ev-recv-G",
      messageId: "g-real",
      fromId: "operator",
      toId: "root",
    });

    // A normal conversation message — untouched.
    insertChat(db, { id: "n-real", body: "morning — anything blocking?" });
    insertMessageEvents(db, {
      sentId: "ev-sent-N",
      recvId: "ev-recv-N",
      messageId: "n-real",
      fromId: "root",
      toId: "child",
    });

    // A legacy backfill chat row — out of scope regardless of body.
    insertChat(db, { id: "bf:legacy", body: "legacy conversation body" });

    // An already-migrated inline mechanical note — must be a no-op (no messageId pointer).
    insertInboxInline(db, {
      id: "ibx-inline",
      actorId: "root",
      note: "[run failed] child: exit 1",
    });
  }

  it("migrates payloads inline, retires chat rows, and re-labels paired events by provenance", () => {
    seedFixture();

    cleanupRegressedMechanicalChatRows.up(db);

    // Chat: only the two regressed rows are gone; the reserved-prefix genuine
    // message, the normal message, and the bf: row all survive.
    expect(chatIds(db)).toEqual(["bf:legacy", "g-real", "n-real"]);

    // Inbox pointers rewritten to the inline `note` form (note == the old chat body),
    // messageId dropped, other fields preserved. No dangling pointer left behind.
    const a = inboxPayload(db, "ibx-A");
    expect(a).toEqual({
      type: "mesh.mechanical_note",
      note: "[yield/complete] root: done",
      fromId: "child",
      runId: "run-A",
      status: "complete",
    });
    expect(a).not.toHaveProperty("messageId");
    const b = inboxPayload(db, "ibx-B");
    expect(b.note).toBe("[scheduled message dropped] child: capped at 3");
    expect(b).not.toHaveProperty("messageId");

    // Already-inline note untouched.
    expect(inboxPayload(db, "ibx-inline")).toEqual({
      type: "mesh.mechanical_note",
      note: "[run failed] child: exit 1",
      fromId: "child",
    });

    // Paired events RE-LABELLED, not deleted: the rows still exist by id (so a
    // persisted portable-context watermark pointing at them still resolves) but
    // fall out of every `message_received`/`message_sent` reader.
    for (const id of ["ev-sent-A", "ev-recv-A", "ev-sent-B", "ev-recv-B"]) {
      expect(eventKind(db, id)).toBe("mechanical_note");
    }
    // Genuine + normal message events keep their kind.
    expect(eventKind(db, "ev-recv-G")).toBe("message_received");
    expect(eventKind(db, "ev-sent-G")).toBe("message_sent");
    expect(eventKind(db, "ev-recv-N")).toBe("message_received");

    // Portable-context scope: no regressed notice is selectable as an inbound message.
    expect(receivedMessageIds(db)).toEqual(["g-real", "n-real"]);
  });

  it("logs the per-part counts", () => {
    seedFixture();
    cleanupRegressedMechanicalChatRows.up(db);
    expect(console.log).toHaveBeenCalledWith(
      "0014: cleaned 2 regressed mechanical notices — 2 inbox payloads inlined, " +
        "2 mesh_chat rows removed, 4 paired events re-labelled to mechanical_note."
    );
  });

  it("is idempotent — a second pass finds nothing", () => {
    seedFixture();
    cleanupRegressedMechanicalChatRows.up(db);
    const chatAfter = chatIds(db);
    const inboxAfter = inboxPayload(db, "ibx-A");

    vi.mocked(console.log).mockClear();
    cleanupRegressedMechanicalChatRows.up(db);

    expect(chatIds(db)).toEqual(chatAfter);
    expect(inboxPayload(db, "ibx-A")).toEqual(inboxAfter);
    expect(eventKind(db, "ev-recv-A")).toBe("mechanical_note");
    expect(console.log).toHaveBeenCalledWith("0014: no regressed mechanical notices to clean up.");
  });

  it("skips cleanly when a required table/column is absent", () => {
    const bare = new Database(":memory:");
    bare.exec("CREATE TABLE mesh_chat (id TEXT PRIMARY KEY, body TEXT)");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    cleanupRegressedMechanicalChatRows.up(bare);
    expect(logSpy).toHaveBeenCalledWith(
      "0014: skipped regressed-mechanical cleanup; a required table/column is absent."
    );
    bare.close();
  });
});
