import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { obligations } from "../migrations/0016_obligations.js";
import { obligationPriority } from "../migrations/0017_obligation_priority.js";
import { ObligationRepository } from "./obligation-repository.js";

describe("ObligationRepository", () => {
  let db: Database.Database;
  let repository: ObligationRepository;
  let now: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);
    now = 1_000;
    repository = new ObligationRepository(
      db,
      (id) => ["actor-a", "actor-b", "actor-c"].includes(id),
      () => now++
    );
  });

  it("represents exactly one validated owner while treating human ids as opaque handles", () => {
    const actorOwned = repository.create({
      id: "actor-work",
      owner: { kind: "actor", id: "actor-a" },
      intent: "ship the slice",
    });
    const humanOwned = repository.create({
      id: "human-work",
      owner: { kind: "human", id: "human:operator" },
    });

    expect(actorOwned.owner).toEqual({ kind: "actor", id: "actor-a" });
    expect(humanOwned.owner).toEqual({ kind: "human", id: "human:operator" });
    expect(() =>
      repository.create({ id: "missing-actor", owner: { kind: "actor", id: "unknown" } })
    ).toThrow("actor owner does not exist");
    expect(() =>
      repository.create({ id: "empty-human", owner: { kind: "human", id: " " } })
    ).toThrow("owner id is required");
    expect(() =>
      repository.create({
        id: "invalid-kind",
        owner: { kind: "team", id: "actor-a" } as never,
      })
    ).toThrow("owner kind must be actor or human");
  });

  it("validates one supported external ref, enforces live uniqueness, and permits terminal reuse", () => {
    const original = repository.create({
      id: "original",
      owner: { kind: "actor", id: "actor-a" },
      externalRef: "github_issue:dummy-org/dummy-repo#1485",
    });
    expect(original.externalRef).toMatchObject({
      kind: "github_issue",
      owner: "dummy-org",
      repo: "dummy-repo",
      number: 1485,
    });

    expect(() =>
      repository.create({
        id: "duplicate",
        owner: { kind: "actor", id: "actor-b" },
        externalRef: "github_issue:dummy-org/dummy-repo#1485",
      })
    ).toThrow("already uses external ref");
    expect(() =>
      repository.create({
        id: "bad-ref",
        owner: { kind: "actor", id: "actor-a" },
        externalRef: "https://github.com/dummy-org/dummy-repo/issues/1485",
      })
    ).toThrow("external ref must be");
    expect(() =>
      repository.create({
        id: "oversized-owner",
        owner: { kind: "actor", id: "actor-a" },
        externalRef: `github_issue:${"a".repeat(40)}/rusa#1`,
      })
    ).toThrow("external ref owner cannot exceed 39 characters");
    expect(() =>
      repository.create({
        id: "oversized-repo",
        owner: { kind: "actor", id: "actor-a" },
        externalRef: `github_issue:dummy-org/${"b".repeat(101)}#1`,
      })
    ).toThrow("external ref repository cannot exceed 100 characters");

    const maxBounds = repository.create({
      id: "max-bounds",
      owner: { kind: "actor", id: "actor-a" },
      externalRef: `github_issue:${"a".repeat(39)}/${"b".repeat(100)}#1`,
    });
    expect(maxBounds.externalRef).toMatchObject({
      owner: "a".repeat(39),
      repo: "b".repeat(100),
    });

    repository.setTerminalStatus("original", "done");
    repository.setTerminalStatus("max-bounds", "done");
    expect(
      repository.create({
        id: "successor",
        owner: { kind: "actor", id: "actor-b" },
        externalRef: "github_issue:dummy-org/dummy-repo#1485",
      }).status
    ).toBe("ready");
  });

  it("blocks a parent on live children and re-readies at its retained priority", () => {
    repository.create({ id: "first", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "parent", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "third", owner: { kind: "actor", id: "actor-a" } });
    repository.setPriorityInternal("third", 100);
    repository.setPriorityInternal("parent", 200);
    repository.setPriorityInternal("first", 300);
    repository.create({
      id: "child",
      parentId: "parent",
      owner: { kind: "actor", id: "actor-b" },
      intent: "review the parent artifact",
    });

    expect(repository.require("parent").status).toBe("waiting");
    expect(
      repository.listOwned({ kind: "actor", id: "actor-a" }, { status: "ready" }).map((o) => o.id)
    ).toEqual(["third", "first"]);
    expect(repository.getTree("parent").blockingChildren.map((o) => o.id)).toEqual(["child"]);

    repository.setTerminalStatus("child", "done");

    expect(repository.require("parent").status).toBe("ready");
    expect(
      repository.listOwned({ kind: "actor", id: "actor-a" }, { status: "ready" }).map((o) => o.id)
    ).toEqual(["third", "parent", "first"]);
    expect(repository.getTree("parent").blockingChildren).toEqual([]);
  });

  it("rejects invalid, nonadjacent, cross-owner, and non-ready priority moves", () => {
    repository.create({ id: "first", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "second", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "foreign", owner: { kind: "actor", id: "actor-b" } });

    expect(() => repository.movePriorityInternal("second", "foreign", null)).toThrow(
      "neighbors must be adjacent ready obligations owned by the target owner"
    );
    expect(() => repository.movePriorityInternal("second", "first", "first")).toThrow(
      "neighbors must be adjacent"
    );
    repository.create({ id: "child", parentId: "first", owner: { kind: "actor", id: "actor-b" } });
    expect(() => repository.movePriorityInternal("first", null, "second")).toThrow(
      "only ready obligations can be reordered"
    );
    expect(() => repository.setPriorityInternal("second", Number.NaN)).toThrow(
      "priority must be finite"
    );
  });

  it("resolves nullable child priority through the nearest explicit ancestor", () => {
    repository.create({ id: "root", owner: { kind: "actor", id: "actor-a" }, priority: 10 });
    repository.create({ id: "child", parentId: "root", owner: { kind: "actor", id: "actor-b" } });
    repository.create({
      id: "override",
      parentId: "child",
      owner: { kind: "actor", id: "actor-c" },
      priority: 20,
    });
    repository.create({
      id: "leaf",
      parentId: "override",
      owner: { kind: "actor", id: "actor-a" },
    });

    expect(repository.require("child")).toMatchObject({
      priority: null,
      effectivePriority: 10,
      prioritySourceId: "root",
    });
    expect(repository.require("leaf")).toMatchObject({
      priority: null,
      effectivePriority: 20,
      prioritySourceId: "override",
    });
  });

  it("moves a subtree by clearing every descendant override", () => {
    repository.create({ id: "root", owner: { kind: "actor", id: "actor-a" }, priority: 10 });
    repository.create({
      id: "child",
      parentId: "root",
      owner: { kind: "actor", id: "actor-b" },
      priority: 20,
    });
    repository.create({
      id: "leaf",
      parentId: "child",
      owner: { kind: "actor", id: "actor-c" },
      priority: 30,
    });

    repository.setPriorityInternal("root", 5);

    for (const id of ["child", "leaf"]) {
      expect(repository.require(id)).toMatchObject({
        priority: null,
        effectivePriority: 5,
        prioritySourceId: "root",
      });
    }
  });

  it("materializes null direct-child branches for self moves until a later subtree move", () => {
    repository.create({ id: "root", owner: { kind: "actor", id: "actor-a" }, priority: 10 });
    repository.create({
      id: "inheriting",
      parentId: "root",
      owner: { kind: "actor", id: "actor-b" },
    });
    repository.create({
      id: "leaf",
      parentId: "inheriting",
      owner: { kind: "actor", id: "actor-c" },
    });
    repository.create({
      id: "explicit",
      parentId: "root",
      owner: { kind: "actor", id: "actor-b" },
      priority: 20,
    });

    repository.setPriorityInternal("root", 5, "self");
    expect(repository.require("root").effectivePriority).toBe(5);
    expect(repository.require("inheriting")).toMatchObject({ priority: 10, effectivePriority: 10 });
    expect(repository.require("leaf")).toMatchObject({ priority: null, effectivePriority: 10 });
    expect(repository.require("explicit")).toMatchObject({ priority: 20, effectivePriority: 20 });

    repository.setPriorityInternal("root", 1);
    for (const id of ["inheriting", "leaf", "explicit"]) {
      expect(repository.require(id)).toMatchObject({ priority: null, effectivePriority: 1 });
    }
  });

  it("uses midpoint moves and repairs equal-priority suffixes at +1 increments", () => {
    repository.create({ id: "a", owner: { kind: "actor", id: "actor-a" }, priority: 10 });
    repository.create({ id: "b", owner: { kind: "actor", id: "actor-a" }, priority: 20 });
    repository.create({ id: "c", owner: { kind: "actor", id: "actor-a" }, priority: 30 });
    repository.create({ id: "moved", owner: { kind: "actor", id: "actor-a" }, priority: 40 });

    expect(repository.movePriorityInternal("moved", "a", "b").effectivePriority).toBe(15);
    expect(
      repository.listOwned({ kind: "actor", id: "actor-a" }, { status: "ready" }).map((o) => o.id)
    ).toEqual(["a", "moved", "b", "c"]);

    repository.setPriorityInternal("a", 10);
    repository.setPriorityInternal("b", 10);
    repository.setPriorityInternal("c", 10);
    repository.setPriorityInternal("moved", 50);
    repository.movePriorityInternal("moved", "a", "b");
    expect(repository.require("moved").effectivePriority).toBe(11);
    expect(repository.require("b").effectivePriority).toBe(12);
    expect(repository.require("c").effectivePriority).toBe(13);
  });

  it("moves correctly across the full finite REAL magnitude range", () => {
    repository.create({ id: "low", owner: { kind: "actor", id: "actor-a" }, priority: -1e308 });
    repository.create({ id: "high", owner: { kind: "actor", id: "actor-a" }, priority: 1e308 });
    repository.create({ id: "moved", owner: { kind: "actor", id: "actor-a" }, priority: 0 });

    expect(repository.movePriorityInternal("moved", "low", "high").effectivePriority).toBe(0);
    expect(repository.movePriorityInternal("moved", null, "low").effectivePriority).toSatisfy(
      (priority: number) => Number.isFinite(priority) && priority < -1e308
    );
    expect(repository.movePriorityInternal("moved", "high", null).effectivePriority).toSatisfy(
      (priority: number) => Number.isFinite(priority) && priority > 1e308
    );
  });

  it("repairs large equal-priority bands using the next representable values", () => {
    repository.create({ id: "a", owner: { kind: "actor", id: "actor-a" }, priority: 1e308 });
    repository.create({ id: "b", owner: { kind: "actor", id: "actor-a" }, priority: 1e308 });
    repository.create({ id: "c", owner: { kind: "actor", id: "actor-a" }, priority: 1e308 });
    repository.create({ id: "moved", owner: { kind: "actor", id: "actor-a" }, priority: 1.5e308 });

    repository.movePriorityInternal("moved", "a", "b");
    const moved = repository.require("moved").effectivePriority;
    const b = repository.require("b").effectivePriority;
    const c = repository.require("c").effectivePriority;
    expect(Number.isFinite(moved)).toBe(true);
    expect(moved).toBeGreaterThan(1e308);
    expect(b).toBeGreaterThan(moved);
    expect(c).toBeGreaterThan(b);
  });

  it("keeps a parent waiting until every direct child is terminal", () => {
    repository.create({ id: "parent", owner: { kind: "actor", id: "actor-a" } });
    repository.create({
      id: "child-a",
      parentId: "parent",
      owner: { kind: "actor", id: "actor-b" },
    });
    repository.create({
      id: "child-b",
      parentId: "parent",
      owner: { kind: "human", id: "reviewer" },
    });

    repository.setTerminalStatus("child-a", "done");
    expect(repository.require("parent").status).toBe("waiting");
    repository.setTerminalStatus("child-b", "cancelled");
    expect(repository.require("parent").status).toBe("ready");
  });

  it("guards terminal transitions with live children and makes terminal state final", () => {
    repository.create({ id: "parent", owner: { kind: "actor", id: "actor-a" } });
    repository.create({
      id: "child",
      parentId: "parent",
      owner: { kind: "actor", id: "actor-b" },
    });

    expect(() => repository.setTerminalStatus("parent", "cancelled")).toThrow(
      "cannot cancel obligation with live children"
    );
    expect(() => repository.setTerminalStatus("parent", "done")).toThrow(
      "cannot complete obligation with live children"
    );
    repository.setTerminalStatus("child", "done");
    repository.setTerminalStatus("parent", "cancelled");
    expect(() => repository.setTerminalStatus("parent", "done")).toThrow(
      "terminal obligations cannot be reopened or changed"
    );
    expect(() =>
      repository.create({
        id: "late-child",
        parentId: "parent",
        owner: { kind: "actor", id: "actor-b" },
      })
    ).toThrow("cannot add a child to a terminal obligation");
  });

  it("returns a complete tree that names the live child explaining waiting", () => {
    repository.create({
      id: "root",
      owner: { kind: "actor", id: "actor-a" },
      externalRef: "github_pr:dummy-org/dummy-repo#2000",
    });
    repository.create({
      id: "review",
      parentId: "root",
      owner: { kind: "human", id: "reviewer" },
    });
    repository.create({
      id: "check",
      parentId: "review",
      owner: { kind: "actor", id: "actor-b" },
    });

    const tree = repository.getTree("root");
    expect(tree.obligation).toMatchObject({
      id: "root",
      status: "waiting",
      owner: { kind: "actor", id: "actor-a" },
    });
    expect(tree.blockingChildren.map((o) => o.id)).toEqual(["review"]);
    expect(tree.children[0]?.blockingChildren.map((o) => o.id)).toEqual(["check"]);
  });

  it("does not cap or warn on an owner ready queue", () => {
    for (let index = 0; index < 150; index += 1) {
      repository.create({
        id: `work-${index.toString().padStart(3, "0")}`,
        owner: { kind: "actor", id: "actor-a" },
      });
    }
    const queue = repository.listOwned({ kind: "actor", id: "actor-a" }, { status: "ready" });
    expect(queue).toHaveLength(150);
    expect(queue.at(0)?.id).toBe("work-000");
    expect(queue.at(-1)?.id).toBe("work-149");
  });

  it("provides bounded pages without capping the durable queue", () => {
    for (let index = 0; index < 150; index += 1) {
      repository.create({
        id: `work-${index.toString().padStart(3, "0")}`,
        owner: { kind: "actor", id: "actor-a" },
      });
    }

    const first = repository.listOwnedPage(
      { kind: "actor", id: "actor-a" },
      { status: "ready", limit: 50 }
    );
    const last = repository.listOwnedPage(
      { kind: "actor", id: "actor-a" },
      { status: "ready", limit: 50, offset: 100 }
    );

    expect(first).toMatchObject({ total: 150, hasMore: true });
    expect(first.obligations).toHaveLength(50);
    expect(first.obligations.at(0)?.id).toBe("work-000");
    expect(last).toMatchObject({ total: 150, hasMore: false });
    expect(last.obligations).toHaveLength(50);
    expect(last.obligations.at(-1)?.id).toBe("work-149");
    expect(repository.listOwned({ kind: "actor", id: "actor-a" })).toHaveLength(150);
  });

  it("internally inherits only a retiring actor's nonterminal obligations", () => {
    repository.create({ id: "parent-existing", owner: { kind: "actor", id: "actor-b" } });
    repository.create({ id: "retiring-first", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "retiring-second", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "retiring-terminal", owner: { kind: "actor", id: "actor-a" } });
    repository.setTerminalStatus("retiring-terminal", "done");
    repository.create({ id: "waiting-parent", owner: { kind: "actor", id: "actor-a" } });
    repository.create({
      id: "child-keeps-owner",
      parentId: "waiting-parent",
      owner: { kind: "actor", id: "actor-c" },
    });
    const storedPriorities = new Map(
      ["retiring-first", "retiring-second", "waiting-parent"].map((id) => [
        id,
        repository.require(id).priority,
      ])
    );

    expect(repository.inheritRetiringActorObligationsInternal("actor-a", "actor-b")).toEqual({
      ready: 2,
      waiting: 1,
    });
    expect(
      repository
        .listOwned({ kind: "actor", id: "actor-b" }, { status: "ready" })
        .map((o) => o.id)
        .sort()
    ).toEqual(["parent-existing", "retiring-first", "retiring-second"].sort());
    expect(repository.require("waiting-parent").owner).toEqual({ kind: "actor", id: "actor-b" });
    expect(repository.require("child-keeps-owner").owner).toEqual({
      kind: "actor",
      id: "actor-c",
    });
    expect(repository.require("retiring-terminal").owner).toEqual({
      kind: "actor",
      id: "actor-a",
    });
    for (const [id, priority] of storedPriorities) {
      expect(repository.require(id).priority).toBe(priority);
    }
  });

  it("supports child-first inheritance moving upward again when the parent retires", () => {
    repository.create({ id: "grandparent-existing", owner: { kind: "actor", id: "actor-c" } });
    repository.create({ id: "child-work", owner: { kind: "actor", id: "actor-a" } });

    expect(repository.inheritRetiringActorObligationsInternal("actor-a", "actor-b")).toEqual({
      ready: 1,
      waiting: 0,
    });
    expect(repository.inheritRetiringActorObligationsInternal("actor-b", "actor-c")).toEqual({
      ready: 1,
      waiting: 0,
    });
    expect(
      repository
        .listOwned({ kind: "actor", id: "actor-c" }, { status: "ready" })
        .map((o) => o.id)
        .sort()
    ).toEqual(["grandparent-existing", "child-work"].sort());
  });

  it("leaves root/no-parent inheritance visibly unresolved and validates the recipient", () => {
    repository.create({ id: "root-work", owner: { kind: "actor", id: "actor-a" } });

    expect(() => repository.inheritRetiringActorObligationsInternal("actor-a", null)).toThrow(
      "root/no-parent behavior is unresolved (ISSUE_NUM Q69)"
    );
    expect(() => repository.inheritRetiringActorObligationsInternal("actor-a", "unknown")).toThrow(
      "actor owner does not exist: unknown"
    );
    expect(repository.require("root-work").owner).toEqual({ kind: "actor", id: "actor-a" });
  });

  it("enforces reserved status and relational invariants at the persistence boundary", () => {
    const insert = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 0)`
    );
    expect(() => insert.run("snoozed", null, "actor", "actor-a", "snoozed")).toThrow(
      "CHECK constraint failed"
    );
    expect(() => insert.run("ownerless", null, "actor", " ", "ready")).toThrow(
      "CHECK constraint failed"
    );
    expect(() => insert.run("self", "self", "actor", "actor-a", "ready")).toThrow(
      "CHECK constraint failed"
    );
  });

  describe("list and listPage", () => {
    it("filters obligations by ownerKind, ownerId, status, and rootsOnly with pagination", () => {
      repository.create({ id: "root-1", owner: { kind: "actor", id: "actor-a" } });
      repository.create({ id: "root-2", owner: { kind: "human", id: "user-1" } });
      repository.create({
        id: "child-1",
        parentId: "root-1",
        owner: { kind: "actor", id: "actor-a" },
      });
      repository.setTerminalStatus("root-2", "done");

      const all = repository.list();
      expect(all.map((o) => o.id).sort()).toEqual(["child-1", "root-1", "root-2"].sort());

      const roots = repository.list({ rootsOnly: true });
      expect(roots.map((o) => o.id).sort()).toEqual(["root-1", "root-2"].sort());

      const actorA = repository.list({ ownerKind: "actor", ownerId: "actor-a" });
      expect(actorA.map((o) => o.id).sort()).toEqual(["child-1", "root-1"].sort());

      const done = repository.list({ status: "done" });
      expect(done.map((o) => o.id)).toEqual(["root-2"]);

      const page = repository.listPage({ rootsOnly: true, limit: 1, offset: 0 });
      expect(page.obligations).toHaveLength(1);
      expect(page.total).toBe(2);
      expect(page.hasMore).toBe(true);

      const page2 = repository.listPage({ rootsOnly: true, limit: 1, offset: 1 });
      expect(page2.obligations).toHaveLength(1);
      expect(page2.total).toBe(2);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe("reassign", () => {
    it("moves ready and waiting work between actor and human queues without changing the deliverable", () => {
      repository.create({
        id: "parent",
        owner: { kind: "actor", id: "actor-a" },
        externalRef: "github_issue:dummy-org/dummy-repo#1636",
        priority: 42.5,
      });
      repository.create({
        id: "child",
        parentId: "parent",
        owner: { kind: "actor", id: "actor-b" },
      });

      const before = repository.require("parent");
      const humanOwned = repository.reassign("parent", { kind: "human", id: "human:operator" });
      expect(humanOwned).toEqual({ ...before, owner: { kind: "human", id: "human:operator" } });
      expect(repository.listOwned({ kind: "actor", id: "actor-a" })).toEqual([]);
      expect(
        repository.listOwned({ kind: "human", id: "human:operator" }).map((o) => o.id)
      ).toEqual(["parent"]);

      const actorOwned = repository.reassign("parent", { kind: "actor", id: "actor-c" });
      expect(actorOwned).toEqual({ ...before, owner: { kind: "actor", id: "actor-c" } });
      expect(repository.getTree("parent").children[0].obligation.id).toBe("child");
    });

    it("validates actor targets, permits same-owner no-op, and rejects terminal obligations", () => {
      const task = repository.create({ id: "task", owner: { kind: "actor", id: "actor-a" } });
      expect(repository.reassign("task", task.owner)).toEqual(task);
      expect(() => repository.reassign("task", { kind: "actor", id: "missing" })).toThrow(
        "actor owner does not exist"
      );
      repository.setTerminalStatus("task", "done");
      expect(() => repository.reassign("task", { kind: "human", id: "human:operator" })).toThrow(
        "terminal obligations cannot be reassigned"
      );
    });
  });

  describe("reparent", () => {
    it("reparents a child to a new parent, updating both parents' ready/waiting states", () => {
      const p1 = repository.create({ id: "parent-1", owner: { kind: "actor", id: "actor-a" } });
      const p2 = repository.create({ id: "parent-2", owner: { kind: "actor", id: "actor-a" } });
      repository.create({
        id: "child-1",
        parentId: "parent-1",
        owner: { kind: "actor", id: "actor-a" },
      });

      expect(repository.require("parent-1").status).toBe("waiting");
      expect(repository.require("parent-2").status).toBe("ready");

      const reparented = repository.reparent("child-1", "parent-2");
      expect(reparented.parentId).toBe("parent-2");

      // Old parent (parent-1) has no live children left -> re-readies at retained priority
      expect(repository.require("parent-1").status).toBe("ready");
      expect(repository.require("parent-1").priority).toBe(p1.priority);

      // New parent (parent-2) now has a live child -> becomes waiting
      expect(repository.require("parent-2").status).toBe("waiting");
      expect(repository.require("parent-2").priority).toBe(p2.priority);
    });

    it("reparents a child to root, assigning a valid clock priority when stored priority was null", () => {
      repository.create({ id: "parent-1", owner: { kind: "actor", id: "actor-a" } });
      const child = repository.create({
        id: "child-1",
        parentId: "parent-1",
        owner: { kind: "actor", id: "actor-a" },
      });
      expect(child.priority).toBeNull();

      const reparented = repository.reparent("child-1", null);
      expect(reparented.parentId).toBeNull();
      expect(reparented.priority).toBeTypeOf("number");
      expect(Number.isFinite(reparented.priority)).toBe(true);
      expect(repository.require("parent-1").status).toBe("ready");
    });

    it("preserves explicit priority when reparenting", () => {
      repository.create({ id: "p1", owner: { kind: "actor", id: "actor-a" } });
      repository.create({ id: "p2", owner: { kind: "actor", id: "actor-a" } });
      repository.create({
        id: "c1",
        parentId: "p1",
        owner: { kind: "actor", id: "actor-a" },
        priority: 42.5,
      });

      const reparented = repository.reparent("c1", "p2");
      expect(reparented.priority).toBe(42.5);
      expect(reparented.parentId).toBe("p2");
    });

    it("rejects reparenting to self, cycle creation, terminal parent, and terminal target", () => {
      repository.create({ id: "root-a", owner: { kind: "actor", id: "actor-a" } });
      repository.create({
        id: "child-a",
        parentId: "root-a",
        owner: { kind: "actor", id: "actor-a" },
      });
      repository.create({
        id: "grandchild-a",
        parentId: "child-a",
        owner: { kind: "actor", id: "actor-a" },
      });
      repository.create({ id: "terminal-root", owner: { kind: "actor", id: "actor-a" } });
      repository.setTerminalStatus("terminal-root", "done");

      // Self-parenting
      expect(() => repository.reparent("root-a", "root-a")).toThrow(
        "obligation cannot parent itself"
      );

      // Cycle (reparent root-a to its own grandchild)
      expect(() => repository.reparent("root-a", "grandchild-a")).toThrow(
        "cannot reparent obligation to its own descendant"
      );

      // Reparent to terminal parent
      expect(() => repository.reparent("child-a", "terminal-root")).toThrow(
        "cannot add a child to a terminal obligation"
      );

      // Reparent terminal target
      expect(() => repository.reparent("terminal-root", "root-a")).toThrow(
        "terminal obligations cannot be reparented"
      );

      // Reparent to non-existent parent
      expect(() => repository.reparent("child-a", "non-existent")).toThrow(
        "parent obligation not found: non-existent"
      );

      // Reparent to same parent (no-op)
      const same = repository.reparent("child-a", "root-a");
      expect(same.parentId).toBe("root-a");
    });
  });
});
