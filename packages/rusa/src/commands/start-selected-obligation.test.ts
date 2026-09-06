import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createRunAccounting } from "../actor/run-accounting.js";
import { runMigrations } from "../db/migrations/runner.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import { InboxFocusRepository } from "../db/repositories/inbox-focus-repository.js";
import { InboxRepository } from "../db/repositories/inbox-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { createSelectedObligationForActor } from "./start.js";

/**
 * The *semantics* of the dashboard's "current work" reader, against a real run
 * ledger and real focus/obligation stores rather than a stub on either side.
 *
 * Scope is deliberate: this owns what the reader means, not where `runStart`
 * binds it. That binding is a single call site covered by typecheck and review
 * — passing a second, never-begun `RunAccounting` there would typecheck and
 * leave these tests green.
 *
 * The load-bearing case is the restart one. Every other assertion here also
 * holds for a "most recent open run row for this actor" reader, because
 * `activeFocusPrimaryObligationId` already filters on `outcome IS NULL`; only
 * an open row that this leader never claimed separates the two.
 */
describe("createSelectedObligationForActor", () => {
  const ACTOR = "actor-a";
  let db: Database.Database;
  let runs: ActorRunRepository;
  let obligations: ObligationRepository;
  let focus: InboxFocusRepository;
  let accounting: ReturnType<typeof createRunAccounting>;
  let selectedObligationForActor: ReturnType<typeof createSelectedObligationForActor>;

  const select = (runId: string, primaryObligationId: string | null) =>
    focus.recordSelection({
      runId,
      actorId: ACTOR,
      entryIds: ["entry-1"],
      primaryObligationId,
      resolution: primaryObligationId ? "explicit" : "none",
    });

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    obligations = new ObligationRepository(db, (id) => id === ACTOR);
    focus = new InboxFocusRepository(db);
    new InboxRepository(db).append([
      { id: "entry-1", actorId: ACTOR, source: "chat", payload: { type: "message" } },
    ]);
    obligations.create({ id: "ob-1", ownerId: ACTOR, title: "Selected work" });
    accounting = createRunAccounting(() => runs);
    selectedObligationForActor = createSelectedObligationForActor(accounting, () => ({
      actorRuns: runs,
      obligations,
    }));
  });

  it("resolves the focus of the run this actor has open right now", () => {
    select(accounting.begin(ACTOR, "claude"), "ob-1");

    expect(selectedObligationForActor(ACTOR)).toMatchObject({ id: "ob-1", title: "Selected work" });
  });

  it("reports no current work for an actor with no open run", () => {
    expect(selectedObligationForActor(ACTOR)).toBeNull();
  });

  it("stops reporting a focus once the run that selected it completes", () => {
    select(accounting.begin(ACTOR, "claude"), "ob-1");
    expect(selectedObligationForActor(ACTOR)).toMatchObject({ id: "ob-1" });

    accounting.complete(ACTOR, { success: true, exitCode: 0, output: "" });

    expect(selectedObligationForActor(ACTOR)).toBeNull();
  });

  it("reports no current work for an open run this leader did not claim", () => {
    select(accounting.begin(ACTOR, "claude"), "ob-1");

    // A fresh leader over the same durable stores, as after a restart: the row
    // is still open and still carries a focus, but no run is claimed in this
    // process. "Open right now" is the leader's in-process claim, not the row.
    const restarted = createSelectedObligationForActor(
      createRunAccounting(() => runs),
      () => ({
        actorRuns: runs,
        obligations,
      })
    );

    expect(restarted(ACTOR)).toBeNull();
  });

  it("reports no current work when the open run selected nothing", () => {
    select(accounting.begin(ACTOR, "claude"), null);

    expect(selectedObligationForActor(ACTOR)).toBeNull();
  });
});
