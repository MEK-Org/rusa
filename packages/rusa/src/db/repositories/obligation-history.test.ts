import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
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
import { ObligationRepository } from "./obligation-repository.js";

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
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
  return db;
}

/**
 * Count the obligation rows a repository call actually materializes in JS.
 *
 * History capture must cost what the mutation changed, not what the mesh
 * currently holds, so the assertion that matters is a row tally that stays
 * flat as the active set grows.
 */
function instrumentObligationReads(db: Database.Database): {
  db: Database.Database;
  tally: { rows: number };
} {
  const tally = { rows: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/from\s+obligations\b/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, innerProp) {
            const innerValue = Reflect.get(inner, innerProp, inner);
            if (innerProp === "all") {
              return (...args: unknown[]) => {
                const rows = (inner.all as (...a: unknown[]) => unknown[])(...args);
                tally.rows += rows.length;
                return rows;
              };
            }
            if (innerProp === "get") {
              return (...args: unknown[]) => {
                const row = (inner.get as (...a: unknown[]) => unknown)(...args);
                if (row !== undefined) tally.rows += 1;
                return row;
              };
            }
            return typeof innerValue === "function" ? innerValue.bind(inner) : innerValue;
          },
        }) as typeof statement;
      };
    },
  });
  return { db: proxy, tally };
}

