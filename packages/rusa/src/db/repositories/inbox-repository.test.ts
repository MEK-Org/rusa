import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Actor } from "../../actor/actor.js";
import { ActorMesh } from "../../actor/actor-mesh.js";
import { FakeProvider } from "../../providers/fake-provider.js";
import { InMemoryActorRepository } from "../../repositories/in-memory-actor-repository.js";
import { actorInbox } from "../migrations/0003_actor_inbox.js";
import { actorInboxSeen } from "../migrations/0012_actor_inbox_seen.js";
import { actorInboxHandledNote } from "../migrations/0015_actor_inbox_handled_note.js";
import { InboxRepository } from "./inbox-repository.js";

describe("InboxRepository", () => {
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
  let store: InboxRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    actorInbox.up(db);
    actorInboxSeen.up(db);
    actorInboxHandledNote.up(db);
    store = new InboxRepository(db, () => new Date("2026-07-13T12:00:00.000Z"));
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
      provider: new FakeProvider(),
      mcpServers: [],
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "Read inbox" }),
      onQueued: (context) => {
        mesh.actorQueued("actor", context);
        mesh.recordEvent({ kind: "run_queued", actorId: "actor" });
      },
      onRunEnd: () => mesh.recordEvent({ kind: "run_end", actorId: "actor", success: true }),
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
