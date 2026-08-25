import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DROPPED_MESSAGE_DETAIL } from "../../actor/mesh-events.js";
import { MeshEventRepository } from "../repositories/mesh-event-repository.js";
import { backfillMeshChatFromLegacyEvents } from "./0006_backfill_mesh_chat_from_legacy_events.js";
import { migrations } from "./index.js";

const systemNotePrefixesToExclude = [
  "[yield/",
  "[run failed]",
  "[message redelivery capped]",
  "[capped]",
  "[scheduled message dropped]",
] as const;

describe("0006_backfill_mesh_chat_from_legacy_events", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const m of migrations.slice(0, 5)) {
      m.up(db);
    }
    vi.mocked(console.log).mockClear();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("backfills legacy message bodies, skips dropped and system notes, and is idempotent", () => {
    seedLegacyRows(db);

    backfillMeshChatFromLegacyEvents.up(db);

    expect(console.log).toHaveBeenCalledWith(
      "Skipped 1 dropped message_sent rows during legacy mesh_chat backfill."
    );
    expectSystemNoteSkipLogs();

    const chatRows = db.prepare("SELECT * FROM mesh_chat ORDER BY id ASC").all() as Array<
      Record<string, string | null>
    >;
    expect(chatRows).toEqual([
      {
        id: "bf:legacy-null-detail-sent",
        ts: "2026-07-18T21:00:30.000Z",
        sender_id: "sender-null-detail",
        recipient_id: "recipient-null-detail",
        body: "legacy null-detail sent body",
        session_id: null,
      },
      {
        id: "bf:legacy-received",
        ts: "2026-07-18T21:01:00.000Z",
        sender_id: "sender-b",
        recipient_id: "recipient-b",
        body: "legacy received body",
        session_id: "session-b",
      },
      {
        id: "bf:legacy-sent",
        ts: "2026-07-18T21:00:00.000Z",
        sender_id: "sender-a",
        recipient_id: "recipient-a",
        body: "legacy sent body",
        session_id: "session-a",
      },
      {
        id: "existing-chat",
        ts: "2026-07-18T20:59:00.000Z",
        sender_id: "sender-existing",
        recipient_id: "recipient-existing",
        body: "already migrated chat body",
        session_id: "session-existing",
      },
    ]);

    expect(eventPayload(db, "legacy-sent")).toEqual({ messageId: "bf:legacy-sent" });
    expect(eventPayload(db, "legacy-null-detail-sent")).toEqual({
      messageId: "bf:legacy-null-detail-sent",
    });
    expect(eventPayload(db, "legacy-received")).toEqual({ messageId: "bf:legacy-received" });
    expect(eventPayload(db, "already-migrated")).toEqual({ messageId: "existing-chat" });
    expect(eventPayload(db, "dropped-sent")).toBeNull();
    for (const prefix of systemNotePrefixesToExclude) {
      expect(eventPayload(db, systemNoteId(prefix))).toBeNull();
    }

    const repo = new MeshEventRepository(db);
    expect(repo.getById("legacy-sent")?.body).toBe("legacy sent body");
    expect(repo.getById("legacy-null-detail-sent")?.body).toBe("legacy null-detail sent body");
    expect(repo.getById("legacy-received")?.body).toBe("legacy received body");

    const joinedBodies = db
      .prepare(
        `
        SELECT e.id, c.body
        FROM mesh_events e
        JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
        WHERE e.id IN ('legacy-sent', 'legacy-null-detail-sent', 'legacy-received')
        ORDER BY e.id ASC
      `
      )
      .all();
    expect(joinedBodies).toEqual([
      { id: "legacy-null-detail-sent", body: "legacy null-detail sent body" },
      { id: "legacy-received", body: "legacy received body" },
      { id: "legacy-sent", body: "legacy sent body" },
    ]);

    const dropped = db
      .prepare("SELECT body, payload FROM mesh_events WHERE id = 'dropped-sent'")
      .get() as { body: string; payload: string | null };
    expect(dropped).toEqual({ body: "dropped body", payload: null });
    expect(
      db.prepare("SELECT id FROM mesh_chat WHERE id = 'bf:dropped-sent'").get()
    ).toBeUndefined();

    for (const prefix of systemNotePrefixesToExclude) {
      const id = systemNoteId(prefix);
      const event = db.prepare("SELECT body, payload FROM mesh_events WHERE id = ?").get(id) as {
        body: string;
        payload: string | null;
      };
      expect(event).toEqual({
        body: systemNoteBody(prefix),
        payload: null,
      });
      expect(db.prepare("SELECT id FROM mesh_chat WHERE id = ?").get(`bf:${id}`)).toBeUndefined();
    }

    const beforeSecondRun = snapshotBackfilledTables(db);
    vi.mocked(console.log).mockClear();

    backfillMeshChatFromLegacyEvents.up(db);

    expect(snapshotBackfilledTables(db)).toEqual(beforeSecondRun);
    expect(console.log).toHaveBeenCalledWith(
      "Skipped 1 dropped message_sent rows during legacy mesh_chat backfill."
    );
    expectSystemNoteSkipLogs();
  });
});

