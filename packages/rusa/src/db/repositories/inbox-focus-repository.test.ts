import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import { InboxFocusRepository } from "./inbox-focus-repository.js";
import { InboxRepository } from "./inbox-repository.js";
import { ObligationRepository } from "./obligation-repository.js";

describe("InboxFocusRepository", () => {
  let db: Database.Database;
  let runs: ActorRunRepository;
  let inbox: InboxRepository;
  let obligations: ObligationRepository;
  let focus: InboxFocusRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    inbox = new InboxRepository(db);
    obligations = new ObligationRepository(db, (id) => id === "actor-a");
    focus = new InboxFocusRepository(db, () => new Date("2026-09-01T12:00:00.000Z"));
    inbox.append([
      { id: "entry-1", actorId: "actor-a", source: "chat", payload: { type: "message" } },
      { id: "entry-2", actorId: "actor-a", source: "chat", payload: { type: "message" } },
      { id: "foreign", actorId: "actor-b", source: "chat", payload: { type: "message" } },
    ]);
    obligations.create({ id: "ob-1", ownerId: "actor-a", title: "Primary" });
    obligations.create({
      id: "ob-2",
      parentId: "ob-1",
      ownerId: "actor-a",
      title: "Related child",
    });
  });

  it("persists the selected set, primary obligation, diagnostics, and associations", () => {
    runs.start({ id: "run-1", actorId: "actor-a" });
    const associations = new Map<string, readonly string[]>([
      ["entry-1", ["ob-1", "ob-2"]],
      ["entry-2", ["ob-2"]],
    ]);

    expect(
      focus.recordSelection({
        runId: "run-1",
        actorId: "actor-a",
        entryIds: ["entry-1", "entry-2"],
        primaryObligationId: "ob-2",
        resolution: "inferred",
        diagnostics: ["ancestor entry grouped with its child"],
        associations,
      })
    ).toMatchObject({
      runId: "run-1",
      primaryObligationId: "ob-2",
      resolution: "inferred",
      entryIds: ["entry-1", "entry-2"],
      diagnostics: ["ancestor entry grouped with its child"],
    });
    expect(focus.listEntryObligationIds("actor-a", "entry-1")).toEqual(["ob-1", "ob-2"]);
    expect(new InboxFocusRepository(db).getByRunId("run-1")).toMatchObject({
      primaryObligationId: "ob-2",
      entryIds: ["entry-1", "entry-2"],
    });
    expect(runs.activeFocusPrimaryObligationId("run-1")).toBe("ob-2");
    runs.complete("run-1", { success: true, exitCode: 0, output: "" });
    expect(runs.activeFocusPrimaryObligationId("run-1")).toBeNull();
  });

  it("replaces one run's selection without deleting durable entry associations", () => {
    runs.start({ id: "run-1", actorId: "actor-a" });
    focus.recordSelection({
      runId: "run-1",
      actorId: "actor-a",
      entryIds: ["entry-1"],
      primaryObligationId: "ob-1",
      resolution: "explicit",
      associations: new Map([["entry-1", ["ob-1"]]]),
    });
    focus.recordSelection({
      runId: "run-1",
      actorId: "actor-a",
      entryIds: ["entry-2"],
      primaryObligationId: null,
      resolution: "none",
    });

    expect(focus.getByRunId("run-1")).toMatchObject({
      entryIds: ["entry-2"],
      primaryObligationId: null,
      resolution: "none",
    });
    expect(focus.listEntryObligationIds("actor-a", "entry-1")).toEqual(["ob-1"]);
  });

  it("rejects foreign inbox entries, mismatched runs, and completed runs", () => {
    runs.start({ id: "run-a", actorId: "actor-a" });
    expect(() =>
      focus.recordSelection({
        runId: "run-a",
        actorId: "actor-a",
        entryIds: ["foreign"],
        primaryObligationId: null,
        resolution: "none",
      })
    ).toThrow("inbox entry not found");

    expect(() =>
      focus.recordSelection({
        runId: "run-a",
        actorId: "actor-b",
        entryIds: ["foreign"],
        primaryObligationId: null,
        resolution: "none",
      })
    ).toThrow("belongs to a different actor");

    runs.complete("run-a", { success: true, exitCode: 0, output: "" });
    expect(() =>
      focus.recordSelection({
        runId: "run-a",
        actorId: "actor-a",
        entryIds: ["entry-1"],
        primaryObligationId: null,
        resolution: "none",
      })
    ).toThrow("active actor run not found");
  });
});
