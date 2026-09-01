import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { MeshEventRepository } from "./mesh-event-repository.js";

describe("MeshEventRepository", () => {
  let db: Database.Database;
  let repo: MeshEventRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repo = new MeshEventRepository(db);
  });

  it("records an event and reads it back as a rich object", () => {
    repo.record({
      kind: "message_sent",
      actorId: "worker-1",
      body: "please review PR #5",
      ts: "2026-06-21T00:00:00.000Z",
    });

    const events = repo.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "message_sent",
      actorId: "worker-1",
      body: "please review PR #5",
      ts: "2026-06-21T00:00:00.000Z",
      success: null,
    });
    expect(typeof events[0].id).toBe("string");
  });

  it("preserves insertion order regardless of timestamp", () => {
    // Out-of-order stamps; rowid ordering should still reflect insertion order.
    repo.record({ kind: "run_start", actorId: "a", ts: "2026-06-21T00:00:05.000Z" });
    repo.record({ kind: "run_end", actorId: "a", success: true, ts: "2026-06-21T00:00:01.000Z" });

    const kinds = repo.list().map((e) => e.kind);
    expect(kinds).toEqual(["run_start", "run_end"]);
  });

  it("maps boolean success to/from integer storage", () => {
    repo.record({ kind: "run_end", actorId: "a", success: false });
    expect(repo.list()[0].success).toBe(false);
  });

  it("tail-truncates oversized bodies but keeps the end", () => {
    const big = `${"x".repeat(60_000)}THE_TAIL`;
    repo.record({ kind: "run_end", actorId: "a", body: big });

    const stored = repo.list()[0].body ?? "";
    expect(stored.length).toBeLessThan(big.length);
    expect(stored.endsWith("THE_TAIL")).toBe(true);
    expect(stored).toContain("truncated");
  });

  describe("listEventsByActors", () => {
    it("conversation filter excludes self-sends and keeps only the A↔B pair ", () => {
      const a = "actor-a";
      const b = "actor-b";

      function insertChatWithEvents(id: string, sender: string, recipient: string, body: string) {
        db.prepare(
          `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
           VALUES (?, '2026-07-19T00:00:00.000Z', ?, ?, ?, NULL)`
        ).run(id, sender, recipient, body);
        // message_sent from the sender's perspective
        repo.record({
          kind: "message_sent",
          actorId: sender,
          payload: JSON.stringify({ messageId: id, to: recipient }),
          detail: `${sender} → ${recipient}`,
        });
        // message_received from the recipient's perspective
        repo.record({
          kind: "message_received",
          actorId: recipient,
          payload: JSON.stringify({ messageId: id, from: sender }),
          detail: `${sender} → ${recipient}`,
        });
      }

      // Real A↔B exchange.
      insertChatWithEvents("m-ab", a, b, "A to B");
      insertChatWithEvents("m-ba", b, a, "B to A");

      // Self-send that leaked into the A↔B conversation before the fix .
      insertChatWithEvents("m-aa", a, a, "A to A");

      const page = repo.listEventsByActors([a, b], {
        limit: 50,
        kinds: ["message_sent"],
        conversation: true,
      });

      const bodies = page.events.map((e) => e.body);
      expect(bodies).toEqual(["B to A", "A to B"]);
      expect(bodies).not.toContain("A to A");
    });

    it("returns events for the given actors newest-first", () => {
      repo.record({ kind: "run_start", actorId: "a", detail: "1" });
      repo.record({ kind: "run_start", actorId: "b", detail: "2" });
      repo.record({ kind: "run_end", actorId: "a", success: true, detail: "3" });

      const page = repo.listEventsByActors(["a"], { limit: 50 });
      expect(page.events.map((e) => e.detail)).toEqual(["3", "1"]);
      expect(page.nextCursor).toBeNull();
    });

    it("merges multiple actors into one chronological stream", () => {
      repo.record({ kind: "run_start", actorId: "a", detail: "1" });
      repo.record({ kind: "run_start", actorId: "b", detail: "2" });
      repo.record({ kind: "run_start", actorId: "c", detail: "3" });

      const page = repo.listEventsByActors(["a", "c"], { limit: 50 });
      expect(page.events.map((e) => e.detail)).toEqual(["3", "1"]);
    });

    it("paginates backward via nextCursor without gaps or repeats", () => {
      for (let i = 0; i < 5; i++)
        repo.record({ kind: "run_start", actorId: "a", detail: String(i) });

      const first = repo.listEventsByActors(["a"], { limit: 2 });
      expect(first.events.map((e) => e.detail)).toEqual(["4", "3"]);
      expect(first.nextCursor).not.toBeNull();

      const second = repo.listEventsByActors(["a"], { limit: 2, before: first.nextCursor });
      expect(second.events.map((e) => e.detail)).toEqual(["2", "1"]);

      const third = repo.listEventsByActors(["a"], { limit: 2, before: second.nextCursor });
      expect(third.events.map((e) => e.detail)).toEqual(["0"]);
      expect(third.nextCursor).toBeNull();
    });

    it("filters by kind when requested", () => {
      repo.record({ kind: "run_start", actorId: "a", detail: "s" });
      repo.record({ kind: "message_sent", actorId: "a", detail: "m" });

      const page = repo.listEventsByActors(["a"], { limit: 50, kinds: ["message_sent"] });
      expect(page.events.map((e) => e.kind)).toEqual(["message_sent"]);
    });

    it("returns an empty page for no actors", () => {
      repo.record({ kind: "run_start", actorId: "a" });
      expect(repo.listEventsByActors([], { limit: 50 })).toEqual({ events: [], nextCursor: null });
    });
  });

  describe("listEventsSince (distiller forward read)", () => {
    it("returns all-actors events with ts >= since, oldest-first", () => {
      repo.record({
        kind: "run_start",
        actorId: "a",
        detail: "old",
        ts: "2026-06-16T00:00:00.000Z",
      });
      repo.record({
        kind: "run_start",
        actorId: "b",
        detail: "edge",
        ts: "2026-06-17T00:00:00.000Z",
      });
      repo.record({
        kind: "run_start",
        actorId: "c",
        detail: "new",
        ts: "2026-06-18T00:00:00.000Z",
      });

      const { events, hasMore } = repo.listEventsSince("2026-06-17T00:00:00.000Z", 50);
      expect(events.map((e) => e.detail)).toEqual(["edge", "new"]); // since is inclusive, oldest-first, all actors
      expect(hasMore).toBe(false);
    });

    it("caps at limit and flags hasMore (keeping the oldest)", () => {
      for (let i = 0; i < 3; i++)
        repo.record({
          kind: "run_start",
          actorId: "a",
          detail: String(i),
          ts: `2026-06-18T00:00:0${i}.000Z`,
        });
      const { events, hasMore } = repo.listEventsSince("2026-06-18T00:00:00.000Z", 2);
      expect(events.map((e) => e.detail)).toEqual(["0", "1"]);
      expect(hasMore).toBe(true);
    });

    it("bounds the window with an optional until (half-open [since, until))", () => {
      repo.record({
        kind: "run_start",
        actorId: "a",
        detail: "in",
        ts: "2026-06-18T00:00:00.000Z",
      });
      repo.record({
        kind: "run_start",
        actorId: "b",
        detail: "edge",
        ts: "2026-06-20T00:00:00.000Z",
      });
      repo.record({
        kind: "run_start",
        actorId: "c",
        detail: "after",
        ts: "2026-06-21T00:00:00.000Z",
      });

      const { events } = repo.listEventsSince(
        "2026-06-17T00:00:00.000Z",
        50,
        "2026-06-20T00:00:00.000Z"
      );
      expect(events.map((e) => e.detail)).toEqual(["in"]); // "edge" excluded (until is exclusive)
    });

    it("returns empty (no more) for a future since or zero limit", () => {
      repo.record({ kind: "run_start", actorId: "a", ts: "2026-06-18T00:00:00.000Z" });
      expect(repo.listEventsSince("2026-06-19T00:00:00.000Z", 50)).toEqual({
        events: [],
        hasMore: false,
      });
      expect(repo.listEventsSince("2026-06-01T00:00:00.000Z", 0)).toEqual({
        events: [],
        hasMore: false,
      });
    });

    it("filters by kinds if specified", () => {
      repo.record({
        kind: "run_start",
        actorId: "a",
        detail: "start-event",
        ts: "2026-06-18T00:00:00.000Z",
      });
      repo.record({
        kind: "run_yielded",
        actorId: "a",
        detail: "yield-event",
        ts: "2026-06-18T00:00:01.000Z",
      });
      repo.record({
        kind: "run_end",
        actorId: "a",
        detail: "end-event",
        ts: "2026-06-18T00:00:02.000Z",
      });

      const { events } = repo.listEventsSince("2026-06-17T00:00:00.000Z", 50, undefined, [
        "run_yielded",
      ]);
      expect(events.map((e) => e.detail)).toEqual(["yield-event"]);
    });

    it("respects the order parameter (asc vs desc)", () => {
      repo.record({
        kind: "run_start",
        actorId: "a",
        detail: "oldest",
        ts: "2026-06-18T00:00:00.000Z",
      });
      repo.record({
        kind: "run_start",
        actorId: "a",
        detail: "middle",
        ts: "2026-06-18T00:00:01.000Z",
      });
      repo.record({
        kind: "run_start",
        actorId: "a",
        detail: "newest",
        ts: "2026-06-18T00:00:02.000Z",
      });

      // Default (asc): oldest-first
      const { events: eventsAsc } = repo.listEventsSince("2026-06-17T00:00:00.000Z", 2);
      expect(eventsAsc.map((e) => e.detail)).toEqual(["oldest", "middle"]);

      // Descending: newest-first
      const { events: eventsDesc } = repo.listEventsSince(
        "2026-06-17T00:00:00.000Z",
        2,
        undefined,
        undefined,
        "desc"
      );
      expect(eventsDesc.map((e) => e.detail)).toEqual(["newest", "middle"]);
    });
  });

  describe("getById", () => {
    it("returns the stored row or null", () => {
      const id = repo.record({ kind: "run_start", actorId: "a", detail: "hi" });
      expect(repo.getById(id)).toMatchObject({ id, kind: "run_start", detail: "hi" });
      expect(repo.getById("nonexistent")).toBeNull();
    });

    it("reflects clampBody truncation just like list()", () => {
      const big = `${"x".repeat(60_000)}TAIL`;
      const id = repo.record({ kind: "run_end", actorId: "a", body: big });
      const viaGet = repo.getById(id)?.body ?? "";
      const viaList = repo.list()[0].body ?? "";
      expect(viaGet).toBe(viaList);
      expect(viaGet.endsWith("TAIL")).toBe(true);
    });
  });

  describe("latestActivityByActor", () => {
    it("returns the latest ts per actor, ignoring null actor_ids", () => {
      repo.record({ kind: "run_start", actorId: "a", ts: "2026-06-20T00:00:00.000Z" });
      repo.record({ kind: "run_end", actorId: "a", success: true, ts: "2026-06-21T00:00:00.000Z" });
      repo.record({ kind: "run_start", actorId: "b", ts: "2026-06-22T00:00:00.000Z" });
      repo.record({ kind: "actor_retired", actorId: null, ts: "2026-06-23T00:00:00.000Z" });

      const latest = repo.latestActivityByActor();
      expect(latest.get("a")).toBe("2026-06-21T00:00:00.000Z");
      expect(latest.get("b")).toBe("2026-06-22T00:00:00.000Z");
      expect(latest.has("c")).toBe(false);
    });

    it("returns an empty map when no events exist", () => {
      expect(repo.latestActivityByActor()).toEqual(new Map());
    });
  });

  describe("countEventsSince", () => {
    beforeEach(() => {
      repo.record({ kind: "message_sent", actorId: "a", ts: "2026-06-10T00:00:00.000Z" });
      repo.record({ kind: "actor_spawned", actorId: "a", ts: "2026-06-11T00:00:00.000Z" });
      repo.record({ kind: "run_start", actorId: "a", ts: "2026-06-11T00:00:01.000Z" });
      repo.record({ kind: "scheduled_wake", actorId: "a", ts: "2026-06-11T00:00:02.000Z" });
    });

    it("counts only events whose kind is in the set", () => {
      expect(
        repo.countEventsSince("2026-06-01T00:00:00.000Z", ["message_sent", "actor_spawned"])
      ).toBe(2);
      expect(repo.countEventsSince("2026-06-01T00:00:00.000Z", ["message_sent"])).toBe(1);
      expect(
        repo.countEventsSince("2026-06-01T00:00:00.000Z", ["run_start", "scheduled_wake"])
      ).toBe(2);
    });

    it("honors the half-open [since, until) bounds", () => {
      // since is inclusive: the 06-10 message is counted from exactly its ts.
      expect(repo.countEventsSince("2026-06-10T00:00:00.000Z", ["message_sent"])).toBe(1);
      // since after it → not counted.
      expect(repo.countEventsSince("2026-06-10T00:00:00.001Z", ["message_sent"])).toBe(0);
      // until is exclusive: an until equal to the only event's ts excludes it.
      expect(
        repo.countEventsSince(
          "2026-06-01T00:00:00.000Z",
          ["actor_spawned"],
          "2026-06-11T00:00:00.000Z"
        )
      ).toBe(0);
      // until just past it → counted.
      expect(
        repo.countEventsSince(
          "2026-06-01T00:00:00.000Z",
          ["actor_spawned"],
          "2026-06-11T00:00:00.001Z"
        )
      ).toBe(1);
    });

    it("returns 0 for an empty kinds list", () => {
      expect(repo.countEventsSince("2026-06-01T00:00:00.000Z", [])).toBe(0);
    });
  });

  describe("body source (ISSUE_NUM single-source read; messageId-scoped, not kind-scoped)", () => {
    function insertChat(id: string, body: string): void {
      db.prepare(
        `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
         VALUES (?, '2026-07-19T00:00:00.000Z', 'root', 'worker-1', ?, NULL)`
      ).run(id, body);
    }

    it("reads a spine message's body from mesh_chat, not the event row", () => {
      insertChat("m1", "the real body, single-sourced in mesh_chat");
      // A stale duplicate on the event row must NOT win — the JOIN is authority.
      repo.record({
        kind: "message_sent",
        actorId: "worker-1",
        payload: JSON.stringify({ messageId: "m1", to: "worker-1" }),
        body: "stale duplicate that must never surface",
      });
      expect(repo.list()[0].body).toBe("the real body, single-sourced in mesh_chat");
    });

    it("yields a null body (fallback retired) when a spine message has no mesh_chat row", () => {
      // messageId present but no matching chat row: the body is genuinely gone;
      // the retired `?? row.body` must not resurface the duplicate.
      repo.record({
        kind: "message_sent",
        actorId: "worker-1",
        payload: JSON.stringify({ messageId: "missing", to: "worker-1" }),
        body: "stale duplicate that must stay buried",
      });
      expect(repo.list()[0].body).toBeNull();
    });

    it("keeps the event-row body for a legacy message with a null payload (messageId absent)", () => {
      // The ~1942 pre-ISSUE_NUM message_sent/received rows: body lives in
      // mesh_events, payload is null. Kind-scoping would wrongly blank these.
      repo.record({
        kind: "message_sent",
        actorId: "worker-1",
        body: "legacy inline body — no payload, must survive",
      });
      expect(repo.list()[0].body).toBe("legacy inline body — no payload, must survive");
    });

    it("keeps the event-row body for a non-message kind carrying no messageId", () => {
      repo.record({ kind: "run_end", actorId: "worker-1", body: "run output", success: true });
      expect(repo.list()[0].body).toBe("run output");
    });

    it("keeps the event-row body when a non-messageId payload is present", () => {
      // Defensive: a payload without a string messageId is treated as absent.
      repo.record({
        kind: "scheduled_wake",
        actorId: "worker-1",
        payload: JSON.stringify({ reason: "nightly" }),
        body: "wake reason body",
      });
      expect(repo.list()[0].body).toBe("wake reason body");
    });
  });

  describe("provider start history", () => {
    it("returns only matching actual starts with responsive priority", () => {
      repo.record({
        kind: "run_start",
        actorId: "worker-1",
        ts: "2026-07-23T10:00:00.000Z",
        payload: JSON.stringify({ provider: "codex", responsive: false }),
      });
      repo.record({
        kind: "run_start",
        actorId: "root",
        ts: "2026-07-23T10:01:00.000Z",
        payload: JSON.stringify({ provider: "codex", responsive: true }),
      });
      repo.record({
        kind: "run_queued",
        actorId: "worker-2",
        ts: "2026-07-23T10:02:00.000Z",
        payload: JSON.stringify({ provider: "codex", responsive: false }),
      });
      repo.record({
        kind: "run_start",
        actorId: "worker-3",
        ts: "2026-07-23T10:03:00.000Z",
        payload: JSON.stringify({ provider: "claude", responsive: false }),
      });

      expect(repo.listProviderStartsSince("codex", "2026-07-23T09:59:00.000Z")).toMatchObject([
        {
          kind: "run_start",
          ts: "2026-07-23T10:00:00.000Z",
          actorId: "worker-1",
          payload: { provider: "codex", responsive: false },
        },
        {
          kind: "run_start",
          ts: "2026-07-23T10:01:00.000Z",
          actorId: "root",
          payload: { provider: "codex", responsive: true },
        },
      ]);
    });
  });
  describe("listByKinds (the ledger reader's narrowed list)", () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
         VALUES ('m1', '2026-07-19T00:00:00.000Z', 'root', 'worker-1', 'the chat body', NULL)`
      ).run();
      repo.record({ kind: "run_queued", actorId: "worker-1", body: "queued noise" });
      repo.record({ kind: "run_start", actorId: "worker-1", body: "an inject record" });
      repo.record({
        kind: "run_end",
        actorId: "worker-1",
        success: true,
        body: "a run transcript",
      });
      repo.record({
        kind: "message_sent",
        actorId: "worker-1",
        payload: JSON.stringify({ messageId: "m1", to: "root" }),
        body: "stale duplicate",
      });
      repo.record({ kind: "run_yielded", actorId: "worker-1", detail: "complete", body: "a note" });
    });

    it("returns only the requested kinds, still in rowid order", () => {
      const events = repo.listByKinds(["run_end", "run_start"], { bodyKinds: [] });
      expect(events.map((e) => e.kind)).toEqual(["run_start", "run_end"]);
    });

    it("narrows `list()` without otherwise changing a single field", () => {
      const kinds = ["run_queued", "run_start", "run_end", "message_sent", "run_yielded"];
      expect(repo.listByKinds(kinds, { bodyKinds: kinds })).toEqual(repo.list());
    });

    it("blanks the body of a kind the caller did not ask a body for", () => {
      // The whole point: `run_end` bodies are 138 MB of transcripts on the live
      // mesh, and the ledger never reads one. Fetching the row must not fetch them.
      const [runEnd] = repo.listByKinds(["run_end"], { bodyKinds: ["run_yielded"] });
      expect(runEnd).toMatchObject({ kind: "run_end", success: true });
      expect(runEnd.body).toBeNull();
    });

    it("still reads a wanted body from mesh_chat rather than the event row", () => {
      const [sent] = repo.listByKinds(["message_sent"], { bodyKinds: ["message_sent"] });
      expect(sent.body).toBe("the chat body");
    });

    it("takes an empty body list as 'none of them', not as a SQL syntax error", () => {
      // `IN ()` does not parse, so the empty case has to be said as a constant.
      const bodies = repo
        .listByKinds(["run_yielded", "message_sent"], { bodyKinds: [] })
        .map((e) => e.body);
      expect(bodies).toEqual([null, null]);
    });

    it("returns nothing for an empty kinds list", () => {
      expect(repo.listByKinds([], { bodyKinds: ["run_end"] })).toEqual([]);
    });
  });
});