describe("Obligation mutation history", () => {
  let db: Database.Database;
  let repository: ObligationRepository;
  let now: number;

  beforeEach(() => {
    db = migratedDb();

    now = Date.parse("2026-09-09T12:00:00.000Z");
    repository = new ObligationRepository(
      db,
      (id) => ["actor-a", "actor-b", "actor-c"].includes(id),
      () => now
    );
  });

  describe("transactional atomicity and rollback", () => {
    it("rolls back history if the mutation transaction throws", () => {
      const ob = repository.create({
        title: "Test Obligation",
        ownerId: "actor-a",
      });

      // Attempt an invalid reparent (self-parenting throws)
      expect(() => {
        repository.reparent(ob.id, ob.id, "actor-a");
      }).toThrow();

      const page = repository.listHistory(ob.id);
      expect(page.length).toBe(0);
      expect(page).toHaveLength(0);
    });

    it("writes history in the same transaction as successful mutation", () => {
      const ob = repository.create({
        title: "Test Obligation",
        ownerId: "actor-a",
      });

      repository.reassign(ob.id, "actor-b", "actor-a");

      const page = repository.listHistory(ob.id);
      expect(page.length).toBe(1);
      expect(page[0]).toMatchObject({
        obligationId: ob.id,
        mutationKind: "reassign",
        actingPrincipal: "actor-a",
        before: { ownerId: "actor-a" },
        after: { ownerId: "actor-b" },
      });
    });

    it("fails closed against re-entrant mutate calls to protect capture seam", () => {
      const ob = repository.create({
        title: "Test Obligation",
        ownerId: "actor-a",
      });

      expect(() => {
        (repository as unknown as { mutate: (principal: string, work: () => void) => void }).mutate(
          "system:mesh",
          () => {
            repository.reassign(ob.id, "actor-b", "system:mesh");
          }
        );
      }).toThrow("ObligationRepository.mutate cannot be called re-entrantly");

      const history = repository.listHistory(ob.id);
      expect(history).toHaveLength(0);
      expect(repository.get(ob.id)?.ownerId).toBe("actor-a");
    });

    it("fails loudly when a tracked-column write occurs outside mutate", () => {
      const ob = repository.create({
        title: "Test Obligation",
        ownerId: "actor-a",
      });

      // Directly update a tracked column outside mutate(), populating obligation_history_delta
      db.prepare("UPDATE obligations SET owner_id = 'actor-c' WHERE id = ?").run(ob.id);

      // The next mutate() call must fail loudly rather than silently discarding or misattributing the write
      expect(() => {
        repository.reassign(ob.id, "actor-b", "actor-a");
      }).toThrow(/uncommitted obligation_history_delta rows outside mutate/);
    });
  });

  describe("no-ops record no history", () => {
    it("does not record history on no-op reassign", () => {
      const ob = repository.create({
        title: "Test Obligation",
        ownerId: "actor-a",
      });

      repository.reassign(ob.id, "actor-a", "actor-a");
      const page = repository.listHistory(ob.id);
      expect(page.length).toBe(0);
    });

    it("does not record history on no-op setExternalRef", () => {
      const ob = repository.create({
        title: "Test Obligation",
        ownerId: "actor-a",
        externalRef: "github:MEK-Org/rusa/issues/185",
      });

      repository.setExternalRef(ob.id, "github:MEK-Org/rusa/issues/185", "actor-a");
      const page = repository.listHistory(ob.id);
      expect(page.length).toBe(0);
    });

    it("does not record history on no-op reparent to same parent", () => {
      const parent = repository.create({ title: "Parent", ownerId: "actor-a" });
      const child = repository.create({ title: "Child", ownerId: "actor-a", parentId: parent.id });

      repository.reparent(child.id, parent.id, "actor-a");
      const page = repository.listHistory(child.id);
      expect(page.length).toBe(0);
    });
  });

  describe("direct mutation coverage", () => {
    it("records reassign mutation with prior and new owner", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });
      now += 1000;
      repository.reassign(ob.id, "actor-b", "actor-a");

      const page = repository.listHistory(ob.id);
      expect(page.length).toBe(1);
      expect(page[0]).toMatchObject({
        obligationId: ob.id,
        mutationKind: "reassign",
        actingPrincipal: "actor-a",
        timestamp: new Date(now).toISOString(),
        before: { ownerId: "actor-a" },
        after: { ownerId: "actor-b" },
      });
    });

    it("records reparent mutation with prior and new parent", () => {
      const parent1 = repository.create({ title: "P1", ownerId: "actor-a" });
      const parent2 = repository.create({ title: "P2", ownerId: "actor-a" });
      const child = repository.create({ title: "C", ownerId: "actor-a", parentId: parent1.id });

      now += 1000;
      repository.reparent(child.id, parent2.id, "actor-a");

      const page = repository.listHistory(child.id);
      expect(page[0]).toMatchObject({
        obligationId: child.id,
        mutationKind: "reparent",
        actingPrincipal: "actor-a",
        before: { parentId: parent1.id },
        after: { parentId: parent2.id },
      });
    });

    it("records explicit priority change", () => {
      const ob = repository.create({ title: "Prio", ownerId: "actor-a", priority: 10 });
      now += 1000;
      repository.setPriorityInternal(ob.id, 25, "actor-a", "self");

      const page = repository.listHistory(ob.id);
      expect(page[0]).toMatchObject({
        obligationId: ob.id,
        mutationKind: "priority",
        actingPrincipal: "actor-a",
        before: { priority: 10 },
        after: { priority: 25 },
      });
    });

    it("records reorder in queue", () => {
      const first = repository.create({ title: "First", ownerId: "actor-a", priority: 10 });
      const second = repository.create({ title: "Second", ownerId: "actor-a", priority: 20 });
      const third = repository.create({ title: "Third", ownerId: "actor-a", priority: 30 });

      now += 1000;
      repository.reorder(third.id, first.id, second.id, "actor-a", "subtree");

      const page = repository.listHistory(third.id);
      expect(page[0]).toMatchObject({
        obligationId: third.id,
        mutationKind: "priority",
        actingPrincipal: "actor-a",
        before: { priority: 30 },
        after: { priority: 15 },
      });
    });

    it("records terminal status change (done / cancelled)", () => {
      const ob = repository.create({ title: "Status Task", ownerId: "actor-a" });
      now += 1000;
      repository.setTerminalStatus(ob.id, "done", "Finished work", "mesh:messages/123", "actor-a");

      const page = repository.listHistory(ob.id);
      expect(page[0]).toMatchObject({
        obligationId: ob.id,
        mutationKind: "status",
        actingPrincipal: "actor-a",
        before: { status: "ready" },
        after: { status: "done" },
      });
    });

    it("records external ref link, change, and unlink", () => {
      const ob = repository.create({ title: "Issue Task", ownerId: "actor-a" });
      now += 1000;
      repository.setExternalRef(ob.id, "github:MEK-Org/rusa/issues/185", "actor-a");

      let page = repository.listHistory(ob.id);
      expect(page[0]).toMatchObject({
        obligationId: ob.id,
        mutationKind: "external_ref",
        actingPrincipal: "actor-a",
        before: { externalRef: null },
        after: { externalRef: "github:MEK-Org/rusa/issues/185" },
      });

      now += 1000;
      repository.setExternalRef(ob.id, null, "actor-a");
      page = repository.listHistory(ob.id);
      expect(page[0]).toMatchObject({
        obligationId: ob.id,
        mutationKind: "external_ref",
        actingPrincipal: "actor-a",
        before: { externalRef: "github:MEK-Org/rusa/issues/185" },
        after: { externalRef: null },
      });
    });
  });

  describe("collateral mutation coverage", () => {
    it("records collateral parent readiness transition when child completes", () => {
      const parent = repository.create({ title: "Parent", ownerId: "actor-a" });
      const child = repository.create({ title: "Child", ownerId: "actor-a", parentId: parent.id });

      expect(repository.require(parent.id).status).toBe("waiting");

      now += 1000;
      repository.setTerminalStatus(child.id, "done", "done note", null, "actor-b");

      expect(repository.require(parent.id).status).toBe("ready");

      const parentHistory = repository.listHistory(parent.id);
      expect(parentHistory.length).toBe(2);
      expect(parentHistory[0]).toMatchObject({
        obligationId: parent.id,
        mutationKind: "status",
        actingPrincipal: "actor-b",
        before: { status: "waiting" },
        after: { status: "ready" },
      });
      expect(parentHistory[1]).toMatchObject({
        obligationId: parent.id,
        mutationKind: "status",
        actingPrincipal: "system:mesh",
        before: { status: "ready" },
        after: { status: "waiting" },
      });
    });

    it("records collateral collision repair in queue reorder", () => {
      const a = repository.create({ id: "a", title: "A", ownerId: "actor-a", priority: 1e308 });
      const b = repository.create({ id: "b", title: "B", ownerId: "actor-a", priority: 1e308 });
      const c = repository.create({ id: "c", title: "C", ownerId: "actor-a", priority: 1e308 });
      const target = repository.create({
        id: "target",
        title: "Target",
        ownerId: "actor-a",
        priority: 1.5e308,
      });

      now += 1000;
      repository.reorder(target.id, a.id, b.id, "actor-a", "subtree");

      const targetHistory = repository.listHistory(target.id);
      expect(targetHistory.length).toBe(1);
      expect(targetHistory[0]).toMatchObject({
        obligationId: target.id,
        mutationKind: "priority",
        actingPrincipal: "actor-a",
      });

      const bHistory = repository.listHistory(b.id);
      expect(bHistory.length).toBe(1);
      expect(bHistory[0]).toMatchObject({
        obligationId: b.id,
        mutationKind: "priority",
        actingPrincipal: "actor-a",
      });

      const cHistory = repository.listHistory(c.id);
      expect(cHistory.length).toBe(1);
      expect(cHistory[0]).toMatchObject({
        obligationId: c.id,
        mutationKind: "priority",
        actingPrincipal: "actor-a",
      });
    });

    it("records a terminal descendant whose stored priority a subtree move clears", () => {
      const parent = repository.create({ title: "Parent", ownerId: "actor-a", priority: 10 });
      const child = repository.create({
        title: "Closed child",
        ownerId: "actor-a",
        parentId: parent.id,
        priority: 30,
      });
      repository.setTerminalStatus(child.id, "done", null, null, "actor-a");

      now += 1000;
      repository.setPriorityInternal(parent.id, 5, "actor-b", "subtree");

      expect(repository.require(child.id).priority).toBeNull();
      const childHistory = repository.listHistory(child.id);
      expect(childHistory.length).toBe(2);
      expect(childHistory[0]).toMatchObject({
        obligationId: child.id,
        mutationKind: "priority",
        actingPrincipal: "actor-b",
        before: { priority: 30 },
        after: { priority: null },
      });
    });

    it("records a terminal direct child materialized by a self priority move", () => {
      const parent = repository.create({ title: "Parent", ownerId: "actor-a", priority: 10 });
      const child = repository.create({
        title: "Closed child",
        ownerId: "actor-a",
        parentId: parent.id,
      });
      db.prepare("UPDATE obligations SET priority = NULL WHERE id = ?").run(child.id);
      db.prepare("DELETE FROM obligation_history_delta").run();
      repository.setTerminalStatus(child.id, "done", null, null, "actor-a");

      now += 1000;
      repository.setPriorityInternal(parent.id, 5, "actor-b", "self");

      expect(repository.require(child.id).priority).toBe(10);
      const childHistory = repository.listHistory(child.id);
      expect(childHistory.length).toBe(2);
      expect(childHistory[0]).toMatchObject({
        obligationId: child.id,
        mutationKind: "priority",
        actingPrincipal: "actor-b",
        before: { priority: null },
        after: { priority: 10 },
      });
    });

    it("records collateral dependent release on prerequisite removal", () => {
      const prereq = repository.create({ title: "Prereq", ownerId: "actor-a" });
      const dep = repository.create({
        title: "Dependent",
        ownerId: "actor-a",
        blockedBy: [prereq.id],
      });

      expect(repository.require(dep.id).status).toBe("waiting");

      now += 1000;
      repository.removePrerequisite(dep.id, prereq.id, "actor-a");

      expect(repository.require(dep.id).status).toBe("ready");

      const depHistory = repository.listHistory(dep.id);
      expect(depHistory.length).toBe(1);
      expect(depHistory[0]).toMatchObject({
        obligationId: dep.id,
        mutationKind: "status",
        actingPrincipal: "actor-a",
        before: { status: "waiting" },
        after: { status: "ready" },
      });
    });

    it("records collateral owner reassignment during retirement inheritance", () => {
      const ob1 = repository.create({ title: "Ob 1", ownerId: "actor-a" });
      const ob2 = repository.create({ title: "Ob 2", ownerId: "actor-a" });

      now += 1000;
      repository.inheritRetiringActorObligationsInternal("actor-a", "actor-b", "system:mesh");

      const h1 = repository.listHistory(ob1.id);
      expect(h1.length).toBe(1);
      expect(h1[0]).toMatchObject({
        obligationId: ob1.id,
        mutationKind: "reassign",
        actingPrincipal: "system:mesh",
        before: { ownerId: "actor-a" },
        after: { ownerId: "actor-b" },
      });

      const h2 = repository.listHistory(ob2.id);
      expect(h2.length).toBe(1);
      expect(h2[0]).toMatchObject({
        obligationId: ob2.id,
        mutationKind: "reassign",
        actingPrincipal: "system:mesh",
        before: { ownerId: "actor-a" },
        after: { ownerId: "actor-b" },
      });
    });
  });

  describe("sequence and deterministic ordering", () => {
    it("returns history entries in deterministic newest-first order", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });

      now += 1000;
      repository.reassign(ob.id, "actor-b", "principal-1");
      now += 1000;
      repository.setExternalRef(ob.id, "github:MEK-Org/rusa/issues/185", "principal-2");
      now += 1000;
      repository.setPriorityInternal(ob.id, 99, "principal-3", "self");

      const page = repository.listHistory(ob.id);
      expect(page.length).toBe(3);
      expect(page.map((e) => e.mutationKind)).toEqual(["priority", "external_ref", "reassign"]);
      expect(page.map((e) => e.actingPrincipal)).toEqual([
        "principal-3",
        "principal-2",
        "principal-1",
      ]);
    });

    it("guarantees monotonic ordering when multiple mutations execute in the same millisecond", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });

      repository.reassign(ob.id, "actor-b", "principal-1");
      repository.setExternalRef(ob.id, "github:MEK-Org/rusa/issues/185", "principal-2");
      repository.setPriorityInternal(ob.id, 99, "principal-3");

      const entries = repository.listHistory(ob.id);
      expect(entries).toHaveLength(3);
      expect(entries[0].actingPrincipal).toBe("principal-3");
      expect(entries[1].actingPrincipal).toBe("principal-2");
      expect(entries[2].actingPrincipal).toBe("principal-1");
      expect(entries[0].id).toBeGreaterThan(entries[1].id);
      expect(entries[1].id).toBeGreaterThan(entries[2].id);
    });
  });

  describe("write cost", () => {
    /** Rows read while performing `work` on a repository holding `activeCount` live obligations. */
    function obligationRowsRead(
      activeCount: number,
      work: (r: ObligationRepository) => void
    ): number {
      const raw = migratedDb();
      const { db: instrumented, tally } = instrumentObligationReads(raw);
      const clock = Date.parse("2026-09-09T12:00:00.000Z");
      const repo = new ObligationRepository(
        instrumented,
        (id) => ["actor-a", "actor-b", "actor-c"].includes(id),
        () => clock
      );
      repo.create({ id: "target", title: "Target", ownerId: "actor-a" });
      for (let i = 0; i < activeCount; i += 1) {
        repo.create({ id: `filler-${i}`, title: `Filler ${i}`, ownerId: "actor-b" });
      }
      tally.rows = 0;
      work(repo);
      return tally.rows;
    }

    it("costs the same for a checkpoint write whether the mesh holds 5 or 200 live obligations", () => {
      const small = obligationRowsRead(5, (repo) =>
        repo.setCheckpoint("target", "standing", "actor-a")
      );
      const large = obligationRowsRead(200, (repo) =>
        repo.setCheckpoint("target", "standing", "actor-a")
      );

      expect(large).toBe(small);
    });

    it("costs the same for a single reassign whether the mesh holds 5 or 200 live obligations", () => {
      const small = obligationRowsRead(5, (repo) => repo.reassign("target", "actor-c", "actor-a"));
      const large = obligationRowsRead(200, (repo) =>
        repo.reassign("target", "actor-c", "actor-a")
      );

      expect(large).toBe(small);
    });
  });

  describe("boundary attribution on create", () => {
    it("attributes a parent readiness demotion to the server-bound creator, not the mesh", () => {
      const parent = repository.create({ title: "Parent", ownerId: "actor-a" });

      now += 1000;
      repository.create({
        title: "Child",
        ownerId: "actor-a",
        parentId: parent.id,
        creatorId: "actor-c",
      });

      const parentHistory = repository.listHistory(parent.id);
      expect(parentHistory.length).toBe(1);
      expect(parentHistory[0]).toMatchObject({
        mutationKind: "status",
        actingPrincipal: "actor-c",
        before: { status: "ready" },
        after: { status: "waiting" },
      });
    });

    it("records an honest system principal when the creating surface binds no identity", () => {
      const parent = repository.create({ title: "Parent", ownerId: "actor-a" });

      now += 1000;
      repository.create({ title: "Child", ownerId: "actor-a", parentId: parent.id });

      const parentHistory = repository.listHistory(parent.id);
      expect(parentHistory[0].actingPrincipal).toBe("system:mesh");
    });
  });

  describe("scalar row validation", () => {
    it("rejects a history row whose mutation kind is not a known kind", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });

      db.prepare(
        `INSERT INTO obligation_history (obligation_id, mutation_kind, acting_principal, timestamp, payload)
         VALUES (?, 'not-a-kind', 'actor-a', '2026-09-09T12:00:00.000Z', '{"schemaVersion":1,"before":{},"after":{}}')`
      ).run(ob.id);

      expect(() => repository.listHistory(ob.id)).toThrow(ObligationValidationError);
    });

    it("rejects a history row whose timestamp is not an ISO-8601 instant", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });

      db.prepare(
        `INSERT INTO obligation_history (obligation_id, mutation_kind, acting_principal, timestamp, payload)
         VALUES (?, 'reassign', 'actor-a', 'yesterday', '{"schemaVersion":1,"before":{},"after":{}}')`
      ).run(ob.id);

      expect(() => repository.listHistory(ob.id)).toThrow(ObligationValidationError);
    });
  });

  describe("versioned payload validation", () => {
    it("validates payload schema in consuming code and throws on malformed JSON", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });

      db.prepare(
        `INSERT INTO obligation_history (obligation_id, mutation_kind, acting_principal, timestamp, payload)
         VALUES (?, 'reassign', 'actor-a', '2026-09-09T12:00:00.000Z', 'corrupted-json')`
      ).run(ob.id);

      expect(() => repository.listHistory(ob.id)).toThrow(ObligationValidationError);
    });

    it("throws on unsupported payload schemaVersion in consuming code", () => {
      const ob = repository.create({ title: "Task", ownerId: "actor-a" });

      db.prepare(
        `INSERT INTO obligation_history (obligation_id, mutation_kind, acting_principal, timestamp, payload)
         VALUES (?, 'reassign', 'actor-a', '2026-09-09T12:00:00.000Z', '{"schemaVersion":999,"before":{},"after":{}}')`
      ).run(ob.id);

      expect(() => repository.listHistory(ob.id)).toThrow(ObligationValidationError);
    });
  });
});
