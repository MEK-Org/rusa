import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../actor/actor.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import {
  backupDatabase,
  executeLegacyPrincipalMigration,
  generateMigrationReport,
  inventoryLegacyReferences,
} from "./legacy-migration.js";

const ROOT_ID = "root";
const WORKER_ID = "worker-1";

function createMockLiveActor(id: string): Actor {
  return {
    id,
    requestRun: () => {},
    declareYield: () => {},
    markUnkillable: () => {},
    close: () => {},
    isRunning: false,
    preemptForResponsive: () => ({ preempted: false as const }),
  } as unknown as Actor;
}

function setupLegacyDatabase(dbPath?: string): Database.Database {
  const db = new Database(dbPath ?? ":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Seed actors
  const actorRepo = new SqliteActorRepository(db);
  actorRepo.upsert({
    id: ROOT_ID,
    charter: "root actor",
    parentId: null,
    isRoot: true,
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  actorRepo.upsert({
    id: WORKER_ID,
    charter: "worker actor",
    parentId: ROOT_ID,
    status: "active",
    createdAt: "2026-09-01T01:00:00.000Z",
  });

  // 1. Authoritative references
  // obligations.owner_id and obligations.creator_id
  db.prepare(
    `INSERT INTO obligations (id, owner_id, creator_id, title, intent, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "ob-1",
    HUMAN_OPERATOR,
    HUMAN_OPERATOR,
    "Migrate human identity",
    "Switch human:operator to durable principal",
    "2026-09-01T02:00:00.000Z",
    "2026-09-01T02:00:00.000Z",
    "ready"
  );
  db.prepare(
    `INSERT INTO obligations (id, owner_id, creator_id, title, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "ob-2",
    ROOT_ID,
    HUMAN_OPERATOR,
    "Secondary task",
    "2026-09-01T02:05:00.000Z",
    "2026-09-01T02:05:00.000Z",
    "ready"
  );

  // obligation_history.acting_principal
  db.prepare(
    `INSERT INTO obligation_history (id, obligation_id, timestamp, mutation_kind, acting_principal, payload)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    1,
    "ob-1",
    "2026-09-01T02:00:00.000Z",
    "create",
    HUMAN_OPERATOR,
    JSON.stringify({ note: "created by human:operator" })
  );

  // mesh_chat.sender_id and mesh_chat.recipient_id
  db.prepare(
    `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "chat-1",
    "2026-09-01T02:10:00.000Z",
    HUMAN_OPERATOR,
    ROOT_ID,
    "Hello root from human:operator",
    "sess-1"
  );
  db.prepare(
    `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("chat-2", "2026-09-01T02:11:00.000Z", ROOT_ID, HUMAN_OPERATOR, "Hello operator!", "sess-1");

  // capability_grants.granted_by
  db.prepare(
    `INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at)
     VALUES (?, ?, ?, ?)`
  ).run(WORKER_ID, "spawn", HUMAN_OPERATOR, "2026-09-01T01:30:00.000Z");

  // 2. Untouched reference sites
  // mesh_events: actor_id, body, payload
  db.prepare(
    `INSERT INTO mesh_events (id, ts, kind, actor_id, body, payload)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "evt-1",
    "2026-09-01T02:10:00.000Z",
    "human_message",
    HUMAN_OPERATOR,
    "Human operator message event",
    JSON.stringify({ author: HUMAN_OPERATOR })
  );

  // actor_inbox_entries: source, payload_json
  db.prepare(
    `INSERT INTO actor_inbox_entries (id, actor_id, source, delivered_at, payload_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "inbox-1",
    ROOT_ID,
    `mesh:${HUMAN_OPERATOR}`,
    "2026-09-01T02:10:00.000Z",
    JSON.stringify({ type: "mesh.message", from: HUMAN_OPERATOR, body: "hello" })
  );

  return db;
}

describe("legacy-migration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rusa-legacy-migration-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("inventoryLegacyReferences", () => {
    it("correctly counts all exact authoritative references and untouched sites", () => {
      const db = setupLegacyDatabase();
      const inventory = inventoryLegacyReferences(db);

      // Total authoritative references = 7:
      // obligations.owner_id: 1
      // obligations.creator_id: 2
      // obligation_history.acting_principal: 1
      // mesh_chat.sender_id: 1
      // mesh_chat.recipient_id: 1
      // capability_grants.granted_by: 1
      expect(inventory.totalAuthoritative).toBe(7);

      const authMap = new Map(
        inventory.authoritative.map((a) => [`${a.table}.${a.column}`, a.count])
      );
      expect(authMap.get("obligations.owner_id")).toBe(1);
      expect(authMap.get("obligations.creator_id")).toBe(2);
      expect(authMap.get("obligation_history.acting_principal")).toBe(1);
      expect(authMap.get("mesh_chat.sender_id")).toBe(1);
      expect(authMap.get("mesh_chat.recipient_id")).toBe(1);
      expect(authMap.get("capability_grants.granted_by")).toBe(1);

      // Untouched sites exist and are counted
      expect(inventory.totalUntouched).toBeGreaterThan(0);
      const untouchedMap = new Map(
        inventory.untouched.map((u) => [`${u.table}.${u.column}`, u.count])
      );
      expect(untouchedMap.get("mesh_events.actor_id")).toBe(1);
      expect(untouchedMap.get("mesh_chat.body")).toBe(1);
      expect(untouchedMap.get("actor_inbox_entries.source")).toBe(1);

      db.close();
    });
  });

  describe("executeLegacyPrincipalMigration", () => {
    it("requires an explicit and valid email address", () => {
      const db = setupLegacyDatabase();

      expect(() => executeLegacyPrincipalMigration(db, { email: "", apply: false })).toThrow(
        /explicit email is required/
      );

      expect(() =>
        executeLegacyPrincipalMigration(db, { email: "notanemail", apply: false })
      ).toThrow(/Invalid email/);

      db.close();
    });

    it("performs dry run without modifying any rows or creating principals", () => {
      const db = setupLegacyDatabase();

      const result = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: false,
      });

      expect(result.applied).toBe(false);
      expect(result.email).toBe("operator@example.com");
      expect(result.preInventory.totalAuthoritative).toBe(7);
      expect(result.rewritesApplied).toBe(0);

      // Verify no user was created
      const principals = new PrincipalRepository(db);
      expect(principals.findUserByEmail("operator@example.com")).toBeUndefined();
      expect(principals.listUsers()).toHaveLength(0);

      // Verify authoritative rows are unchanged
      const inventory = inventoryLegacyReferences(db);
      expect(inventory.totalAuthoritative).toBe(7);

      db.close();
    });

    it("applies migration atomically and rewrites all authoritative references", () => {
      const db = setupLegacyDatabase();

      const result = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.principalCreated).toBe(true);
      expect(result.principalReused).toBe(false);
      expect(result.rewritesApplied).toBe(7);
      expect(result.principalId).toBeTruthy();

      // Verify user principal exists
      const principals = new PrincipalRepository(db);
      const user = principals.getUser(result.principalId);
      expect(user).toBeDefined();
      expect(user?.email).toBe("operator@example.com");
      expect(user?.kind).toBe("user");

      // Verify authoritative references rewritten
      const postInventory = inventoryLegacyReferences(db);
      expect(postInventory.totalAuthoritative).toBe(0);

      // Verify exact migrated columns
      const ob1 = db
        .prepare("SELECT owner_id, creator_id FROM obligations WHERE id = 'ob-1'")
        .get() as {
        owner_id: string;
        creator_id: string;
      };
      expect(ob1.owner_id).toBe(result.principalId);
      expect(ob1.creator_id).toBe(result.principalId);

      const ob2 = db
        .prepare("SELECT owner_id, creator_id FROM obligations WHERE id = 'ob-2'")
        .get() as {
        owner_id: string;
        creator_id: string;
      };
      expect(ob2.owner_id).toBe(ROOT_ID);
      expect(ob2.creator_id).toBe(result.principalId);

      const hist = db
        .prepare("SELECT acting_principal FROM obligation_history WHERE id = 1")
        .get() as {
        acting_principal: string;
      };
      expect(hist.acting_principal).toBe(result.principalId);

      const chat1 = db
        .prepare("SELECT sender_id, recipient_id FROM mesh_chat WHERE id = 'chat-1'")
        .get() as {
        sender_id: string;
        recipient_id: string;
      };
      expect(chat1.sender_id).toBe(result.principalId);
      expect(chat1.recipient_id).toBe(ROOT_ID);

      const chat2 = db
        .prepare("SELECT sender_id, recipient_id FROM mesh_chat WHERE id = 'chat-2'")
        .get() as {
        sender_id: string;
        recipient_id: string;
      };
      expect(chat2.sender_id).toBe(ROOT_ID);
      expect(chat2.recipient_id).toBe(result.principalId);

      const grant = db
        .prepare("SELECT granted_by FROM capability_grants WHERE actor_id = ?")
        .get(WORKER_ID) as {
        granted_by: string;
      };
      expect(grant.granted_by).toBe(result.principalId);

      // Verify untouched reference sites are completely preserved
      const evt = db
        .prepare("SELECT actor_id, body, payload FROM mesh_events WHERE id = 'evt-1'")
        .get() as {
        actor_id: string;
        body: string;
        payload: string;
      };
      expect(evt.actor_id).toBe(HUMAN_OPERATOR);
      expect(evt.body).toBe("Human operator message event");
      expect(JSON.parse(evt.payload).author).toBe(HUMAN_OPERATOR);

      const chatBody = db.prepare("SELECT body FROM mesh_chat WHERE id = 'chat-1'").get() as {
        body: string;
      };
      expect(chatBody.body).toBe("Hello root from human:operator");

      const inbox = db
        .prepare("SELECT source, payload_json FROM actor_inbox_entries WHERE id = 'inbox-1'")
        .get() as {
        source: string;
        payload_json: string;
      };
      expect(inbox.source).toBe(`mesh:${HUMAN_OPERATOR}`);
      expect(JSON.parse(inbox.payload_json).from).toBe(HUMAN_OPERATOR);

      db.close();
    });

    it("is idempotent on rerun and reuses the durable principal", () => {
      const db = setupLegacyDatabase();

      // First run: apply
      const first = executeLegacyPrincipalMigration(db, {
        email: "Operator@Example.Com ",
        apply: true,
      });
      expect(first.applied).toBe(true);
      expect(first.principalCreated).toBe(true);
      expect(first.rewritesApplied).toBe(7);

      // Second run: rerun
      const second = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });

      expect(second.applied).toBe(true);
      expect(second.principalCreated).toBe(false);
      expect(second.principalReused).toBe(true);
      expect(second.principalId).toBe(first.principalId);
      expect(second.rewritesApplied).toBe(0);
      expect(second.preInventory.totalAuthoritative).toBe(0);
      expect(second.postInventory?.totalAuthoritative).toBe(0);

      db.close();
    });

    it("binds external identity by verified issuer and subject and rejects conflicts", () => {
      const db = setupLegacyDatabase();

      // Migrate with external identity
      const result = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        issuer: "https://securetoken.google.com/proj-1",
        subject: "firebase-uid-123",
        apply: true,
      });

      expect(result.externalIdentityBound).toBe(false); // bound during creation
      const principals = new PrincipalRepository(db);
      const user = principals.getUser(result.principalId);
      expect(user?.identity).toEqual({
        issuer: "https://securetoken.google.com/proj-1",
        subject: "firebase-uid-123",
      });

      // Rerun with matching identity succeeds
      const rerun = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        issuer: "https://securetoken.google.com/proj-1",
        subject: "firebase-uid-123",
        apply: true,
      });
      expect(rerun.principalId).toBe(result.principalId);

      // Rerun with conflicting identity is rejected
      expect(() =>
        executeLegacyPrincipalMigration(db, {
          email: "operator@example.com",
          issuer: "https://securetoken.google.com/proj-1",
          subject: "different-uid",
          apply: true,
        })
      ).toThrow(/Conflicting identity binding/);

      // Binding an already-bound external identity to a second user is rejected
      expect(() =>
        executeLegacyPrincipalMigration(db, {
          email: "another@example.com",
          issuer: "https://securetoken.google.com/proj-1",
          subject: "firebase-uid-123",
          apply: true,
        })
      ).toThrow(/Conflicting identity binding/);

      db.close();
    });

    it("rolls back completely on interruption or transaction failure", () => {
      const db = setupLegacyDatabase();

      // Trigger a failure by temporarily adding a check constraint or failure trigger
      db.exec(`
        CREATE TRIGGER fail_on_chat_update
        BEFORE UPDATE ON mesh_chat
        BEGIN
          SELECT RAISE(FAIL, 'simulated mid-migration failure');
        END;
      `);

      expect(() =>
        executeLegacyPrincipalMigration(db, {
          email: "operator@example.com",
          apply: true,
        })
      ).toThrow(/simulated mid-migration failure/);

      // Verify entire transaction was rolled back:
      // 1. No user principal created
      const principals = new PrincipalRepository(db);
      expect(principals.findUserByEmail("operator@example.com")).toBeUndefined();

      // 2. All authoritative references remain human:operator (no partial rewrite)
      const inventory = inventoryLegacyReferences(db);
      expect(inventory.totalAuthoritative).toBe(7);

      const ob1 = db
        .prepare("SELECT owner_id, creator_id FROM obligations WHERE id = 'ob-1'")
        .get() as {
        owner_id: string;
        creator_id: string;
      };
      expect(ob1.owner_id).toBe(HUMAN_OPERATOR);
      expect(ob1.creator_id).toBe(HUMAN_OPERATOR);

      db.close();
    });
  });

  describe("two-user attribution and shared-mesh access", () => {
    it("proves two authenticated users produce distinct attribution while retaining shared-mesh control", () => {
      const db = setupLegacyDatabase();
      const principalRepo = new PrincipalRepository(db);
      const actorRepo = new SqliteActorRepository(db, principalRepo);
      const chatRepo = new MeshChatRepository(db);
      const inboxStore = new SqliteInboxRepository(db);
      const obligationRepo = new ObligationRepository(db);

      const user1 = principalRepo.createUser({
        email: "alice@example.com",
        createdAt: "2026-09-01T00:00:00.000Z",
        identity: {
          issuer: "https://accounts.google.com",
          subject: "sub-alice",
        },
      });
      const user2 = principalRepo.createUser({
        email: "bob@example.com",
        createdAt: "2026-09-01T00:00:00.000Z",
        identity: {
          issuer: "https://accounts.google.com",
          subject: "sub-bob",
        },
      });

      expect(user1.id).not.toBe(user2.id);

      const mesh = new ActorMesh({
        actors: actorRepo,
        principals: principalRepo,
        inboxStore,
        obligations: obligationRepo,
        recordChat: (c) => chatRepo.record(c),
        rootId: ROOT_ID,
        createActor: () => {
          throw new Error("unsupported");
        },
      });
      const root1 = actorRepo.get(ROOT_ID);
      if (!root1) throw new Error("root record missing");
      mesh.adopt(root1, createMockLiveActor(ROOT_ID));

      // User 1 sends human message to root
      const r1 = mesh.sendHumanMessage(ROOT_ID, "Message from Alice", "sess-alice", {
        fromId: user1.id,
      });
      expect(r1.delivered).toBe(true);

      // User 2 sends human message to root
      const r2 = mesh.sendHumanMessage(ROOT_ID, "Message from Bob", "sess-bob", {
        fromId: user2.id,
      });
      expect(r2.delivered).toBe(true);

      // Verify chat records attribute to distinct user principals
      const chats = chatRepo.listForSession("sess-alice", { limit: 50 });
      expect(chats).toHaveLength(1);
      expect(chats[0].senderId).toBe(user1.id);
      expect(chats[0].recipientId).toBe(ROOT_ID);

      const bobChats = chatRepo.listForSession("sess-bob", { limit: 50 });
      expect(bobChats).toHaveLength(1);
      expect(bobChats[0].senderId).toBe(user2.id);
      expect(bobChats[0].recipientId).toBe(ROOT_ID);

      // Verify inbox entries received by root show distinct attribution
      const inboxAlice = inboxStore
        .list(ROOT_ID)
        .entries.find((e) => (e.payload as { fromId?: string })?.fromId === user1.id);
      const inboxBob = inboxStore
        .list(ROOT_ID)
        .entries.find((e) => (e.payload as { fromId?: string })?.fromId === user2.id);
      expect(inboxAlice).toBeDefined();
      expect(inboxBob).toBeDefined();
      expect(inboxAlice?.source).toBe(`mesh:${user1.id}`);
      expect(inboxBob?.source).toBe(`mesh:${user2.id}`);

      // User 1 creates obligation
      const obAlice = obligationRepo.create({
        ownerId: ROOT_ID,
        title: "Alice Task",
        creatorId: user1.id,
      });
      expect(obAlice.creatorId).toBe(user1.id);

      // User 1 mutates obligation
      obligationRepo.reassign(obAlice.id, WORKER_ID, user1.id);

      // User 2 mutates obligation (shared mesh control!)
      const updated = obligationRepo.setTerminalStatus(
        obAlice.id,
        "done",
        "Finished by Bob",
        null,
        user2.id
      );
      expect(updated.status).toBe("done");

      // Verify obligation history reflects distinct attribution (newest first)
      const history = obligationRepo.listHistory(obAlice.id);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].actingPrincipal).toBe(user2.id);
      expect(history[1].actingPrincipal).toBe(user1.id);

      // Both users have operator control: User 1 and User 2 can both interrupt workers
      expect(() => mesh.interrupt(WORKER_ID, user1.id)).not.toThrow();
      expect(() => mesh.interrupt(WORKER_ID, user2.id)).not.toThrow();

      db.close();
    });
  });

  describe("local-mode no-new-alias behavior", () => {
    it("operates normally on a migrated database without minting new human:operator references", () => {
      const db = setupLegacyDatabase();

      // 1. Run migration
      const migration = executeLegacyPrincipalMigration(db, {
        email: "local-operator@example.com",
        apply: true,
      });

      const principalRepo = new PrincipalRepository(db);
      const actorRepo = new SqliteActorRepository(db, principalRepo);
      const chatRepo = new MeshChatRepository(db);
      const inboxStore = new SqliteInboxRepository(db);
      const obligationRepo = new ObligationRepository(db);

      const mesh = new ActorMesh({
        actors: actorRepo,
        principals: principalRepo,
        inboxStore,
        obligations: obligationRepo,
        recordChat: (c) => chatRepo.record(c),
        rootId: ROOT_ID,
        createActor: () => {
          throw new Error("unsupported");
        },
      });
      const root2 = actorRepo.get(ROOT_ID);
      if (!root2) throw new Error("root record missing");
      mesh.adopt(root2, createMockLiveActor(ROOT_ID));

      // In local mode, findFirstUser() resolves the migrated operator principal
      const localOperator = principalRepo.findFirstUser();
      expect(localOperator).toBeDefined();
      if (!localOperator) throw new Error("Expected local operator to be defined");
      expect(localOperator.id).toBe(migration.principalId);

      // Local operator sends a message
      const res = mesh.sendHumanMessage(ROOT_ID, "Hello from local console", "local-session", {
        fromId: localOperator.id,
      });
      expect(res.delivered).toBe(true);

      // Local operator creates an obligation
      const ob = obligationRepo.create({
        ownerId: ROOT_ID,
        title: "Local Operator Task",
        creatorId: localOperator.id,
      });
      expect(ob.creatorId).toBe(migration.principalId);

      // Local operator updates status
      obligationRepo.setTerminalStatus(ob.id, "done", "Done locally", null, localOperator.id);

      // Verify NO new human:operator references were minted anywhere
      const inventory = inventoryLegacyReferences(db);
      expect(inventory.totalAuthoritative).toBe(0);

      // Verify chat was attributed to the durable principal
      const chats = chatRepo.listForSession("local-session", { limit: 50 });
      expect(chats).toHaveLength(1);
      expect(chats[0].senderId).toBe(migration.principalId);

      db.close();
    });
  });

  describe("backupDatabase and generateMigrationReport", () => {
    it("creates a valid backup copy and generates a complete Markdown report", async () => {
      const dbFile = join(tempDir, "mesh.db");
      const db = setupLegacyDatabase(dbFile);

      const backupDir = join(tempDir, "backups");
      const backupPath = await backupDatabase(dbFile, backupDir);
      expect(backupPath).toContain("mesh-backup-");

      // Verify backup is a valid SQLite database
      const backupDb = new Database(backupPath);
      const tables = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables.length).toBeGreaterThan(0);
      backupDb.close();

      const result = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });
      db.close();

      const report = generateMigrationReport(result, dbFile);
      expect(report).toContain("# Legacy Principal Migration Report");
      expect(report).toContain("operator@example.com");
      expect(report).toContain(result.principalId);
      expect(report).toContain("APPLIED");
      expect(report).toContain("Authoritative References Inventory");
      expect(report).toContain("Untouched Reference Sites");
      expect(report).toContain("Dynamic Schema Sweep");
    });

    it("creates a verified SQLite online backup under WAL mode and checks integrity", async () => {
      const dbFile = join(tempDir, "wal-mesh.db");
      const db = setupLegacyDatabase(dbFile);
      db.pragma("journal_mode = WAL");

      // Write uncheckpointed row into WAL
      db.prepare(
        `INSERT INTO obligations (id, owner_id, creator_id, title, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "wal-ob-1",
        HUMAN_OPERATOR,
        HUMAN_OPERATOR,
        "WAL obligation",
        "2026-09-01T03:00:00.000Z",
        "2026-09-01T03:00:00.000Z",
        "ready"
      );

      const backupDir = join(tempDir, "wal-backups");
      const backupPath = await backupDatabase(db, backupDir);

      const backupDb = new Database(backupPath, { readonly: true });
      const rows = backupDb
        .prepare("SELECT * FROM obligations WHERE id = ?")
        .all("wal-ob-1") as Array<unknown>;
      expect(rows).toHaveLength(1);
      const integrity = backupDb.pragma("integrity_check") as Array<{ integrity_check: string }>;
      expect(integrity[0].integrity_check).toBe("ok");
      backupDb.close();
      db.close();
    });

    it("dynamically detects unclassified legacy references via schema sweep and rolls back atomically", () => {
      const db = setupLegacyDatabase();
      // Add an unclassified table containing human:operator
      db.exec("CREATE TABLE unclassified_custom (id TEXT PRIMARY KEY, operator_ref TEXT)");
      db.prepare("INSERT INTO unclassified_custom VALUES (?, ?)").run("custom-1", HUMAN_OPERATOR);

      const inventory = inventoryLegacyReferences(db);
      expect(inventory.totalDangling).toBe(1);
      expect(inventory.dangling).toContainEqual({
        table: "unclassified_custom",
        column: "operator_ref",
        count: 1,
      });

      // Applying migration fails and rolls back because dangling legacy references remain
      expect(() =>
        executeLegacyPrincipalMigration(db, {
          email: "operator@example.com",
          apply: true,
        })
      ).toThrow(/unclassified legacy references detected/);

      // Verify rollback occurred cleanly
      const postInventory = inventoryLegacyReferences(db);
      expect(postInventory.totalAuthoritative).toBe(inventory.totalAuthoritative);
      db.close();
    });

    it("verifies actor reply targets authenticated durable principal and avoids minting human:operator", async () => {
      const db = setupLegacyDatabase();
      const principalRepo = new PrincipalRepository(db);
      const actorRepo = new SqliteActorRepository(db, principalRepo);
      const chatRepo = new MeshChatRepository(db);

      const migration = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });

      const mesh = new ActorMesh({
        actors: actorRepo,
        principals: principalRepo,
        recordChat: (c) => chatRepo.record(c),
        rootId: ROOT_ID,
        createActor: () => {
          throw new Error("unsupported");
        },
      });
      const worker = actorRepo.get(WORKER_ID);
      if (!worker) throw new Error("worker record missing");
      mesh.adopt(worker, createMockLiveActor(WORKER_ID));

      // Authenticated message arrives with fromId = durable principal ID
      mesh.sendHumanMessage(WORKER_ID, "Ping worker", "sess-123", {
        fromId: migration.principalId,
      });

      // The updated actor record has lastChatPrincipalId set to the user principal
      const updatedWorker = actorRepo.get(WORKER_ID);
      expect(updatedWorker?.lastChatPrincipalId).toBe(migration.principalId);

      // Actor replies back in conversation
      mesh.recordMessageEmitted({
        fromId: WORKER_ID,
        toId: updatedWorker?.lastChatPrincipalId ?? HUMAN_OPERATOR,
        body: "Acknowledged ping",
        sessionId: "sess-123",
        isDrop: false,
      });

      // Check the emitted chat row: recipient_id must be the durable principal, NOT human:operator
      const chats = chatRepo.listForSession("sess-123", { limit: 10 });
      expect(chats).toHaveLength(2);
      const workerReply = chats.find((c) => c.senderId === WORKER_ID);
      expect(workerReply).toBeDefined();
      expect(workerReply?.recipientId).toBe(migration.principalId);

      // Assert that 0 authoritative human:operator references exist anywhere
      const sweep = inventoryLegacyReferences(db);
      expect(sweep.totalAuthoritative).toBe(0);
      expect(sweep.totalDangling).toBe(0);
      db.close();
    });

    it("rehearses full dry-run, apply with WAL online backup, and idempotent rerun on representative database", async () => {
      const dbFile = join(tempDir, "representative-mesh.db");
      const db = setupLegacyDatabase(dbFile);
      db.pragma("journal_mode = WAL");

      // Seed representative data across all relevant tables through the repository
      const repo = new ObligationRepository(db);
      for (let i = 10; i < 20; i++) {
        repo.create({
          id: `rep-ob-${i}`,
          ownerId: i % 2 === 0 ? HUMAN_OPERATOR : ROOT_ID,
          creatorId: HUMAN_OPERATOR,
          title: `Representative task ${i}`,
          intent: `Intent for task ${i} with human:operator mention`,
        });
      }

      // Verify derived state is exercised
      expect(repo.readyHeads().get(HUMAN_OPERATOR)).toBe("ob-1");

      const histInsert = db.prepare(
        `INSERT INTO obligation_history (id, obligation_id, timestamp, mutation_kind, acting_principal, payload)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (let i = 10; i < 25; i++) {
        histInsert.run(
          i,
          `rep-ob-${10 + (i % 10)}`,
          "2026-09-02T00:01:00.000Z",
          "update",
          HUMAN_OPERATOR,
          JSON.stringify({ note: `updated by human:operator ${i}` })
        );
      }

      const chatInsert = db.prepare(
        `INSERT INTO mesh_chat (sender_id, recipient_id, body, session_id, ts)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (let i = 10; i < 25; i++) {
        chatInsert.run(
          i % 2 === 0 ? HUMAN_OPERATOR : WORKER_ID,
          i % 2 === 0 ? WORKER_ID : HUMAN_OPERATOR,
          `Message body ${i} referencing human:operator`,
          `rep-session-${i % 3}`,
          1700000000000 + i
        );
      }

      // 1. Dry run
      const dryRunResult = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: false,
      });
      expect(dryRunResult.applied).toBe(false);
      expect(dryRunResult.preInventory.totalAuthoritative).toBeGreaterThan(0);
      expect(dryRunResult.preInventory.totalUntouched).toBeGreaterThan(0);
      expect(dryRunResult.preInventory.totalDangling).toBe(0);

      // Verify no mutation occurred during dry run
      const drySweep = inventoryLegacyReferences(db);
      expect(drySweep.totalAuthoritative).toBe(dryRunResult.preInventory.totalAuthoritative);

      // 2. Apply with backup
      const backupDir = join(tempDir, "rep-backups");
      const backupPath = await backupDatabase(db, backupDir);
      expect(backupPath).toContain("mesh-backup-");

      const applyResult = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });
      expect(applyResult.applied).toBe(true);
      expect(applyResult.rewritesApplied).toBe(dryRunResult.preInventory.totalAuthoritative);
      expect(applyResult.postInventory?.totalAuthoritative).toBe(0);
      expect(applyResult.postInventory?.totalDangling).toBe(0);

      // Derived ready heads reflect cutover to the durable principal
      expect(repo.readyHeads().get(applyResult.principalId)).toBe("ob-1");
      expect(repo.readyHeads().has(HUMAN_OPERATOR)).toBe(false);

      // 3. Idempotent rerun
      const rerunResult = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });
      expect(rerunResult.applied).toBe(true);
      expect(rerunResult.principalReused).toBe(true);
      expect(rerunResult.principalCreated).toBe(false);
      expect(rerunResult.rewritesApplied).toBe(0);
      expect(rerunResult.postInventory?.totalAuthoritative).toBe(0);

      db.close();
    });

    it("proves a production-shaped rehearsal: 0049 schema with a legacy ready-head row upgrades via 0050, then the principal migration reaches zero unclassified references", async () => {
      const dbFile = join(tempDir, "production-shaped-rehearsal.db");
      const db = new Database(dbFile);
      db.pragma("foreign_keys = ON");

      // 1. Build the schema exactly as a pre-0050 production instance has it:
      // migration 0025 created obligation_ready_heads and it still exists at 0049.
      runMigrations(db, { throughId: "0049_obligation_responsive" });
      const legacyTableAt0049 = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obligation_ready_heads'"
        )
        .get();
      expect(legacyTableAt0049).toBeDefined();

      // 2. Seed the exact production failure shape from #513: a ready
      // obligation owned by the legacy alias plus its ready-head cache row
      // keyed by owner_id, and a standing root obligation.
      db.prepare(
        `INSERT INTO obligations (id, owner_id, creator_id, title, intent, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "prod-ob-1",
        HUMAN_OPERATOR,
        HUMAN_OPERATOR,
        "Migrate legacy principal in production",
        "Zero unclassified references",
        "2026-09-01T02:00:00.000Z",
        "2026-09-01T02:00:00.000Z",
        "ready"
      );
      db.prepare(
        `INSERT INTO obligations (id, owner_id, creator_id, title, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "prod-ob-2",
        ROOT_ID,
        HUMAN_OPERATOR,
        "Root ongoing task",
        "2026-09-01T02:05:00.000Z",
        "2026-09-01T02:05:00.000Z",
        "ready"
      );
      db.prepare(
        `INSERT INTO obligation_ready_heads (owner_id, head_id, previous_head_id, sequence, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(HUMAN_OPERATOR, "prod-ob-1", null, 1, "2026-09-01T02:00:00.000Z");

      // Before the schema upgrade, the seeded row is the dangling reference
      // that aborted every apply rehearsal in #513, and it still does.
      const preUpgradeInventory = inventoryLegacyReferences(db);
      expect(preUpgradeInventory.dangling).toContainEqual({
        table: "obligation_ready_heads",
        column: "owner_id",
        count: 1,
      });
      expect(() =>
        executeLegacyPrincipalMigration(db, {
          email: "operator@example.com",
          apply: true,
        })
      ).toThrow(/unclassified legacy references detected/);
      // The aborted apply rolls back, leaving the legacy row untouched.
      const rolledBack = db
        .prepare("SELECT owner_id FROM obligation_ready_heads WHERE owner_id = ?")
        .get(HUMAN_OPERATOR);
      expect(rolledBack).toBeDefined();

      // 3. The production upgrade path: forward schema migration 0050 runs
      // first and drops the recomputable cache table, legacy row included.
      runMigrations(db);
      const tableAfter0050 = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obligation_ready_heads'"
        )
        .get();
      expect(tableAfter0050).toBeUndefined();

      // 4. Derived ready heads still reflect the obligations rows on the fly.
      const repo = new ObligationRepository(db);
      expect(repo.readyHeads().get(HUMAN_OPERATOR)).toBe("prod-ob-1");
      expect(repo.readyHeads().get(ROOT_ID)).toBe("prod-ob-2");

      // 5. Dry run and apply now both report zero dangling references.
      const dryRunResult = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: false,
      });
      expect(dryRunResult.applied).toBe(false);
      expect(dryRunResult.preInventory.totalDangling).toBe(0);
      expect(dryRunResult.preInventory.dangling).toEqual([]);

      const applyResult = executeLegacyPrincipalMigration(db, {
        email: "operator@example.com",
        apply: true,
      });
      expect(applyResult.applied).toBe(true);
      expect(applyResult.postInventory?.totalAuthoritative).toBe(0);
      expect(applyResult.postInventory?.totalDangling).toBe(0);
      expect(applyResult.postInventory?.dangling).toEqual([]);

      // Derived heads are now attributed to the durable principal
      expect(repo.readyHeads().get(applyResult.principalId)).toBe("prod-ob-1");
      expect(repo.readyHeads().has(HUMAN_OPERATOR)).toBe(false);

      db.close();
    });
  });
});
