import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import { runMigrations } from "../db/migrations/runner.js";
import { ChatRoomRepository } from "../db/repositories/chat-room-repository.js";
import { RoomEntryEpisodeRepository } from "../db/repositories/room-entry-episode-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { ChatRoomService } from "./chat-room.js";
import { RoomEntryService } from "./room-entry.js";
import { buildSupportedVoiceCatalog } from "./voice-catalog.js";
import { googleVoiceConfig } from "./voice-config.js";

const DEFAULT = googleVoiceConfig("Laomedeia");

function actor(id: string, overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id,
    charter: `Charter for ${id}`,
    parentId: id === "root" ? null : "root",
    ...(id === "root" ? { isRoot: true } : {}),
    status: "active",
    context: { type: "native" },
    createdAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatRoomService", () => {
  let db: Database.Database;
  let actors: SqliteActorRepository;
  let clock: number;

  const service = (onRemoved?: (actorId: string) => void) =>
    new ChatRoomService({
      store: new ChatRoomRepository(db),
      actors,
      rootId: "root",
      voices: () => buildSupportedVoiceCatalog(),
      defaultVoice: DEFAULT,
      isHumanPrincipal: (id) => id === "user-operator",
      onRemoved,
      now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, clock++)).toISOString(),
    });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    actors = new SqliteActorRepository(db);
    actors.upsert(actor("root"));
    clock = 0;
  });

  it("rolls roster deletion and invitation invalidation back together on failure", () => {
    actors.upsert(actor("a", { voiceConfig: googleVoiceConfig("Kore") }));
    const store = new RoomEntryEpisodeRepository(db);
    const room = service((id) => entries.invalidateRecipient(id));
    const entries = new RoomEntryService({
      store,
      inbox: new SqliteInboxRepository(db),
      roster: () => room.participants().map((member) => member.actorId),
    });
    room.add("a", "root");
    const entered = entries.enter({ principalId: "user-a", clientId: "tab-1", sessionKey: "s1" });
    if (entered.status !== "entered") throw new Error("not entered");
    const before = store.get(entered.episodeId);
    const original = store.update.bind(store);
    const failure = vi.spyOn(store, "update").mockImplementationOnce((id, patch) => {
      original(id, patch);
      throw new Error("injected invalidation failure");
    });
    expect(() => room.remove("a")).toThrow("injected invalidation failure");
    expect(room.participants().map((member) => member.actorId)).toContain("a");
    expect(store.get(entered.episodeId)).toEqual(before);
    failure.mockRestore();
    expect(room.remove("a")).toBe(true);
    room.add("a", "root");
    expect(entries.isEligibleRecipient(entered.episodeId, "a")).toBe(false);
  });

  it("starts as root alone", () => {
    expect(service().participants()).toEqual([{ actorId: "root", addedBy: null, addedAt: null }]);
  });

  it("persists added participants in join order, visible to a fresh reader", () => {
    actors.upsert(actor("a", { voiceConfig: googleVoiceConfig("Kore") }));
    actors.upsert(actor("b", { voiceConfig: googleVoiceConfig("Fenrir") }));
    service().add("b", "root");
    service().add("a", "root");

    // A new service over the same database stands in for another dashboard
    // (or a restart): membership is mesh state, not per-session state.
    expect(service().participants()).toEqual([
      { actorId: "root", addedBy: null, addedAt: null },
      { actorId: "b", addedBy: "root", addedAt: "2026-09-30T12:00:00.000Z" },
      { actorId: "a", addedBy: "root", addedAt: "2026-09-30T12:00:01.000Z" },
    ]);
  });

  it("keeps a distinct voice as-is", () => {
    actors.upsert(actor("a", { voiceConfig: googleVoiceConfig("Kore") }));

    const result = service().add("a", "root");

    expect(result).toEqual({
      actorId: "a",
      added: true,
      voice: googleVoiceConfig("Kore"),
      replacedVoice: null,
    });
    expect(actors.get("a")?.voiceConfig).toEqual(googleVoiceConfig("Kore"));
  });

  it("assigns the next unused voice when the added actor's voice collides", () => {
    // Root and `a` both follow the instance default, so they would sound the same.
    actors.upsert(actor("a"));
    // `b` is explicitly set to the first catalog voice, so the next pick skips it.
    actors.upsert(actor("b", { voiceConfig: googleVoiceConfig("Achernar") }));
    const room = service();
    room.add("b", "root");

    const result = room.add("a", "root");

    expect(result.replacedVoice).toEqual(DEFAULT);
    expect(result.voice).toEqual(googleVoiceConfig("Achird"));
    expect(actors.get("a")?.voiceConfig).toEqual(googleVoiceConfig("Achird"));
    const spoken = room
      .participants()
      .map((p) => actors.get(p.actorId)?.voiceConfig ?? DEFAULT)
      .map((v) => JSON.stringify(v));
    expect(new Set(spoken).size).toBe(spoken.length);
  });

  it("treats voice names case-insensitively when detecting a collision", () => {
    actors.upsert(actor("a", { voiceConfig: googleVoiceConfig("Kore") }));
    actors.upsert(actor("b", { voiceConfig: googleVoiceConfig("Kore") }));
    const room = service();
    room.add("a", "root");

    expect(room.add("b", "root").replacedVoice).toEqual(googleVoiceConfig("Kore"));
    expect(actors.get("b")?.voiceConfig).not.toEqual(googleVoiceConfig("Kore"));
  });

  it("does not change an existing participant again when it is re-added", () => {
    actors.upsert(actor("a", { voiceConfig: googleVoiceConfig("Kore") }));
    const room = service();
    room.add("a", "root");

    expect(room.add("a", "root")).toEqual({
      actorId: "a",
      added: false,
      voice: googleVoiceConfig("Kore"),
      replacedVoice: null,
    });
    expect(room.participants()).toHaveLength(2);
  });

  it("refuses root, aliases, human principals, and unknown or retired actors", () => {
    actors.upsert(actor("gone", { status: "retired" }));
    const room = service();

    expect(() => room.add("root", "root")).toThrow(/always in the Chat Room/);
    expect(() => room.add("parent", "root")).toThrow(/alias/);
    expect(() => room.add("human:operator", "root")).toThrow(/human principals/);
    expect(() => room.add("user-operator", "root")).toThrow(/human principals/);
    expect(() => room.add("nobody", "root")).toThrow(/unknown actor/);
    expect(() => room.add("gone", "root")).toThrow(/retired/);
    expect(room.participants()).toHaveLength(1);
  });

  it("refuses to add when every voice is already spoken for", () => {
    actors.upsert(actor("a"));
    const room = new ChatRoomService({
      store: new ChatRoomRepository(db),
      actors,
      rootId: "root",
      voices: () => [{ label: "Laomedeia", providerLabel: "Gemini", voiceConfig: DEFAULT }],
      defaultVoice: DEFAULT,
      isHumanPrincipal: () => false,
    });

    expect(() => room.add("a", "root")).toThrow(/no unused voice/);
    expect(room.participants()).toHaveLength(1);
    expect(actors.get("a")?.voiceConfig).toBeUndefined();
  });

  it("removes a participant, keeps its voice, and never removes root", () => {
    actors.upsert(actor("a"));
    const room = service();
    room.add("a", "root");
    const assigned = actors.get("a")?.voiceConfig;

    expect(room.remove("a")).toBe(true);
    expect(room.remove("a")).toBe(false);
    expect(room.participants()).toEqual([{ actorId: "root", addedBy: null, addedAt: null }]);
    expect(actors.get("a")?.voiceConfig).toEqual(assigned);
    expect(() => room.remove("root")).toThrow(/cannot be removed/);
    expect(() => room.remove("parent")).toThrow(/use an actor id, not an alias/);
  });

  it("tells its observer only when an actor actually left (#829)", () => {
    actors.upsert(actor("a"));
    const removed: string[] = [];
    const room = service((actorId) => removed.push(actorId));
    room.add("a", "root");
    room.remove("a");
    room.remove("a");
    expect(() => room.remove("root")).toThrow(/cannot be removed/);
    expect(removed).toEqual(["a"]);
  });

  it("hides a participant once it retires", () => {
    actors.upsert(actor("a", { voiceConfig: googleVoiceConfig("Kore") }));
    const room = service();
    room.add("a", "root");
    actors.patch("a", { status: "retired" });

    expect(room.participants()).toEqual([{ actorId: "root", addedBy: null, addedAt: null }]);
  });
});
