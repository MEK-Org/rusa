import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ObligationActivationRecord,
  ObligationActivationScheduler,
} from "../../actor/os-scheduler.js";
import { ObligationValidationError } from "../../obligations/obligation.js";
import { obligations } from "../migrations/0016_obligations.js";
import { obligationPriority } from "../migrations/0017_obligation_priority.js";
import { obligationTimestamps } from "../migrations/0025_obligation_timestamps.js";
import { obligationTerminalNote } from "../migrations/0026_obligation_terminal_note.js";
import { obligationTitle } from "../migrations/0027_obligation_title.js";
import { obligationArtifacts } from "../migrations/0028_obligation_artifacts.js";
import { recurringObligations } from "../migrations/0035_recurring_obligations.js";
import { obligationDependencies } from "../migrations/0037_obligation_dependencies.js";
import { obligationCheckpoint } from "../migrations/0043_obligation_checkpoint.js";
import { obligationHistory } from "../migrations/0045_obligation_history.js";
import { obligationResponsive } from "../migrations/0049_obligation_responsive.js";
import { dropObligationReadyHeads } from "../migrations/0050_drop_obligation_ready_heads.js";
import { obligationSnooze } from "../migrations/0052_obligation_snooze.js";
import { ObligationRepository } from "./obligation-repository.js";

type Activation = { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date };

/** Records the one OS job per obligation instead of touching the host. */
class FakeScheduler implements ObligationActivationScheduler {
  activations = new Map<string, Activation>();
  readonly instanceId = "test-instance";
  atAvailable: boolean | undefined = undefined;
  failAt = false;
  scheduleObligationActivation(id: string, time: Activation): void {
    if (this.failAt && time.kind === "at") throw new Error("at: queue write failed");
    this.activations.set(id, time);
  }
  cancelObligationActivation(id: string): void {
    this.activations.delete(id);
  }
  listObligationActivations(): ObligationActivationRecord[] {
    return Array.from(this.activations.keys()).map((id) => ({ id, instanceId: this.instanceId }));
  }
  canScheduleAt(): boolean {
    return this.atAvailable !== false;
  }
}

