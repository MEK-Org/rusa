import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyPortableContextState } from "../actor/portable-context-state.js";
import { CONFIGURED_ACTOR_ID_COLUMNS } from "./configured-actor-id.js";
import { importConfiguredActor } from "./configured-actor-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

const ID = "f42e93fb-94c7-4c2a-bb16-7161b3a9d346";
const AT = "2026-01-01T00:00:00.000Z";
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const repositories = new Repositories(db);
  repositories.actors.upsert({
    id: "root",
    parentId: null,
    charter: "stored charter",
    displayHandle: "given-handle",
    modelConfig: [{ provider: "synthetic", model: "synthetic" }],
    context: { type: "native" },
    sessionId: "native-session",
    status: "active",
    createdAt: AT,
  });
  repositories.actors.upsert({
    id: "child",
    parentId: "root",
    charter: "child charter",
    status: "active",
    createdAt: AT,
    handles: [{ id: "root", role: "parent" }],
  });
  return {
    db,
    repositories,
    run: (receipts = repositories.legacyImportReceipts, selectedActorId?: string) =>
      importConfiguredActor({
        db,
        actors: repositories.actors,
        receipts,
        selectedActorId,
        workersDir: "/synthetic-absent/workers",
        avatarCachePath: "/synthetic-absent/avatar.png",
        seed: {
          handle: "different-config-handle",
          executionConfig: { unsandboxed: true },
          modelConfig: () => [],
        },
        idgen: () => ID,
        now: () => AT,
      }),
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("#1005 legacy root UUID", () => {
  it("gives the existing root a UUID once while preserving its handle, session and child links", () => {
    const { repositories, db, run } = fixture();
    const before = repositories.actors.get("root");
    expect(run().actorId).toBe(ID);
    expect(repositories.actors.get("root")).toBeUndefined();
    expect(repositories.actors.get(ID)).toEqual({ ...before, id: ID });
    expect(repositories.actors.get("child")).toMatchObject({
      parentId: ID,
      handles: [{ id: ID, role: "parent" }],
    });
    expect(repositories.principals.get(ID)).toMatchObject({ id: ID, kind: "actor", createdAt: AT });
    expect(repositories.principals.get("root")).toBeUndefined();
    expect(run()).toMatchObject({ actorId: ID, plan: { kind: "completed" } });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("accepts the same explicit legacy-root selection on a repeated import", () => {
    const { run } = fixture();
    expect(run(undefined, "root").actorId).toBe(ID);
    expect(run(undefined, "root")).toMatchObject({ actorId: ID, plan: { kind: "completed" } });
  });

  it("moves every actor-owned SQL link, typed context and pending inbox metadata without changing prose or row ids", () => {
    const { db, repositories, run } = fixture();
    db.exec(`
      INSERT INTO principals VALUES ('operator', 'user', '${AT}');
      INSERT INTO users(principal_id,email,root_actor_id) VALUES ('operator','synthetic@example.test','root');
      INSERT INTO capability_grants VALUES ('root','cap','root','${AT}',NULL);
      INSERT INTO event_source_owners(resource,actor_id,subscribed_by,subscribed_at) VALUES ('github:example/repo','root','root','${AT}');
      INSERT INTO event_source_subscriptions VALUES ('github:example/repo','root','root','${AT}');
      INSERT INTO actor_experiments VALUES ('root','synthetic','root','${AT}');
      INSERT INTO chat_room_participants VALUES ('root','root','${AT}');
      INSERT INTO host_jobs(id,actor_id,unit_name,script_label,manifest,audit_artifact_path,audit_artifact_sha256,runtime_max_sec,submitted_at)
        VALUES ('job','root','unit','root','{}','/synthetic/root/path','root',1,'${AT}');
      INSERT INTO actor_runs(id,actor_id,started_at,output) VALUES ('run','root','${AT}','root');
      INSERT INTO mesh_chat(id,ts,sender_id,recipient_id,body) VALUES ('message','${AT}','root','child','root');
      INSERT INTO mesh_events(id,ts,kind,actor_id,body) VALUES ('event','${AT}','synthetic','root','root');
      INSERT INTO obligations(id,owner_id,creator_id,checkpoint_by,checkpoint,checkpoint_at,intent,status,created_at,updated_at)
        VALUES ('work','root','root','root','root','${AT}','root','ready','${AT}','${AT}');
      INSERT INTO obligation_artifacts(id,obligation_id,ref,attached_by,attached_at)
        VALUES ('artifact','work','mesh:messages/message','root','${AT}');
      INSERT INTO obligation_history(obligation_id,mutation_kind,acting_principal,timestamp,payload)
        VALUES ('work','owner','root','${AT}','{"schemaVersion":1,"before":{"ownerId":"root"},"after":{"ownerId":"child","message":"root"}}');
      INSERT INTO portable_brief_revisions(actor_id,generation,acting_principal,timestamp,payload)
        VALUES ('root',1,'root','${AT}','{"schemaVersion":1,"before":"root","after":"root"}');
    `);
    repositories.inbox.append([
      {
        id: "inbox",
        actorId: "root",
        source: "mesh:root",
        payload: { type: "mesh.message", messageId: "message", fromId: "root", body: "root" },
      },
    ]);
    db.exec(`
      INSERT INTO inbox_entry_obligations(actor_id,entry_id,obligation_id,associated_at) VALUES ('root','inbox','work','${AT}');
      INSERT INTO obligation_capture_receipts(inbox_entry_id,obligation_id,actor_id,source_type,status,created_at)
        VALUES ('inbox','work','root','mesh','captured','${AT}');
    `);
    const state = {
      ...emptyPortableContextState("root"),
      generation: 7,
      lastFoldedSourceId: "message",
      items: [
        {
          id: "memory",
          kind: "decision" as const,
          priority: "must" as const,
          status: "active" as const,
          statement: "root",
          updatedAt: AT,
          evidence: [{ eventId: "message", sender: "root", ts: AT, quote: "root" }],
        },
      ],
    };
    repositories.portableContext.save(state);
    run();
    for (const [table, columns] of Object.entries(CONFIGURED_ACTOR_ID_COLUMNS)) {
      for (const column of columns)
        expect(
          db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = 'root'`).all(),
          `${table}.${column}`
        ).toEqual([]);
    }
    expect(repositories.portableContext.load(ID)).toEqual({
      ...state,
      actorId: ID,
      items: [{ ...state.items[0], evidence: [{ ...state.items[0].evidence[0], sender: ID }] }],
    });
    expect(repositories.inbox.read(ID, "inbox")).toMatchObject({
      actorId: ID,
      source: `mesh:${ID}`,
      payload: { fromId: ID, messageId: "message", body: "root" },
    });
    expect(repositories.meshChat.getById("message")).toMatchObject({ senderId: ID, body: "root" });
    expect(
      JSON.parse(
        (db.prepare("SELECT payload FROM obligation_history").get() as { payload: string }).payload
      )
    ).toMatchObject({ before: { ownerId: ID }, after: { ownerId: "child", message: "root" } });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps identity rewriting complete across document pages", () => {
    const { db, repositories, run } = fixture();
    repositories.inbox.append(
      Array.from({ length: 300 }, (_, index) => ({
        id: `entry-${index}`,
        actorId: "root",
        source: "mesh:root",
        payload: { type: "mesh.message", fromId: "root", messageId: `message-${index}` },
      }))
    );
    run();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM actor_inbox_entries WHERE actor_id = ?").get(ID)
    ).toEqual({ count: 300 });
    expect(repositories.inbox.read(ID, "entry-299")?.payload.fromId).toBe(ID);
  });

  it("rolls identity and all dependent rows back if the completion receipt fails, then retries cleanly", () => {
    const { db, repositories, run } = fixture();
    const rows = () => ({
      actors: repositories.actors.list(),
      principals: db.prepare("SELECT * FROM principals").all(),
      handles: db.prepare("SELECT * FROM actor_handles").all(),
    });
    const before = rows();
    const receipts = repositories.legacyImportReceipts;
    const spy = vi.spyOn(receipts, "record").mockImplementationOnce(() => {
      throw new Error("interrupted");
    });
    expect(() => run()).toThrow("interrupted");
    expect(rows()).toEqual(before);
    expect(receipts.has("config.yaml:rootActor")).toBe(false);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    spy.mockRestore();
    expect(run().actorId).toBe(ID);
  });

  it("refuses a generated id collision before changing the legacy identity", () => {
    const { db, repositories, run } = fixture();
    db.prepare("INSERT INTO principals VALUES (?, 'system', ?)").run(ID, AT);
    expect(() => run()).toThrow("already belongs to a principal");
    expect(repositories.actors.get("root")?.displayHandle).toBe("given-handle");
    expect(repositories.actors.get("child")?.parentId).toBe("root");
    expect(repositories.legacyImportReceipts.has("config.yaml:rootActor")).toBe(false);
  });

  it("covers every foreign key to actors and every actor_id column in the current schema", () => {
    const { db } = fixture();
    const inventory: Record<string, readonly string[]> = CONFIGURED_ACTOR_ID_COLUMNS;
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]) {
      for (const column of db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]) {
        if (column.name === "actor_id") expect(inventory[name], name).toContain(column.name);
      }
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${name})`).all() as {
        table: string;
        from: string;
      }[]) {
        if (fk.table === "actors") expect(inventory[name], name).toContain(fk.from);
      }
    }
  });
});
