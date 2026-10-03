import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { RoomEntryEpisodeRepository } from "../db/repositories/room-entry-episode-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import {
  ROOM_ENTRY_DRAIN_BATCH,
  ROOM_ENTRY_SOURCE,
  RoomEntryService,
  roomEntryNoticeId,
} from "./room-entry.js";
import {
  parseRoomEntryDocument,
  ROOM_ENTRY_LEASE_MS,
  ROOM_ENTRY_LIMITS,
} from "./room-entry-document.js";

const T0 = Date.parse("2026-10-03T12:00:00.000Z");

describe("RoomEntryService (#829)", () => {
  let db: Database.Database;
  let store: RoomEntryEpisodeRepository;
  let inbox: SqliteInboxRepository;
  let now: number;
  let roster: string[];
  let ids: number;
  let logs: string[];

  const service = (overrides: { inbox?: Pick<InboxRepository, "append" | "read"> } = {}) =>
    new RoomEntryService({
      store,
      inbox: overrides.inbox ?? inbox,
      roster: () => roster,
      now: () => now,
      newId: () => `id-${++ids}`,
      log: (message) => logs.push(message),
    });

  const tab = (clientId: string, principalId = "user-a", sessionKey = "session-1") => ({
    principalId,
    clientId,
    sessionKey,
  });

  const notices = (actorId: string) =>
    inbox.list(actorId, { status: "all" }).entries.filter((e) => e.source === ROOM_ENTRY_SOURCE);

  const recipients = (episodeId: string) =>
    parseRoomEntryDocument(store.get(episodeId)?.documentJson ?? "").recipients;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    store = new RoomEntryEpisodeRepository(db);
    inbox = new SqliteInboxRepository(db, () => new Date(now));
    now = T0;
    roster = ["root", "actor-1", "actor-2"];
    ids = 0;
    logs = [];
  });

  it("appends one responsive, joining notice per snapshot participant", () => {
    const entry = service().enter(tab("tab-1"));
    expect(entry).toMatchObject({ status: "entered", created: true });
    if (entry.status !== "entered") throw new Error("not entered");

    for (const actorId of roster) {
      const [notice] = notices(actorId);
      expect(notice.id).toBe(roomEntryNoticeId(entry.episodeId, actorId));
      expect(notice.payload).toEqual({
        type: "room.human_entry",
        version: 1,
        priority: "responsive",
        interruption: "join",
        episodeId: entry.episodeId,
        principalId: "user-a",
        enteredAt: new Date(T0).toISOString(),
      });
    }
    expect(recipients(entry.episodeId).every((r) => r.status === "delivered")).toBe(true);
  });

  it("shares one episode across tabs, reattaches and repeated enters without new notices", () => {
    const rooms = service();
    const first = rooms.enter(tab("tab-1"));
    const second = rooms.enter(tab("tab-2"));
    const reattach = rooms.enter(tab("tab-1"));
    if (first.status !== "entered" || second.status !== "entered" || reattach.status !== "entered")
      throw new Error("not entered");

    expect(second).toMatchObject({ episodeId: first.episodeId, created: false });
    expect(reattach).toMatchObject({ episodeId: first.episodeId, created: false });
    expect(reattach.generation).not.toBe(first.generation);
    for (const actorId of roster) expect(notices(actorId)).toHaveLength(1);
  });

  it("rejects a stale generation's leave and renewal after the tab reattached", () => {
    const rooms = service();
    const old = rooms.enter(tab("tab-1"));
    const current = rooms.enter(tab("tab-1"));
    if (old.status !== "entered" || current.status !== "entered") throw new Error("not entered");

    const stale = { ...tab("tab-1"), episodeId: old.episodeId, generation: old.generation };
    expect(rooms.leave(stale)).toEqual({ status: "stale" });
    expect(rooms.renew(stale)).toEqual({ status: "stale" });
    expect(rooms.presence(old.episodeId)).toBe("present");
    expect(
      rooms.leave({ ...tab("tab-1"), episodeId: current.episodeId, generation: current.generation })
    ).toEqual({ status: "left", ended: true });
  });

  it("keeps the episode until the last explicit leave, then starts a new one", () => {
    const rooms = service();
    const a = rooms.enter(tab("tab-1"));
    const b = rooms.enter(tab("tab-2"));
    if (a.status !== "entered" || b.status !== "entered") throw new Error("not entered");

    expect(
      rooms.leave({ ...tab("tab-1"), episodeId: a.episodeId, generation: a.generation })
    ).toEqual({ status: "left", ended: false });
    expect(rooms.presence(a.episodeId)).toBe("present");
    expect(
      rooms.leave({ ...tab("tab-2"), episodeId: b.episodeId, generation: b.generation })
    ).toEqual({ status: "left", ended: true });
    expect(rooms.presence(a.episodeId)).toBe("departed");

    const again = rooms.enter(tab("tab-1"));
    expect(again).toMatchObject({ status: "entered", created: true });
    if (again.status !== "entered") throw new Error("not entered");
    expect(again.episodeId).not.toBe(a.episodeId);
    for (const actorId of roster) expect(notices(actorId)).toHaveLength(2);
  });

  it("never revives an expired episode; a later enter starts a new one", () => {
    const rooms = service();
    const entry = rooms.enter(tab("tab-1"));
    if (entry.status !== "entered") throw new Error("not entered");

    now += ROOM_ENTRY_LEASE_MS - 1;
    expect(
      rooms.renew({ ...tab("tab-1"), episodeId: entry.episodeId, generation: entry.generation })
    ).toMatchObject({ status: "renewed" });
    now += ROOM_ENTRY_LEASE_MS;
    expect(rooms.presence(entry.episodeId)).toBe("departed");
    expect(
      rooms.renew({ ...tab("tab-1"), episodeId: entry.episodeId, generation: entry.generation })
    ).toEqual({ status: "expired" });
    expect(store.get(entry.episodeId)?.endedAt).toBe(
      new Date(T0 + 2 * ROOM_ENTRY_LEASE_MS - 1).toISOString()
    );

    const next = rooms.enter(tab("tab-1"));
    expect(next).toMatchObject({ status: "entered", created: true });
  });

  it("does not renew one tab's lapsed lease while another tab keeps the episode", () => {
    const rooms = service();
    const a = rooms.enter(tab("tab-1"));
    now += ROOM_ENTRY_LEASE_MS / 2;
    const b = rooms.enter(tab("tab-2"));
    if (a.status !== "entered" || b.status !== "entered") throw new Error("not entered");
    now += ROOM_ENTRY_LEASE_MS / 2 + 1;

    expect(
      rooms.renew({ ...tab("tab-1"), episodeId: a.episodeId, generation: a.generation })
    ).toEqual({ status: "stale" });
    expect(rooms.presence(a.episodeId)).toBe("present");
  });

  it("projects reconnecting after a restart until the tab renews", () => {
    const entry = service().enter(tab("tab-1"));
    if (entry.status !== "entered") throw new Error("not entered");

    const restarted = service();
    expect(restarted.presence(entry.episodeId)).toBe("reconnecting");
    restarted.renew({ ...tab("tab-1"), episodeId: entry.episodeId, generation: entry.generation });
    expect(restarted.presence(entry.episodeId)).toBe("present");
    for (const actorId of roster) expect(notices(actorId)).toHaveLength(1);
  });

  it("isolates principals: separate episodes, and no cross-principal renew or leave", () => {
    const rooms = service();
    const a = rooms.enter(tab("tab-1", "user-a"));
    const b = rooms.enter(tab("tab-1", "user-b", "session-2"));
    if (a.status !== "entered" || b.status !== "entered") throw new Error("not entered");

    expect(b.episodeId).not.toBe(a.episodeId);
    const forged = { ...tab("tab-1", "user-b", "session-2"), episodeId: a.episodeId };
    expect(rooms.renew({ ...forged, generation: a.generation })).toEqual({ status: "expired" });
    expect(rooms.leave({ ...forged, generation: a.generation })).toEqual({ status: "stale" });
    expect(rooms.presence(a.episodeId)).toBe("present");
    for (const actorId of roster) expect(notices(actorId)).toHaveLength(2);
  });

  it("ends a session's leases on sign-out while another session keeps the episode", () => {
    const rooms = service();
    const a = rooms.enter(tab("tab-1", "user-a", "session-1"));
    rooms.enter(tab("tab-2", "user-a", "session-2"));
    if (a.status !== "entered") throw new Error("not entered");

    rooms.invalidateSession("session-1");
    expect(rooms.presence(a.episodeId)).toBe("present");
    expect(
      rooms.renew({ ...tab("tab-1"), episodeId: a.episodeId, generation: a.generation })
    ).toEqual({ status: "stale" });
    rooms.invalidateSession("session-2");
    expect(rooms.presence(a.episodeId)).toBe("departed");
    expect(store.get(a.episodeId)?.endedAt).not.toBeNull();
  });

  describe("bounds fail without partial effect", () => {
    it("refuses a tab beyond the lease bound without evicting any tab", () => {
      const rooms = service();
      const entered = Array.from({ length: ROOM_ENTRY_LIMITS.maxLeases }, (_, i) =>
        rooms.enter(tab(`tab-${i}`))
      );
      expect(rooms.enter(tab("one-too-many"))).toMatchObject({ status: "unavailable" });
      const episodeId = entered[0].status === "entered" ? entered[0].episodeId : "";
      const leases = parseRoomEntryDocument(store.get(episodeId)?.documentJson ?? "").leases;
      expect(leases.map((lease) => lease.clientId)).toEqual(entered.map((_, i) => `tab-${i}`));
    });

    it("refuses an oversized roster without creating an episode or any notice", () => {
      roster = Array.from({ length: ROOM_ENTRY_LIMITS.maxRecipients + 1 }, (_, i) => `actor-${i}`);
      expect(service().enter(tab("tab-1"))).toMatchObject({ status: "unavailable" });
      expect(store.list()).toEqual([]);
      expect(notices("actor-0")).toEqual([]);
    });

    it("refuses an invalid client id", () => {
      expect(service().enter(tab(""))).toMatchObject({ status: "unavailable" });
      expect(
        service().enter(tab("x".repeat(ROOM_ENTRY_LIMITS.maxClientIdBytes + 1)))
      ).toMatchObject({ status: "unavailable" });
      expect(store.list()).toEqual([]);
    });
  });

  describe("delivery", () => {
    it("keeps a failed append pending and delivers it exactly once later", () => {
      let failFor: string | null = "actor-1";
      const flaky: Pick<InboxRepository, "append" | "read"> = {
        append: (inputs) => {
          if (inputs.some((input) => input.actorId === failFor)) throw new Error("disk full");
          return inbox.append(inputs);
        },
        read: (actorId, id) => inbox.read(actorId, id),
      };
      const rooms = service({ inbox: flaky });
      const entry = rooms.enter(tab("tab-1"));
      if (entry.status !== "entered") throw new Error("not entered");

      expect(notices("actor-1")).toEqual([]);
      expect(recipients(entry.episodeId)).toContainEqual({ actorId: "actor-1", status: "pending" });
      expect(logs.some((line) => line.includes("still pending: disk full"))).toBe(true);

      failFor = null;
      rooms.drain();
      rooms.drain();
      for (const actorId of roster) expect(notices(actorId)).toHaveLength(1);
      expect(recipients(entry.episodeId).every((r) => r.status === "delivered")).toBe(true);
    });

    it("completes a notice appended before a crash without duplicating it", () => {
      // Episode committed and notices appended, but the process died before
      // stamping: recreate that state by reverting the stamps.
      const entry = service().enter(tab("tab-1"));
      if (entry.status !== "entered") throw new Error("not entered");
      const row = store.get(entry.episodeId);
      if (!row) throw new Error("missing");
      const document = parseRoomEntryDocument(row.documentJson);
      store.update(row.id, {
        endedAt: null,
        documentJson: JSON.stringify({
          ...document,
          recipients: document.recipients.map((r) => ({ ...r, status: "pending" })),
        }),
      });

      service().drain();
      for (const actorId of roster) expect(notices(actorId)).toHaveLength(1);
      expect(recipients(entry.episodeId).every((r) => r.status === "delivered")).toBe(true);
    });

    it("skips a recipient retired before its notice, and voids a removed one for good", () => {
      let failing = true;
      const blocked: Pick<InboxRepository, "append" | "read"> = {
        append: (inputs) => {
          if (failing) throw new Error("unavailable");
          return inbox.append(inputs);
        },
        read: (actorId, id) => inbox.read(actorId, id),
      };
      const rooms = service({ inbox: blocked });
      const entry = rooms.enter(tab("tab-1"));
      if (entry.status !== "entered") throw new Error("not entered");

      rooms.invalidateRecipient("actor-1");
      roster = ["root", "actor-1"]; // actor-1 re-added; actor-2 retired.
      failing = false;
      rooms.drain();

      expect(recipients(entry.episodeId)).toEqual([
        { actorId: "root", status: "delivered" },
        { actorId: "actor-1", status: "invalidated" },
        { actorId: "actor-2", status: "skipped" },
      ]);
      expect(notices("actor-1")).toEqual([]);
      expect(notices("actor-2")).toEqual([]);
      expect(rooms.isEligibleRecipient(entry.episodeId, "actor-1")).toBe(false);
      expect(rooms.isEligibleRecipient(entry.episodeId, "root")).toBe(true);
    });

    it("bounds one pass and shares it across episodes", () => {
      roster = Array.from({ length: 100 }, (_, i) => `actor-${i}`);
      const rooms = service();
      const a = rooms.enter(tab("tab-1", "user-a"));
      const b = rooms.enter(tab("tab-1", "user-b", "session-2"));
      if (a.status !== "entered" || b.status !== "entered") throw new Error("not entered");
      const delivered = (episodeId: string) =>
        recipients(episodeId).filter((r) => r.status === "delivered").length;

      // A's enter drained a full batch; B's enter split the next between them.
      expect(delivered(a.episodeId)).toBe(ROOM_ENTRY_DRAIN_BATCH + ROOM_ENTRY_DRAIN_BATCH / 2);
      expect(delivered(b.episodeId)).toBe(ROOM_ENTRY_DRAIN_BATCH / 2);
      rooms.drain();
      rooms.drain();
      expect(delivered(a.episodeId)).toBe(100);
      expect(delivered(b.episodeId)).toBe(100);
    });
  });

  describe("collection", () => {
    it("keeps an episode while it is open, its fanout is pending, or a notice is unhandled", () => {
      const rooms = service();
      const entry = rooms.enter(tab("tab-1"));
      if (entry.status !== "entered") throw new Error("not entered");
      expect(rooms.collect()).toBe(0);

      rooms.leave({ ...tab("tab-1"), episodeId: entry.episodeId, generation: entry.generation });
      expect(rooms.collect()).toBe(0);

      for (const actorId of ["root", "actor-1"]) {
        inbox.markHandled(
          actorId,
          [roomEntryNoticeId(entry.episodeId, actorId)],
          new Date(now),
          "ok"
        );
      }
      expect(rooms.collect()).toBe(0);
      inbox.markHandled(
        "actor-2",
        [roomEntryNoticeId(entry.episodeId, "actor-2")],
        new Date(now),
        "ok"
      );
      expect(rooms.collect()).toBe(1);
      expect(store.get(entry.episodeId)).toBeNull();
      expect(rooms.presence(entry.episodeId)).toBe("departed");
      // The handled notice keeps the episode id and entry time on its own.
      expect(notices("root")[0].payload).toMatchObject({ episodeId: entry.episodeId });
    });

    it("retains incomplete fanout regardless of age, and ends then collects a lapsed episode", () => {
      const blocked: Pick<InboxRepository, "append" | "read"> = {
        append: () => {
          throw new Error("unavailable");
        },
        read: () => null,
      };
      const stuck = service({ inbox: blocked });
      const entry = stuck.enter(tab("tab-1"));
      if (entry.status !== "entered") throw new Error("not entered");
      now += 30 * ROOM_ENTRY_LEASE_MS;
      expect(stuck.collect()).toBe(0);
      expect(store.get(entry.episodeId)?.endedAt).not.toBeNull();

      const rooms = service();
      rooms.drain();
      for (const actorId of roster) {
        inbox.markHandled(
          actorId,
          [roomEntryNoticeId(entry.episodeId, actorId)],
          new Date(now),
          "ok"
        );
      }
      expect(rooms.collect()).toBe(1);
    });
  });
});
