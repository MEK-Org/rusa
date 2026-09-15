import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Actor } from "../../actor/actor.js";
import { ActorMesh } from "../../actor/actor-mesh.js";
import { FakeProvider } from "../../providers/fake-provider.js";
import { InMemoryActorRepository } from "../../repositories/in-memory-actor-repository.js";
import type { InboxEntry } from "../../repositories/inbox-repository.js";
import { actorInbox } from "../migrations/0003_actor_inbox.js";
import { actorInboxSeen } from "../migrations/0012_actor_inbox_seen.js";
import { actorInboxHandledNote } from "../migrations/0015_actor_inbox_handled_note.js";
import { Repositories } from "./index.js";
import { SqliteInboxRepository } from "./sqlite-inbox-repository.js";

describe("SqliteInboxRepository", () => {
  it("treats an already-persisted deterministic id as an idempotent no-op", () => {
    const first = store.append([
      {
        id: "github-delivery:actor-a",
        actorId: "actor-a",
        source: "github_issue:dummy-org/dummy-repoISSUE_NUM",
        payload: { type: "issue_comment.created", commentId: 1 },
      },
    ]);
    const retry = store.append([
      {
        id: "github-delivery:actor-a",
        actorId: "actor-a",
        source: "github_issue:dummy-org/dummy-repoISSUE_NUM",
        payload: { type: "issue_comment.created", commentId: 1 },
      },
    ]);

    expect(first).toHaveLength(1);
    expect(retry).toEqual([]);
    expect(store.list("actor-a").entries).toHaveLength(1);
  });

  let db: Database.Database;
  let store: SqliteInboxRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    actorInbox.up(db);
    actorInboxSeen.up(db);
    actorInboxHandledNote.up(db);
    store = new SqliteInboxRepository(db, () => new Date("2026-07-13T12:00:00.000Z"));
  });

  it("appends atomically and lists actor-bound entries newest first with opaque pagination", () => {
    store.append([
      {
        id: "a",
        actorId: "actor-a",
        source: "github_issue:dummy-org/dummy-repoISSUE_NUM",
        deliveredAt: new Date("2026-07-13T11:00:00Z"),
        payload: { type: "issue_comment.created", commentId: 1 },
      },
      {
        id: "b",
        actorId: "actor-a",
        source: "github_issue:dummy-org/dummy-repoISSUE_NUM",
        deliveredAt: new Date("2026-07-13T12:00:00Z"),
        payload: { type: "issue_comment.created", commentId: 2 },
      },
      {
        id: "foreign",
        actorId: "actor-b",
        source: "github_pr:dummy-org/dummy-repoISSUE_NUM",
        payload: { type: "pull_request.synchronize" },
      },
    ]);

    const first = store.list("actor-a", { limit: 1 });
    expect(first.entries.map((entry) => entry.id)).toEqual(["b"]);
    expect(first.unhandledCount).toBe(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = store.list("actor-a", { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.entries.map((entry) => entry.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
    expect(store.read("actor-a", "foreign")).toBeNull();
  });

  it("selects the exact queued-card item responsive first, then earliest, without page truncation", () => {
    store.append([
      {
        id: "normal-oldest",
        actorId: "actor-a",
        source: "chat",
        deliveredAt: new Date("2026-07-01T00:00:00Z"),
        payload: { type: "message" },
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `newer-${index}`,
        actorId: "actor-a",
        source: "chat",
        deliveredAt: new Date(`2026-07-02T${String(index % 24).padStart(2, "0")}:00:00Z`),
        payload: { type: "message" },
      })),
      {
        id: "responsive-late",
        actorId: "actor-a",
        source: "chat",
        deliveredAt: new Date("2026-07-03T00:00:00Z"),
        payload: { type: "message", priority: "responsive" },
      },
      {
        id: "responsive-earlier",
        actorId: "actor-a",
        source: "chat",
        deliveredAt: new Date("2026-07-02T00:00:00Z"),
        payload: { type: "message", priority: "responsive" },
      },
    ]);

    expect(store.selectPrioritizedUnhandled("actor-a")?.id).toBe("responsive-earlier");
    store.markHandled("actor-a", ["responsive-earlier"]);
    expect(store.selectPrioritizedUnhandled("actor-a")?.id).toBe("responsive-late");
    store.markHandled("actor-a", ["responsive-late"]);
    expect(store.selectPrioritizedUnhandled("actor-a")?.id).toBe("normal-oldest");
  });

  it("rolls back an append batch when any payload is invalid", () => {
    expect(() =>
      store.append([
        { id: "good", actorId: "a", source: "chat", payload: { type: "message.created" } },
        // Runtime validation protects callers outside TypeScript.
        { id: "bad", actorId: "a", source: "chat", payload: {} as never },
      ])
    ).toThrow(/payload\.type/);
    expect(store.countUnhandled("a")).toBe(0);
  });

  it("markHandled is owner-checked, all-or-nothing, and preserves the first timestamp", () => {
    store.append([
      { id: "a1", actorId: "a", source: "chat", payload: { type: "message.created" } },
      { id: "a2", actorId: "a", source: "chat", payload: { type: "message.created" } },
      { id: "b1", actorId: "b", source: "chat", payload: { type: "message.created" } },
    ]);
    expect(() => store.markHandled("a", ["a1", "b1"])).toThrow("inbox entry not found");
    expect(store.countUnhandled("a")).toBe(2);

    const firstAt = new Date("2026-07-13T13:00:00Z");
    expect(store.markHandled("a", ["a1", "a2"], firstAt)).toEqual([
      { id: "a1", handledAt: firstAt, alreadyHandled: false },
      { id: "a2", handledAt: firstAt, alreadyHandled: false },
    ]);
    const repeated = store.markHandled("a", ["a1"], new Date("2026-07-13T14:00:00Z"));
    expect(repeated).toEqual([{ id: "a1", handledAt: firstAt, alreadyHandled: true }]);
  });

  it("persists the optional addressed note with the first handled stamp", () => {
    store.append([
      { id: "note", actorId: "a", source: "chat", payload: { type: "message.created" } },
    ]);
    store.markHandled("a", ["note"], undefined, "  Follow-up sent to the operator.  ");

    expect(store.read("a", "note")?.handledNote).toBe("Follow-up sent to the operator.");
    store.markHandled("a", ["note"], undefined, "A later note must not overwrite it.");
    expect(store.read("a", "note")?.handledNote).toBe("Follow-up sent to the operator.");
  });

  it("atomically marks only unhandled unseen entries and preserves the first seen_at", () => {
    store.append([
      { id: "a1", actorId: "a", source: "chat", payload: { type: "message.created" } },
      { id: "a2", actorId: "a", source: "chat", payload: { type: "message.created" } },
      { id: "b1", actorId: "b", source: "chat", payload: { type: "message.created" } },
    ]);
    store.markHandled("a", ["a2"]);
    expect(store.actorsWithUnseen()).toEqual([
      { actorId: "a", priority: "normal" },
      { actorId: "b", priority: "normal" },
    ]);

    const firstAt = new Date("2026-07-13T13:00:00Z");
    expect(store.markSeen("a", firstAt)).toMatchObject([
      { id: "a1", actorId: "a", seenAt: firstAt, handledAt: null },
    ]);
    expect(store.markSeen("a", new Date("2026-07-13T14:00:00Z"))).toEqual([]);
    expect(store.read("a", "a1")?.seenAt).toEqual(firstAt);
    expect(store.read("a", "a2")?.seenAt).toBeNull();
    expect(store.read("b", "b1")?.seenAt).toBeNull();
    expect(store.actorsWithUnseen()).toEqual([{ actorId: "b", priority: "normal" }]);
  });

  it("promotes recovery priority when any qualifying entry is responsive", () => {
    store.append([
      { id: "a-normal", actorId: "a", source: "chat", payload: { type: "normal" } },
      {
        id: "a-responsive",
        actorId: "a",
        source: "chat",
        payload: { type: "responsive", priority: "responsive" },
      },
      { id: "b-normal", actorId: "b", source: "chat", payload: { type: "normal" } },
    ]);

    expect(store.actorsWithUnhandled()).toEqual([
      { actorId: "a", priority: "responsive" },
      { actorId: "b", priority: "normal" },
    ]);
    expect(store.actorsWithUnseen()).toEqual([
      { actorId: "a", priority: "responsive" },
      { actorId: "b", priority: "normal" },
    ]);

    store.markHandled("a", ["a-responsive"]);
    expect(store.actorsWithUnhandled()).toContainEqual({ actorId: "a", priority: "normal" });
  });

  describe("onItemsAppended", () => {
    const entry = (id: string, actorId = "actor-a") => ({
      id,
      actorId,
      source: "chat",
      payload: { type: "message.created" },
    });

    it("notifies every subscriber with exactly the committed rows, after commit", () => {
      const seen: Array<{ items: readonly InboxEntry[]; persisted: number }> = [];
      const first = vi.fn((items: readonly InboxEntry[]) => {
        // The listener reads durable state: the rows it was told about are
        // already visible, so an immediate turnaround read cannot miss them.
        seen.push({ items, persisted: store.countUnhandled("actor-a") });
      });
      const second = vi.fn();
      store.onItemsAppended(first);
      store.onItemsAppended(second);

      // The duplicate id is a no-op insert and must not be announced.
      store.append([entry("dup")]);
      first.mockClear();
      second.mockClear();
      seen.length = 0;

      const inserted = store.append([entry("dup"), entry("x"), entry("y")]);

      expect(inserted.map((row) => row.id)).toEqual(["x", "y"]);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ items: inserted, persisted: 3 }]);
      expect(second).toHaveBeenCalledWith(inserted);
      expect(store.list("actor-a", { status: "all" }).entries.map((row) => row.id)).toEqual([
        "y",
        "x",
        "dup",
      ]);
    });

    it("emits nothing when the batch is empty or every row was already present", () => {
      const listener = vi.fn();
      store.onItemsAppended(listener);
      store.append([entry("known")]);
      listener.mockClear();

      expect(store.append([])).toEqual([]);
      expect(store.append([entry("known")])).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
    });

    it("emits nothing when validation rejects the batch before any write", () => {
      const listener = vi.fn();
      store.onItemsAppended(listener);

      expect(() =>
        store.append([entry("good"), { ...entry("bad"), payload: {} as never }])
      ).toThrow(/payload\.type/);
      expect(listener).not.toHaveBeenCalled();
      expect(store.countUnhandled("actor-a")).toBe(0);
    });

    it("emits nothing when the write transaction itself rolls back", () => {
      // A test-only trigger makes the second row fail mid-transaction so the
      // whole batch, including the already-inserted first row, is rolled back.
      db.exec(
        `CREATE TRIGGER reject_poison BEFORE INSERT ON actor_inbox_entries
         WHEN NEW.source = 'poison' BEGIN SELECT RAISE(ABORT, 'poison row'); END`
      );
      const listener = vi.fn();
      store.onItemsAppended(listener);

      expect(() => store.append([entry("good"), { ...entry("bad"), source: "poison" }])).toThrow(
        /poison row/
      );
      expect(listener).not.toHaveBeenCalled();
      expect(store.list("actor-a", { status: "all" }).entries).toEqual([]);
      expect(store.actorsWithUnhandled()).toEqual([]);
    });

    it("refuses to append inside an enclosing transaction rather than defer notice to boot", () => {
      // Nested in an outer transaction the write would be only a savepoint,
      // so the after-commit notification could never be honest, and the only
      // reconciliation of a silently deferred row is the next boot/resume
      // sweep. Fail loudly before any write instead.
      const listener = vi.fn();
      store.onItemsAppended(listener);

      expect(() =>
        db.transaction(() => {
          store.append([entry("nested")]);
        })()
      ).toThrow(/enclosing transaction/);
      expect(listener).not.toHaveBeenCalled();
      expect(store.list("actor-a", { status: "all" }).entries).toEqual([]);
      expect(store.actorsWithUnhandled()).toEqual([]);
      expect(db.inTransaction).toBe(false);
    });

    it("stops notifying an unsubscribed listener while others keep receiving", () => {
      const stays = vi.fn();
      const leaves = vi.fn();
      const unsubscribe = store.onItemsAppended(leaves);
      store.onItemsAppended(stays);

      store.append([entry("one")]);
      unsubscribe();
      unsubscribe();
      store.append([entry("two")]);

      expect(leaves).toHaveBeenCalledTimes(1);
      expect(stays).toHaveBeenCalledTimes(2);
    });

    it("contains a throwing subscriber: the write stands and later subscribers still run", () => {
      const errors: unknown[] = [];
      store.setListenerErrorHandler((error) => errors.push(error));
      const after = vi.fn();
      store.onItemsAppended(() => {
        throw new Error("listener boom");
      });
      store.onItemsAppended(after);

      const inserted = store.append([entry("kept")]);

      expect(inserted.map((row) => row.id)).toEqual(["kept"]);
      expect(after).toHaveBeenCalledWith(inserted);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("listener boom");
      expect(store.read("actor-a", "kept")?.handledAt).toBeNull();
      expect(store.actorsWithUnhandled()).toEqual([{ actorId: "actor-a", priority: "normal" }]);
    });

    it("reaches the journal the composition root wires, not only a test hook", () => {
      // Repositories owns the concrete instance and exposes exactly this seam,
      // which runStart points at the application logger; a listener failure is
      // therefore recorded in the running service, not silently dropped.
      const repositories = new Repositories(db);
      const journaled: unknown[] = [];
      repositories.setInboxListenerErrorHandler((error) => journaled.push(error));
      repositories.inbox.onItemsAppended(() => {
        throw new Error("listener boom");
      });

      const inserted = repositories.inbox.append([entry("kept-by-container")]);

      expect(inserted.map((row) => row.id)).toEqual(["kept-by-container"]);
      expect(journaled).toHaveLength(1);
      expect((journaled[0] as Error).message).toBe("listener boom");
    });

    it("recovers through actorsWithUnhandled() when no notification was delivered", () => {
      // Rows written before any listener existed, or whose callback was
      // dropped, are still found by the durable boot reconciliation query.
      store.append([entry("before-subscribe")]);
      const dropped = vi.fn(() => {
        throw new Error("dropped");
      });
      store.onItemsAppended(dropped);
      store.append([entry("dropped-callback", "actor-b")]);
      expect(dropped).toHaveBeenCalledTimes(1);

      const reopened = new SqliteInboxRepository(db);
      expect(reopened.actorsWithUnhandled()).toEqual([
        { actorId: "actor-a", priority: "normal" },
        { actorId: "actor-b", priority: "normal" },
      ]);
      expect(reopened.list("actor-a").entries.map((row) => row.id)).toEqual(["before-subscribe"]);
      expect(reopened.list("actor-b").entries.map((row) => row.id)).toEqual(["dropped-callback"]);
    });
  });

  it("handled_at changes only through actor mark_handled", async () => {
    vi.useFakeTimers();
    store.append([
      { id: "entry", actorId: "actor", source: "chat", payload: { type: "message.created" } },
    ]);

    // Delivery, list, and read are mechanically observed but do not acknowledge.
    store.list("actor");
    store.read("actor", "entry");
    store.countUnhandled("actor");
    store.actorsWithUnhandled();
    store.list("actor", { status: "all" });

    // Exercise run start/end, yield, boot recovery, and retire/retention wiring.
    const registry = new InMemoryActorRepository();
    const mesh = new ActorMesh({
      actors: registry,
      inboxStore: store,
      createActor: () => {
        throw new Error("not used");
      },
    });
    const actor = new Actor({
      id: "actor",
      cwd: "/tmp/actor-inbox-invariant",
      modelConfig: [{ provider: "fake" }],
      resolveProvider: () => new FakeProvider(),
      mcpServers: [],
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "Read inbox" }),
      lifecycle: mesh.lifecycleFor("actor"),
      debounceMs: 1,
    });
    mesh.adopt(
      {
        id: "actor",
        charter: "test invariant",
        parentId: null,
        status: "active",
        createdAt: "2026-07-13T12:00:00Z",
      },
      actor
    );
    mesh.reconcileInbox();
    await vi.advanceTimersByTimeAsync(2);
    mesh.declareYield("actor", "complete");
    mesh.retire("actor");
    expect(
      (
        db.prepare("SELECT handled_at FROM actor_inbox_entries WHERE id = 'entry'").get() as {
          handled_at: string | null;
        }
      ).handled_at
    ).toBeNull();

    store.markHandled("actor", ["entry"]);
    expect(
      (
        db.prepare("SELECT handled_at FROM actor_inbox_entries WHERE id = 'entry'").get() as {
          handled_at: string | null;
        }
      ).handled_at
    ).toBe("2026-07-13T12:00:00.000Z");
    vi.useRealTimers();
  });
});