const T0 = Date.parse("2026-09-27T12:10:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

describe("obligation snooze (#722)", () => {
  let db: Database.Database;
  let repository: ObligationRepository;
  let scheduler: FakeScheduler;
  let t: number;
  let heads: Array<{ ownerId: string; headId: string | null }>;
  let responsive: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);
    obligationTimestamps.up(db);
    obligationTerminalNote.up(db);
    obligationTitle.up(db);
    obligationArtifacts.up(db);
    recurringObligations.up(db);
    obligationDependencies.up(db);
    obligationCheckpoint.up(db);
    obligationHistory.up(db);
    obligationResponsive.up(db);
    obligationSnooze.up(db);
    dropObligationReadyHeads.up(db);
    t = T0;
    repository = new ObligationRepository(
      db,
      (id) => ["actor-a", "actor-b", "actor-c"].includes(id),
      () => t
    );
    scheduler = new FakeScheduler();
    repository.setOsScheduler(scheduler);
    heads = [];
    repository.setReadyHeadListener(({ ownerId, head }) =>
      heads.push({ ownerId, headId: head?.id ?? null })
    );
    responsive = [];
    repository.setResponsiveReadyListener((obligation) => responsive.push(obligation.id));
  });

  const snooze = (id: string, until: string | null, principal = "actor-a") =>
    repository.setSnooze(id, until, principal).obligation;

  /** A completion_interval obligation completed at T0, next due at T0 + 1h. */
  function intervalScheduled(id = "rec"): void {
    repository.create({ title: id, id, ownerId: "actor-a" });
    repository.setRecurrence(
      id,
      { policy: "completion_interval", intervalSeconds: 3600 },
      "actor-a"
    );
    repository.setTerminalStatus(id, "done", null, null, "actor-a");
  }

  describe("setting and clearing", () => {
    beforeEach(() => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
    });

    it("normalizes an offset deadline to UTC and keeps the status", () => {
      const snoozed = snooze("a", "2026-09-27T15:30:00+02:00");
      expect(snoozed.snoozedUntil).toBe("2026-09-27T13:30:00.000Z");
      expect(snoozed.status).toBe("ready");
    });

    it("rejects a zone-less, past, or already-due deadline without writing", () => {
      expect(() => snooze("a", "2026-09-27T15:30:00")).toThrow(ObligationValidationError);
      expect(() => snooze("a", iso(T0 - HOUR))).toThrow(/pass null to clear/);
      // Minute-floored: a deadline inside the current minute is already due.
      expect(() => snooze("a", iso(T0 + 30_000))).toThrow(/pass null to clear/);
      expect(repository.require("a").snoozedUntil).toBeNull();
      expect(repository.listHistory("a").some((h) => h.mutationKind === "snooze")).toBe(false);
    });

    it("has no duration cap", () => {
      expect(snooze("a", "2100-01-01T00:00:00.000Z").snoozedUntil).toBe("2100-01-01T00:00:00.000Z");
    });

    it("rejects a terminal obligation", () => {
      repository.setTerminalStatus("a", "done", null, null, "actor-a");
      expect(() => snooze("a", iso(T0 + HOUR))).toThrow("terminal obligations cannot be snoozed");
    });

    it("treats rewriting the current deadline as a no-op", () => {
      snooze("a", iso(T0 + HOUR));
      const before = repository.require("a");
      const historyBefore = repository.listHistory("a").length;
      t += MIN;
      snooze("a", iso(T0 + HOUR));
      expect(repository.require("a")).toEqual(before);
      expect(repository.listHistory("a")).toHaveLength(historyBefore);
      snooze("a", null);
      const cleared = repository.require("a");
      snooze("a", null);
      expect(repository.require("a")).toEqual(cleared);
    });

    it("records set, extend, and clear as snooze history with before/after", () => {
      snooze("a", iso(T0 + HOUR));
      snooze("a", iso(T0 + 2 * HOUR));
      snooze("a", null);
      const history = repository
        .listHistory("a")
        .filter((h) => h.mutationKind === "snooze")
        .reverse();
      expect(history.map((h) => [h.before.snoozedUntil, h.after.snoozedUntil])).toEqual([
        [null, iso(T0 + HOUR)],
        [iso(T0 + HOUR), iso(T0 + 2 * HOUR)],
        [iso(T0 + 2 * HOUR), null],
      ]);
      expect(history.every((h) => h.actingPrincipal === "actor-a")).toBe(true);
    });

    it("survives reassignment, keeping the timestamp for the new owner", () => {
      snooze("a", iso(T0 + HOUR));
      const moved = repository.reassign("a", "actor-b", "actor-a");
      expect(moved.ownerId).toBe("actor-b");
      expect(moved.snoozedUntil).toBe(iso(T0 + HOUR));
      expect(snooze("a", null, "actor-b").snoozedUntil).toBeNull();
    });

    it("survives working the obligation: checkpoint and artifact writes keep it", () => {
      snooze("a", iso(T0 + HOUR));
      repository.setCheckpoint("a", "waiting on the quota reset", "actor-a");
      repository.attachArtifact("a", "github:MEK-Org/rusa/issues/722", { attachedBy: "actor-a" });
      const worked = repository.require("a");
      expect(worked.snoozedUntil).toBe(iso(T0 + HOUR));
      expect(worked.status).toBe("ready");
      expect(repository.readyHeads().has("actor-a")).toBe(false);
    });
  });

  describe("attention gate", () => {
    it("drops a snoozed head from every ready surface and queues it after actionable work", () => {
      repository.create({ title: "first", id: "first", ownerId: "actor-a", priority: 1 });
      repository.create({ title: "second", id: "second", ownerId: "actor-a", priority: 2 });
      repository.create({ title: "parent", id: "parent", ownerId: "actor-a", priority: 0 });
      repository.create({ title: "kid", id: "kid", ownerId: "actor-b", parentId: "parent" });
      expect(repository.readyHeads().get("actor-a")).toBe("first");
      heads = [];

      snooze("first", iso(T0 + HOUR));

      expect(heads).toEqual([{ ownerId: "actor-a", headId: "second" }]);
      expect(repository.readyHeads().get("actor-a")).toBe("second");
      // Actionable ready, then snoozed ready, then waiting.
      const order = ["second", "first", "parent"];
      expect(repository.listOwned("actor-a").map((o) => o.id)).toEqual(order);
      expect(
        repository.listOwnedPage("actor-a", { limit: 10, offset: 0 }).obligations.map((o) => o.id)
      ).toEqual(order);
      expect(repository.listOwned("actor-a", { status: "ready" }).map((o) => o.id)).toEqual([
        "second",
        "first",
      ]);
    });

    it("leaves an owner whose only ready work is snoozed with no head", () => {
      repository.create({ title: "only", id: "only", ownerId: "actor-b" });
      heads = [];
      snooze("only", iso(T0 + HOUR), "actor-b");
      expect(repository.readyHeads().has("actor-b")).toBe(false);
      expect(heads).toEqual([{ ownerId: "actor-b", headId: null }]);
    });

    it("withholds responsive-ready attention while snoozed", () => {
      repository.create({ title: "head", id: "head", ownerId: "actor-a", priority: 1 });
      repository.create({ title: "hot", id: "hot", ownerId: "actor-a", priority: 2 });
      snooze("hot", iso(T0 + HOUR));
      responsive = [];
      repository.markResponsive("hot", "actor-a");
      expect(responsive).toEqual([]);
      expect(repository.listResponsiveReadyAttention()).toEqual([]);
    });

    it("unsnoozing a ready row starts exactly one fresh ready-attention episode", () => {
      repository.create({ title: "head", id: "head", ownerId: "actor-a", priority: 1 });
      repository.create({
        title: "hot",
        id: "hot",
        ownerId: "actor-a",
        priority: 2,
        responsive: true,
      });
      snooze("hot", iso(T0 + HOUR));
      const before = repository.require("hot").readyCount;
      responsive = [];

      const cleared = snooze("hot", null);

      expect(cleared.readyCount).toBe(before + 1);
      expect(responsive).toEqual(["hot"]);
      expect(repository.listResponsiveReadyAttention().map((o) => o.id)).toEqual(["hot"]);
    });

    it("expiry of a snoozed head re-announces it as the head", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      snooze("a", iso(T0 + HOUR));
      heads = [];
      t = T0 + HOUR;
      const woken = repository.wakeScheduled("a", "system:mesh");
      expect(woken?.snoozedUntil).toBeNull();
      expect(heads).toEqual([{ ownerId: "actor-a", headId: "a" }]);
    });
  });

  describe("dependencies are untouched", () => {
    it("a snoozed child keeps blocking its parent, and expiry does not satisfy it", () => {
      repository.create({ title: "parent", id: "parent", ownerId: "actor-a" });
      repository.create({ title: "kid", id: "kid", ownerId: "actor-b", parentId: "parent" });
      snooze("kid", iso(T0 + HOUR), "actor-b");
      expect(repository.require("parent").status).toBe("waiting");
      t = T0 + HOUR;
      repository.wakeScheduled("kid", "system:mesh");
      expect(repository.require("kid").status).toBe("ready");
      expect(repository.require("parent").status).toBe("waiting");
    });

    it("a snoozed prerequisite keeps its dependent waiting", () => {
      repository.create({ title: "gate", id: "gate", ownerId: "actor-b" });
      repository.create({ title: "dep", id: "dep", ownerId: "actor-a", blockedBy: ["gate"] });
      snooze("gate", iso(T0 + HOUR), "actor-b");
      expect(repository.require("dep").status).toBe("waiting");
      t = T0 + HOUR;
      expect(repository.expireDueSnoozes(["gate"])).toEqual(["gate"]);
      expect(repository.require("dep").status).toBe("waiting");
    });

    it("a blocker resolving during the snooze readies the row without attention until expiry", () => {
      repository.create({ title: "gate", id: "gate", ownerId: "actor-b" });
      repository.create({
        title: "dep",
        id: "dep",
        ownerId: "actor-a",
        blockedBy: ["gate"],
        responsive: true,
      });
      snooze("dep", iso(T0 + HOUR));
      heads = [];
      responsive = [];

      repository.setTerminalStatus("gate", "done", null, null, "actor-b");

      expect(repository.require("dep").status).toBe("ready");
      expect(heads.filter((h) => h.ownerId === "actor-a")).toEqual([]);
      expect(responsive).toEqual([]);
      expect(repository.readyHeads().has("actor-a")).toBe(false);

      t = T0 + HOUR;
      repository.wakeScheduled("dep", "system:mesh");
      expect(heads.filter((h) => h.ownerId === "actor-a")).toEqual([
        { ownerId: "actor-a", headId: "dep" },
      ]);
    });

    it("a waiting row whose snooze ends stays waiting", () => {
      repository.create({ title: "parent", id: "parent", ownerId: "actor-a" });
      repository.create({ title: "kid", id: "kid", ownerId: "actor-b", parentId: "parent" });
      snooze("parent", iso(T0 + HOUR));
      const before = repository.require("parent").readyCount;
      t = T0 + HOUR;
      const woken = repository.wakeScheduled("parent", "system:mesh");
      expect(woken?.status).toBe("waiting");
      expect(woken?.snoozedUntil).toBeNull();
      expect(woken?.readyCount).toBe(before);
    });
  });

  describe("the single timer", () => {
    it("replaces a cron job with one `at` job at the deadline, and restores it on clear", () => {
      repository.create({ title: "c", id: "c", ownerId: "actor-a" });
      repository.setRecurrence("c", { policy: "cron", cronExpr: "0 * * * *" }, "actor-a");
      expect(scheduler.activations.get("c")).toEqual({ kind: "cron", cronExpr: "0 * * * *" });
      snooze("c", iso(T0 + 3 * HOUR));
      expect(scheduler.activations.get("c")).toEqual({ kind: "at", date: new Date(T0 + 3 * HOUR) });
      snooze("c", null);
      expect(scheduler.activations.get("c")).toEqual({ kind: "cron", cronExpr: "0 * * * *" });
    });

    it("arms `at` for a plain obligation and cancels it on clear", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      snooze("a", iso(T0 + HOUR));
      expect(scheduler.activations.get("a")).toEqual({ kind: "at", date: new Date(T0 + HOUR) });
      snooze("a", null);
      expect(scheduler.activations.has("a")).toBe(false);
    });

    it("ignores early, stale, and duplicate callbacks and honors minute granularity", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      // A deadline mid-minute is due at the start of that minute, when `at` fires.
      const until = T0 + HOUR + 30_000;
      snooze("a", iso(until));
      const before = repository.require("a").readyCount;

      t = T0 + HOUR - 1;
      expect(repository.wakeScheduled("a", "system:mesh")?.snoozedUntil).toBe(iso(until));

      t = T0 + HOUR;
      expect(repository.wakeScheduled("a", "system:mesh")?.snoozedUntil).toBeNull();
      expect(repository.require("a").readyCount).toBe(before + 1);

      repository.wakeScheduled("a", "system:mesh");
      expect(repository.require("a").readyCount).toBe(before + 1);
    });

    it("an extension leaves the superseded job harmless", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      snooze("a", iso(T0 + HOUR));
      snooze("a", iso(T0 + 2 * HOUR));
      expect(scheduler.activations.get("a")).toEqual({ kind: "at", date: new Date(T0 + 2 * HOUR) });
      t = T0 + HOUR;
      expect(repository.wakeScheduled("a", "system:mesh")?.snoozedUntil).toBe(iso(T0 + 2 * HOUR));
    });

    it("completion_interval: missed occurrences coalesce into one at expiry", () => {
      intervalScheduled();
      expect(repository.require("rec").nextReadyAt).toBe(iso(T0 + HOUR));
      snooze("rec", iso(T0 + 3 * HOUR));
      expect(scheduler.activations.get("rec")).toEqual({
        kind: "at",
        date: new Date(T0 + 3 * HOUR),
      });
      const before = repository.require("rec").readyCount;

      // The occurrence's own time passes while snoozed: nothing activates.
      t = T0 + HOUR;
      expect(repository.wakeScheduled("rec", "system:mesh")?.status).toBe("scheduled");

      t = T0 + 3 * HOUR;
      const woken = repository.wakeScheduled("rec", "system:mesh");
      expect(woken?.status).toBe("ready");
      expect(woken?.snoozedUntil).toBeNull();
      expect(woken?.readyCount).toBe(before + 1);
      expect(scheduler.activations.has("rec")).toBe(false);

      repository.wakeScheduled("rec", "system:mesh");
      expect(repository.require("rec").readyCount).toBe(before + 1);
    });

    it("completion_interval: expiry does not pull a future occurrence forward", () => {
      intervalScheduled();
      snooze("rec", iso(T0 + 30 * MIN));
      t = T0 + 30 * MIN;
      const woken = repository.wakeScheduled("rec", "system:mesh");
      expect(woken?.status).toBe("scheduled");
      expect(woken?.snoozedUntil).toBeNull();
      expect(scheduler.activations.get("rec")).toEqual({ kind: "at", date: new Date(T0 + HOUR) });
    });

    it("cron: completing during a snooze keeps it, and missed ticks coalesce at expiry", () => {
      repository.create({ title: "c", id: "c", ownerId: "actor-a" });
      repository.setRecurrence("c", { policy: "cron", cronExpr: "0 * * * *" }, "actor-a");
      snooze("c", iso(T0 + 5 * HOUR));
      repository.setTerminalStatus("c", "done", null, null, "actor-a");
      const completed = repository.require("c");
      expect(completed.status).toBe("scheduled");
      expect(completed.snoozedUntil).toBe(iso(T0 + 5 * HOUR));
      expect(scheduler.activations.get("c")).toEqual({ kind: "at", date: new Date(T0 + 5 * HOUR) });
      const before = completed.readyCount;

      // A stray cron tick mid-snooze does nothing.
      t = T0 + 2 * HOUR;
      expect(repository.wakeScheduled("c", "system:mesh")?.status).toBe("scheduled");

      t = T0 + 5 * HOUR;
      const woken = repository.wakeScheduled("c", "system:mesh");
      expect(woken?.status).toBe("ready");
      expect(woken?.readyCount).toBe(before + 1);
      expect(scheduler.activations.get("c")).toEqual({ kind: "cron", cronExpr: "0 * * * *" });
    });

    it("a cron tick whose occurrence is not yet due does not activate", () => {
      repository.create({ title: "c", id: "c", ownerId: "actor-a" });
      repository.setRecurrence("c", { policy: "cron", cronExpr: "0 * * * *" }, "actor-a");
      repository.setTerminalStatus("c", "done", null, null, "actor-a");
      const next = Date.parse(repository.require("c").nextReadyAt as string);
      t = next - MIN;
      expect(repository.wakeScheduled("c", "system:mesh")?.status).toBe("scheduled");
      t = next;
      expect(repository.wakeScheduled("c", "system:mesh")?.status).toBe("ready");
    });
  });

  describe("timer availability", () => {
    beforeEach(() => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
    });

    it("refuses to snooze before writing when `at` is known unavailable", () => {
      scheduler.atAvailable = false;
      expect(() => snooze("a", iso(T0 + HOUR))).toThrow(/no working `at` scheduler/);
      expect(repository.require("a").snoozedUntil).toBeNull();
      expect(repository.listHistory("a").some((h) => h.mutationKind === "snooze")).toBe(false);
    });

    it("surfaces a post-commit timer failure as scheduleError", () => {
      scheduler.failAt = true;
      const result = repository.setSnooze("a", iso(T0 + HOUR), "actor-a");
      expect(result.obligation.snoozedUntil).toBe(iso(T0 + HOUR));
      expect(result.scheduleError).toMatch(/queue write failed/);
      scheduler.failAt = false;
      expect(repository.setSnooze("a", iso(T0 + 2 * HOUR), "actor-a").scheduleError).toBeNull();
    });
  });

  describe("terminal transitions", () => {
    it("final done and cancel clear the snooze and its timer", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      repository.create({ title: "b", id: "b", ownerId: "actor-a" });
      snooze("a", iso(T0 + HOUR));
      snooze("b", iso(T0 + HOUR));
      expect(
        repository.setTerminalStatus("a", "done", null, null, "actor-a").snoozedUntil
      ).toBeNull();
      expect(
        repository.setTerminalStatus("b", "cancelled", null, null, "actor-a").snoozedUntil
      ).toBeNull();
      expect(scheduler.activations.size).toBe(0);
    });

    it("disabling recurrence on a scheduled row clears the snooze", () => {
      intervalScheduled();
      snooze("rec", iso(T0 + 3 * HOUR));
      const done = repository.setRecurrence("rec", null, "actor-a");
      expect(done.status).toBe("done");
      expect(done.snoozedUntil).toBeNull();
      expect(scheduler.activations.has("rec")).toBe(false);
    });
  });

  describe("boot reconciliation", () => {
    it("settles an overdue snooze exactly once and re-arms a live one", () => {
      repository.create({ title: "late", id: "late", ownerId: "actor-a" });
      repository.create({ title: "live", id: "live", ownerId: "actor-a" });
      snooze("late", iso(T0 + HOUR));
      snooze("live", iso(T0 + 5 * HOUR));
      const before = repository.require("late").readyCount;
      scheduler.activations.clear();

      t = T0 + 2 * HOUR;
      repository.reconcileScheduledObligations();
      repository.reconcileScheduledObligations();

      expect(repository.require("late").snoozedUntil).toBeNull();
      expect(repository.require("late").readyCount).toBe(before + 1);
      expect(scheduler.activations.has("late")).toBe(false);
      expect(scheduler.activations.get("live")).toEqual({
        kind: "at",
        date: new Date(T0 + 5 * HOUR),
      });
    });

    it("activates a scheduled occurrence an overdue snooze was holding back", () => {
      intervalScheduled();
      snooze("rec", iso(T0 + 3 * HOUR));
      scheduler.activations.clear();
      t = T0 + 4 * HOUR;
      repository.reconcileScheduledObligations();
      expect(repository.require("rec").status).toBe("ready");
      expect(repository.require("rec").snoozedUntil).toBeNull();
    });
  });

  describe("expireDueSnoozes", () => {
    it("clears only due snoozes and reports them", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      repository.create({ title: "b", id: "b", ownerId: "actor-a" });
      repository.create({ title: "c", id: "c", ownerId: "actor-a" });
      snooze("a", iso(T0 + HOUR));
      snooze("b", iso(T0 + 3 * HOUR));
      t = T0 + 2 * HOUR;
      expect(repository.expireDueSnoozes(["a", "b", "c", "missing", "a"])).toEqual(["a"]);
      expect(repository.require("b").snoozedUntil).toBe(iso(T0 + 3 * HOUR));
      expect(
        repository.listHistory("a").find((h) => h.mutationKind === "snooze")?.actingPrincipal
      ).toBe("system:mesh");
    });
  });
});