function seedLegacyRows(db: Database.Database): void {
  const insertEvent = db.prepare(`
    INSERT INTO mesh_events (id, ts, kind, actor_id, peer_id, detail, body, payload, success)
    VALUES (@id, @ts, @kind, @actorId, @peerId, @detail, @body, @payload, NULL)
  `);

  insertEvent.run({
    id: "legacy-sent",
    ts: "2026-07-18T21:00:00.000Z",
    kind: "message_sent",
    actorId: "recipient-a",
    peerId: "sender-a",
    detail: "session-a",
    body: "legacy sent body",
    payload: null,
  });
  insertEvent.run({
    id: "legacy-received",
    ts: "2026-07-18T21:01:00.000Z",
    kind: "message_received",
    actorId: "recipient-b",
    peerId: "sender-b",
    detail: "session-b",
    body: "legacy received body",
    payload: null,
  });
  insertEvent.run({
    id: "legacy-null-detail-sent",
    ts: "2026-07-18T21:00:30.000Z",
    kind: "message_sent",
    actorId: "recipient-null-detail",
    peerId: "sender-null-detail",
    detail: null,
    body: "legacy null-detail sent body",
    payload: null,
  });
  insertEvent.run({
    id: "dropped-sent",
    ts: "2026-07-18T21:02:00.000Z",
    kind: "message_sent",
    actorId: "recipient-drop",
    peerId: "sender-drop",
    detail: DROPPED_MESSAGE_DETAIL,
    body: "dropped body",
    payload: null,
  });
  for (const [index, prefix] of systemNotePrefixesToExclude.entries()) {
    insertEvent.run({
      id: systemNoteId(prefix),
      ts: `2026-07-18T21:03:0${index}.000Z`,
      kind: "message_sent",
      actorId: "parent-thread",
      peerId: `system-note-thread-${index}`,
      detail: index === 0 ? null : `session-system-note-${index}`,
      body: systemNoteBody(prefix),
      payload: null,
    });
  }
  insertEvent.run({
    id: "already-migrated",
    ts: "2026-07-18T20:59:00.000Z",
    kind: "message_sent",
    actorId: "recipient-existing",
    peerId: "sender-existing",
    detail: "session-existing",
    body: "already migrated inline body",
    payload: JSON.stringify({ messageId: "existing-chat" }),
  });

  db.prepare(
    `
    INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(
    "existing-chat",
    "2026-07-18T20:59:00.000Z",
    "sender-existing",
    "recipient-existing",
    "already migrated chat body",
    "session-existing"
  );
}

function expectSystemNoteSkipLogs(): void {
  for (const prefix of systemNotePrefixesToExclude) {
    expect(console.log).toHaveBeenCalledWith(
      `Skipped 1 ${JSON.stringify(prefix)} message rows during legacy mesh_chat backfill.`
    );
  }
}

function systemNoteId(prefix: (typeof systemNotePrefixesToExclude)[number]): string {
  return `system-note-${systemNotePrefixesToExclude.indexOf(prefix)}`;
}

function systemNoteBody(prefix: (typeof systemNotePrefixesToExclude)[number]): string {
  return `${prefix}${prefix === "[yield/" ? "complete] actor-a: done" : " actor-a: done"}`;
}

function eventPayload(db: Database.Database, id: string): unknown {
  const row = db.prepare("SELECT payload FROM mesh_events WHERE id = ?").get(id) as {
    payload: string | null;
  };
  return row.payload == null ? null : JSON.parse(row.payload);
}

function snapshotBackfilledTables(db: Database.Database): Record<string, unknown[]> {
  return {
    events: db.prepare("SELECT * FROM mesh_events ORDER BY id ASC").all() as unknown[],
    chat: db.prepare("SELECT * FROM mesh_chat ORDER BY id ASC").all() as unknown[],
  };
}
