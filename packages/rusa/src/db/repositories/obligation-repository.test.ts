import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObligationActivationScheduler } from "../../actor/os-scheduler.js";
import type { Obligation } from "../../obligations/obligation.js";
import { asGitHubIssue } from "../../references/reference.js";
import { obligations } from "../migrations/0016_obligations.js";
import { obligationPriority } from "../migrations/0017_obligation_priority.js";
import { obligationTimestamps } from "../migrations/0025_obligation_timestamps.js";
import { obligationTerminalNote } from "../migrations/0026_obligation_terminal_note.js";
import { obligationTitle } from "../migrations/0027_obligation_title.js";
import { obligationArtifacts } from "../migrations/0028_obligation_artifacts.js";
import { recurringObligations } from "../migrations/0035_recurring_obligations.js";
import { obligationDependencies } from "../migrations/0037_obligation_dependencies.js";
import { ObligationRepository } from "./obligation-repository.js";

/** Records every scheduler call instead of touching the OS, for assertions. */
class FakeObligationScheduler implements ObligationActivationScheduler {
  activations = new Map<string, { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }>();
  cancelled: string[] = [];
  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void {
    this.activations.set(id, time);
  }
  cancelObligationActivation(id: string): void {
    this.cancelled.push(id);
    this.activations.delete(id);
  }
  listObligationActivations(): string[] {
    return Array.from(this.activations.keys());
  }
}

describe("ObligationRepository", () => {
  let db: Database.Database;
  let repository: ObligationRepository;
  let now: number;

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
    now = 1_000;
    repository = new ObligationRepository(
      db,
      (id) => ["actor-a", "actor-b", "actor-c"].includes(id),
      () => now++
    );
  });

  it("stamps createdAt/updatedAt on create and advances updatedAt on mutation", async () => {
    const created = repository.create({
      title: "stamped",
      id: "stamped",
      ownerId: "actor-a",
      intent: "ship the slice",
    });

    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(created.updatedAt).toBe(created.createdAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    repository.setTerminalStatus("stamped", "done");

    const after = repository.require("stamped");
    expect(after.createdAt).toBe(created.createdAt);
    expect(Date.parse(after.updatedAt as string)).toBeGreaterThan(
      Date.parse(created.updatedAt as string)
    );
  });

  describe("ready-head attention (#1645)", () => {
    let heads: Array<{ ownerId: string; headId: string | null }>;

    beforeEach(() => {
      heads = [];
      repository.setReadyHeadListener(({ ownerId, head }) =>
        heads.push({ ownerId, headId: head?.id ?? null })
      );
    });

    it("announces a head on create, and not again for work that lands behind it", () => {
      repository.create({
        title: "first",
        id: "first",
        ownerId: "actor-a",
        priority: 10,
      });
      expect(heads).toEqual([{ ownerId: "actor-a", headId: "first" }]);

      // Lower priority = behind the head. #1645: no event for non-head readiness.
      heads = [];
      repository.create({
        title: "second",
        id: "second",
        ownerId: "actor-a",
        priority: 20,
      });
      expect(heads).toEqual([]);
    });

    it("carries the head it displaced, so a restored head is not a repeat", () => {
      const transitions: Array<{ from: string | null; to: string | null }> = [];
      repository.setReadyHeadListener(({ head, previousHeadId }) =>
        transitions.push({ from: previousHeadId, to: head?.id ?? null })
      );

      repository.create({
        title: "first",
        id: "first",
        ownerId: "actor-a",
        priority: 10,
      });
      repository.create({
        title: "urgent",
        id: "urgent",
        ownerId: "actor-a",
        priority: 1,
      });
      repository.setTerminalStatus("urgent", "done");

      // "first" is the head twice, and only `previousHeadId` separates the two.
      // Without it a consumer deduplicating on head identity cannot tell the
      // restored head from a replay, and goes silent on live work.
      expect(transitions).toEqual([
        { from: null, to: "first" },
        { from: "first", to: "urgent" },
        { from: "urgent", to: "first" },
      ]);
    });

    it("keeps a committed mutation successful when the listener throws", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      repository.setReadyHeadListener(() => {
        throw new Error("inbox is unavailable");
      });

      // Attention is a downstream effect of a committed write, not part of it.
      // Propagating would report failure for durable work — and the caller's
      // retry of create would then trip the external-ref uniqueness guard,
      // stranding an actor on work it believes it never created.
      expect(() =>
        repository.create({
          title: "committed",
          id: "committed",
          ownerId: "actor-a",
          externalRef: "github:o/r/issues/1",
        })
      ).not.toThrow();
      expect(repository.get("committed")?.ownerId).toBe("actor-a");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ready-head listener failed"));
      warn.mockRestore();
    });

    it("returns readyHeads and readyHeadTransitions with sequence numbers allowing boot recovery", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      repository.setReadyHeadListener(() => {
        throw new Error("inbox is unavailable");
      });

      repository.create({ title: "Task A", id: "ob-a", ownerId: "actor-a", priority: 5 });
      repository.create({ title: "Task B", id: "ob-b", ownerId: "actor-b", priority: 1 });

      const headsMap = repository.readyHeads();
      expect(headsMap.get("actor-a")).toBe("ob-a");
      expect(headsMap.get("actor-b")).toBe("ob-b");

      const transitions = repository.readyHeadTransitions();
      expect(transitions).toEqual(
        expect.arrayContaining([
          { ownerId: "actor-a", headId: "ob-a", previousHeadId: null, sequence: 1 },
          { ownerId: "actor-b", headId: "ob-b", previousHeadId: null, sequence: 1 },
        ])
      );
      warn.mockRestore();
    });

    it("preserves and increments the sequence number when queue drains completely and recurs", () => {
      // 1. Initial ready head "ob-1" (sequence 1)
      repository.create({ title: "Task 1", id: "ob-1", ownerId: "actor-a", priority: 10 });
      let transitions = repository.readyHeadTransitions();
      expect(transitions).toEqual([
        { ownerId: "actor-a", headId: "ob-1", previousHeadId: null, sequence: 1 },
      ]);

      // 2. Complete terminal status on "ob-1" -> queue is empty!
      repository.setTerminalStatus("ob-1", "done");
      transitions = repository.readyHeadTransitions();
      expect(transitions).toEqual([]);

      // Check the raw database state of obligation_ready_heads
      const rawRows = db
        .prepare("SELECT * FROM obligation_ready_heads WHERE owner_id = 'actor-a'")
        .all();
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0]).toMatchObject({
        owner_id: "actor-a",
        head_id: null,
        previous_head_id: "ob-1",
        sequence: 2,
      });

      // 3. Add a new ready head "ob-2" for the same owner.
      repository.create({ title: "Task 2", id: "ob-2", ownerId: "actor-a", priority: 10 });
      transitions = repository.readyHeadTransitions();
      expect(transitions).toEqual([
        { ownerId: "actor-a", headId: "ob-2", previousHeadId: null, sequence: 3 },
      ]);
    });

    it("announces the displacing obligation when new work takes the head", () => {
      repository.create({
        title: "first",
        id: "first",
        ownerId: "actor-a",
        priority: 10,
      });
      heads = [];

      repository.create({
        title: "urgent",
        id: "urgent",
        ownerId: "actor-a",
        priority: 1,
      });

      expect(heads).toEqual([{ ownerId: "actor-a", headId: "urgent" }]);
    });

    it("announces to the receiving actor on reassignment, and only to them", () => {
      repository.create({
        title: "work",
        id: "work",
        ownerId: "actor-a",
        priority: 10,
      });
      heads = [];

      repository.reassign("work", "actor-b");

      // Both sides are reported: actor-a's head vanished, actor-b gained one.
      // Losing a head is still not attention-worthy — the mesh delivers nothing
      // for a null head — but the change has to reach it, or a consumer that
      // collapses a run's churn would keep announcing a head that had gone.
      expect(heads).toEqual([
        { ownerId: "actor-a", headId: null },
        { ownerId: "actor-b", headId: "work" },
      ]);
    });

    it("announces a parent re-readied by its last child going terminal", () => {
      repository.create({
        title: "parent",
        id: "parent",
        ownerId: "actor-a",
        priority: 10,
      });
      repository.create({
        title: "child",
        id: "child",
        parentId: "parent",
        ownerId: "actor-b",
      });
      heads = [];

      repository.setTerminalStatus("child", "done");

      // The parent's owner was never named by the caller; the head diff finds it.
      // actor-b's head went terminal, so they are reported as having none.
      expect(heads).toEqual([
        { ownerId: "actor-b", headId: null },
        { ownerId: "actor-a", headId: "parent" },
      ]);
    });

    it("announces heirs when a retiring actor's work moves", () => {
      repository.create({
        title: "inherited",
        id: "inherited",
        ownerId: "actor-b",
        priority: 10,
      });
      heads = [];

      repository.inheritRetiringActorObligationsInternal("actor-b", "actor-a");

      expect(heads).toEqual([
        { ownerId: "actor-b", headId: null },
        { ownerId: "actor-a", headId: "inherited" },
      ]);
    });

    it("reports a head that vanished, so a collapsed run cannot announce a stale one", () => {
      repository.create({ title: "parent", id: "parent", ownerId: "actor-a", priority: 10 });
      heads = [];

      // Filing a child under your own head is the shape that motivated this:
      // the parent goes waiting the instant the child lands, so the head an
      // eager consumer just heard about is already gone.
      repository.create({ title: "child", id: "child", parentId: "parent", ownerId: "actor-a" });

      expect(heads).toEqual([{ ownerId: "actor-a", headId: "child" }]);

      heads = [];
      repository.create({
        title: "grandchild",
        id: "grandchild",
        parentId: "child",
        ownerId: "actor-b",
      });

      // actor-a now has nothing ready at all: parent waits on child, child waits
      // on the grandchild that actor-b owns.
      expect(heads).toEqual([
        { ownerId: "actor-a", headId: null },
        { ownerId: "actor-b", headId: "grandchild" },
      ]);
    });

    it("stays silent for human owners — their head belongs in the dashboard, not an inbox", () => {
      repository.create({
        title: "operator-work",
        id: "operator-work",
        ownerId: "human:operator",
        priority: 10,
      });
      expect(heads).toEqual([]);
    });

    it("announces nothing when a rolled-back mutation never commits", () => {
      repository.create({
        title: "parent",
        id: "parent",
        ownerId: "actor-a",
        priority: 10,
      });
      repository.create({
        title: "child",
        id: "child",
        parentId: "parent",
        ownerId: "actor-b",
      });
      heads = [];

      // A parent with a live child cannot go terminal; the transaction throws.
      expect(() => repository.setTerminalStatus("parent", "done")).toThrow();

      expect(heads).toEqual([]);
    });

    it("reports a head identical to the first row of the owner's own ready queue", () => {
      repository.create({
        title: "a",
        id: "a",
        ownerId: "actor-a",
        priority: 30,
      });
      repository.create({
        title: "b",
        id: "b",
        ownerId: "actor-a",
        priority: 20,
      });
      repository.create({
        title: "c",
        id: "c",
        ownerId: "actor-a",
        priority: 10,
      });

      const queue = repository.listOwned("actor-a", { status: "ready" });
      expect(heads.at(-1)).toEqual({ ownerId: "actor-a", headId: queue[0].id });
    });
  });

  it("records why an obligation terminated, for done and for cancelled alike", () => {
    repository.create({
      title: "answered",
      id: "answered",
      ownerId: "human:operator",
      intent: "pick a stack",
    });
    repository.create({
      title: "dropped",
      id: "dropped",
      ownerId: "actor-a",
      intent: "port to Godot",
    });

    const done = repository.setTerminalStatus(
      "answered",
      "done",
      "Flutter — tooling is already wired."
    );
    expect(done.terminalNote).toBe("Flutter — tooling is already wired.");

    const cancelled = repository.setTerminalStatus(
      "dropped",
      "cancelled",
      "Stack decided elsewhere."
    );
    expect(cancelled.terminalNote).toBe("Stack decided elsewhere.");
  });

  it("keeps one representation of 'no reason given'", () => {
    // A blank note and an omitted note are the same fact, and the column's
    // CHECK rejects the blank string outright — so the repository coerces
    // rather than letting a caller trip a constraint on whitespace.
    for (const [id, note] of [
      ["omitted", undefined],
      ["explicit-null", null],
      ["blank", "   \n  "],
    ] as Array<[string, string | null | undefined]>) {
      repository.create({
        title: "task",
        id,
        ownerId: "actor-a",
      });
      expect(repository.setTerminalStatus(id, "done", note).terminalNote).toBeNull();
    }
  });

  it("trims a note so leading indentation never becomes part of the reason", () => {
    repository.create({
      title: "padded",
      id: "padded",
      ownerId: "actor-a",
    });
    expect(
      repository.setTerminalStatus("padded", "cancelled", "  superseded by #61\n").terminalNote
    ).toBe("superseded by #61");
  });

  it("leaves a live obligation's note null and does not disturb it on unrelated mutation", () => {
    const live = repository.create({
      title: "live",
      id: "live",
      ownerId: "actor-a",
    });
    expect(live.terminalNote).toBeNull();
    expect(repository.reassign("live", "actor-b").terminalNote).toBeNull();
  });

  it("requires a heading, and keeps it to one short line", () => {
    expect(() => repository.create({ title: "  ", ownerId: "actor-a" })).toThrow(
      /title is required/
    );
    expect(() => repository.create({ title: "two\nlines", ownerId: "actor-a" })).toThrow(
      /single line/
    );
    expect(() => repository.create({ title: "x".repeat(201), ownerId: "actor-a" })).toThrow(
      /cannot exceed/
    );
    // Exactly at the cap is fine; the message points at intent for the rest.
    expect(repository.create({ title: "x".repeat(200), ownerId: "actor-a" }).title).toHaveLength(
      200
    );
    expect(repository.create({ title: "  Game Type  ", ownerId: "actor-a" }).title).toBe(
      "Game Type"
    );
  });

  it("keeps the heading and the body as separate fields", () => {
    const created = repository.create({
      title: "Game Type",
      ownerId: "human:operator",
      intent: "What kind of game Delve is, settled well enough to build against.",
    });
    expect(created.title).toBe("Game Type");
    expect(created.intent).toBe(
      "What kind of game Delve is, settled well enough to build against."
    );
  });

  describe("artifacts", () => {
    it("cites artifacts, and citing the same one twice is not an error", () => {
      repository.create({ title: "Game Type", id: "q", ownerId: "human:operator" });

      const first = repository.attachArtifact("q", "mesh:messages/msg-1", {
        label: "the ask",
        attachedBy: "actor-a",
      });
      const again = repository.attachArtifact("q", "mesh:messages/msg-1", {
        attachedBy: "actor-b",
      });

      // Idempotent per (obligation, ref): the first attachment's attribution
      // wins, so the record of who first cited it stays honest.
      expect(again.id).toBe(first.id);
      expect(again.attachedBy).toBe("actor-a");
      expect(again.label).toBe("the ask");
      expect(repository.listArtifacts("q")).toHaveLength(1);
    });

    it("validates the ref grammar", () => {
      repository.create({ title: "Game Type", id: "q", ownerId: "actor-a" });
      for (const bad of [
        "msg-1",
        "carrier_pigeon:m/1",
        "mesh:",
        "mesh:messages/a b",
        "mesh:messages",
        "github:o/r/issues/1#issuecomment-2",
      ]) {
        expect(() => repository.attachArtifact("q", bad)).toThrow();
      }
      expect(repository.attachArtifact("q", "gchat:spaces/s/messages/m").ref).toBe(
        "gchat:spaces/s/messages/m"
      );
    });

    it("attaches the resolving artifact as part of the transition", () => {
      repository.create({ title: "Game Type", id: "q", ownerId: "human:operator" });

      const resolved = repository.setTerminalStatus(
        "q",
        "done",
        "A monster-catching JRPG in a cave.",
        "mesh:messages/msg-7"
      );

      expect(resolved.resolutionRef).toBe("mesh:messages/msg-7");
      expect(resolved.terminalNote).toBe("A monster-catching JRPG in a cave.");
      // One call, not two: evidence that only lands if a second call succeeds
      // is evidence that goes missing on a crash.
      expect(repository.listArtifacts("q").map((a) => a.ref)).toEqual(["mesh:messages/msg-7"]);
    });

    it("leaves resolutionRef null when nothing is cited, and rejects a bad ref", () => {
      repository.create({ title: "Quiet", id: "quiet", ownerId: "actor-a" });
      expect(repository.setTerminalStatus("quiet", "done").resolutionRef).toBeNull();

      repository.create({ title: "Bad", id: "bad", ownerId: "actor-a" });
      expect(() => repository.setTerminalStatus("bad", "done", null, "nope:x")).toThrow();
      // The transition is rolled back with it — a rejected citation must not
      // leave the obligation terminal with no record of why.
      expect(repository.require("bad").status).toBe("ready");
    });
  });

  describe("setExternalRef", () => {
    it("links, relinks and unlinks after creation", () => {
      const created = repository.create({ title: "Ship it", id: "work", ownerId: "actor-a" });
      expect(created.externalRef).toBeNull();

      expect(
        repository.setExternalRef("work", "github:MEK-Org/rusa/issues/33").externalRef?.key
      ).toBe("github:MEK-Org/rusa/issues/33");
      // Relinking a mistyped number, and unlinking entirely, are both ordinary.
      expect(
        repository.setExternalRef("work", "github:MEK-Org/rusa/issues/34").externalRef?.key
      ).toBe("github:MEK-Org/rusa/issues/34");
      expect(repository.setExternalRef("work", null).externalRef).toBeNull();
    });

    it("frees the ref for its rightful claimant when unlinked", () => {
      repository.create({ title: "Wrong", id: "wrong", ownerId: "actor-a" });
      repository.create({ title: "Right", id: "right", ownerId: "actor-b" });
      repository.setExternalRef("wrong", "github:MEK-Org/rusa/issues/33");

      // Live uniqueness holds while the mislink stands...
      expect(() => repository.setExternalRef("right", "github:MEK-Org/rusa/issues/33")).toThrow(
        "already uses external ref"
      );
      // ...and unlinking is what releases it. Without this the claim would be
      // stuck on the wrong obligation for as long as that obligation lives.
      repository.setExternalRef("wrong", null);
      expect(
        repository.setExternalRef("right", "github:MEK-Org/rusa/issues/33").externalRef?.key
      ).toBe("github:MEK-Org/rusa/issues/33");
    });

    it("treats case variants as one live identity claim", () => {
      repository.create({ title: "First", id: "first-claim", ownerId: "actor-a" });
      repository.create({ title: "Second", id: "second-claim", ownerId: "actor-b" });
      repository.setExternalRef("first-claim", "github:MEK-Org/rusa");

      expect(() => repository.setExternalRef("second-claim", "github:mek-org/RUSA")).toThrow(
        "already uses external ref"
      );
    });

    it("accepts a repository or an owner as the identity", () => {
      repository.create({ title: "Keep rusa releasable", id: "repo-level", ownerId: "actor-a" });
      expect(repository.setExternalRef("repo-level", "github:MEK-Org/rusa").externalRef?.key).toBe(
        "github:MEK-Org/rusa"
      );
      repository.create({ title: "Org health", id: "org-level", ownerId: "actor-a" });
      expect(repository.setExternalRef("org-level", "github:MEK-Org").externalRef?.key).toBe(
        "github:MEK-Org"
      );
    });

    it("rejects a sub-resource and freezes a terminal obligation's identity", () => {
      repository.create({ title: "Work", id: "sub", ownerId: "actor-a" });
      expect(() =>
        repository.setExternalRef("sub", "github:MEK-Org/rusa/issues/33/comments/9")
      ).toThrow("external ref must name");

      repository.create({ title: "Done", id: "closed", ownerId: "actor-a" });
      repository.setTerminalStatus("closed", "done");
      expect(() => repository.setExternalRef("closed", "github:MEK-Org/rusa")).toThrow(
        "terminal obligations cannot change their external ref"
      );
    });
  });

  it("has no UPDATE on obligations that forgets updated_at (drift guard for the trigger we chose not to use)", async () => {
    // The operator ruled against stamping via SQLite triggers on #1671 (2026-08-22):
    // triggers are "opaque to the codebase". Repository writes are visible but
    // missable, so the guarantee has to live here instead: every mutation
    // statement in the repository must set updated_at, and this test fails when
    // a new one does not.
    const { readFileSync } = await import("node:fs");
    // Vitest can hand back a non-file import.meta.url, so resolve from the
    // package root (the test process cwd) instead.
    const source = readFileSync("src/db/repositories/obligation-repository.ts", "utf8");
    const updates = source.match(/UPDATE\s+obligations\b[\s\S]*?(?=`|")/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    const missing = updates.filter((statement) => !/updated_at\s*=/.test(statement));
    expect(missing).toEqual([]);
  });

  it("stamps every public mutation, not just the ones with a bespoke test", async () => {
    const mutate: Array<[string, (name: string) => void]> = [
      ["setTerminalStatus", (n) => repository.setTerminalStatus(`subject-${n}`, "done")],
      ["reassign", (n) => repository.reassign(`subject-${n}`, "actor-c")],
      ["reparent", (n) => repository.reparent(`subject-${n}`, null)],
      ["setPriorityInternal", (n) => repository.setPriorityInternal(`subject-${n}`, 77)],
    ];
    for (const [name, apply] of mutate) {
      // Fresh ids per case rather than deleting: obligations reference their
      // parent with ON DELETE RESTRICT, so a blanket delete trips the FK.
      repository.create({
        title: `anchor-${name}`,
        id: `anchor-${name}`,
        ownerId: "actor-a",
        priority: 1,
      });
      const before = repository.create({
        title: `subject-${name}`,
        id: `subject-${name}`,
        parentId: `anchor-${name}`,
        ownerId: "actor-b",
      });
      await new Promise((resolve) => setTimeout(resolve, 3));
      apply(name);
      const after = repository.require(`subject-${name}`);
      expect(
        Date.parse(after.updatedAt as string),
        `${name} did not advance updatedAt`
      ).toBeGreaterThan(Date.parse(before.updatedAt as string));
      expect(after.createdAt, `${name} moved createdAt`).toBe(before.createdAt);
    }
  });

  it("records an immutable creator that survives reassignment", async () => {
    const created = repository.create({
      title: "owned-elsewhere",
      id: "owned-elsewhere",
      ownerId: "actor-b",
      creatorId: "human:operator",
      intent: "raised by one entity, owned by another",
    });

    expect(created.creatorId).toBe("human:operator");
    expect(created.ownerId).toEqual("actor-b");

    repository.reassign("owned-elsewhere", "actor-c");
    const moved = repository.require("owned-elsewhere");
    expect(moved.ownerId).toEqual("actor-c");
    expect(moved.creatorId).toBe("human:operator");
  });

  it("accepts any id in the mesh's one id space and rejects a blank one", () => {
    // Actor UUID, root, human:*, system:* — all the same space, no `kind`.
    for (const creator of ["actor-a", "root", "human:operator", "system:service"]) {
      const o = repository.create({
        title: `by-${creator}`,
        id: `by-${creator}`,
        ownerId: "actor-a",
        creatorId: creator,
      });
      expect(o.creatorId).toBe(creator);
    }

    expect(() =>
      repository.create({
        title: "blank-creator",
        id: "blank-creator",
        ownerId: "actor-a",
        creatorId: "  ",
      })
    ).toThrow("entity id is required");
  });

  it("records an honest unknown creator rather than inferring one from the owner", () => {
    const created = repository.create({
      title: "no-principal",
      id: "no-principal",
      ownerId: "actor-a",
    });
    expect(created.creatorId).toBeNull();
  });

  it("stamps mutations that do not go through setTerminalStatus", async () => {
    repository.create({
      title: "root",
      id: "root",
      ownerId: "actor-a",
      priority: 10,
    });
    const child = repository.create({
      title: "child",
      id: "child",
      parentId: "root",
      ownerId: "actor-b",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    repository.reassign("child", "actor-c");

    expect(Date.parse(repository.require("child").updatedAt as string)).toBeGreaterThan(
      Date.parse(child.updatedAt as string)
    );
  });

  it("represents exactly one validated owner while treating human ids as opaque handles", () => {
    const actorOwned = repository.create({
      title: "actor-work",
      id: "actor-work",
      ownerId: "actor-a",
      intent: "ship the slice",
    });
    const humanOwned = repository.create({
      title: "human-work",
      id: "human-work",
      ownerId: "human:operator",
    });

    expect(actorOwned.ownerId).toEqual("actor-a");
    expect(humanOwned.ownerId).toEqual("human:operator");
    expect(() =>
      repository.create({
        title: "missing-actor",
        id: "missing-actor",
        ownerId: "unknown",
      })
    ).toThrow("actor owner does not exist");
    expect(() =>
      repository.create({
        title: "blank-owner",
        id: "blank-owner",
        ownerId: "   ",
      })
    ).toThrow("entity id is required");
    // `human:*` and `system:*` are not in the actor repository, so they must NOT
    // be run through the actor-existence check that rejects "unknown".
    expect(() =>
      repository.create({
        title: "system-owned",
        id: "system-owned",
        ownerId: "system:service",
      })
    ).not.toThrow();
  });

  it("validates one supported external ref, enforces live uniqueness, and permits terminal reuse", () => {
    const original = repository.create({
      title: "original",
      id: "original",
      ownerId: "actor-a",
      externalRef: "github:dummy-org/dummy-repo/issues/1485",
    });
    expect(original.externalRef?.key).toBe("github:dummy-org/dummy-repo/issues/1485");
    const originalRef = original.externalRef;
    if (!originalRef) throw new Error("expected an external ref");
    expect(asGitHubIssue(originalRef)).toMatchObject({
      owner: "dummy-org",
      repo: "dummy-repo",
      collection: "issues",
      number: 1485,
    });

    expect(() =>
      repository.create({
        title: "duplicate",
        id: "duplicate",
        ownerId: "actor-b",
        externalRef: "github:dummy-org/dummy-repo/issues/1485",
      })
    ).toThrow("already uses external ref");
    expect(() =>
      repository.create({
        title: "bad-ref",
        id: "bad-ref",
        ownerId: "actor-a",
        externalRef: "github:dummy-org/dummy-repo/issues/1485/comments/9",
      })
    ).toThrow("external ref must name");
    expect(() =>
      repository.create({
        title: "oversized-owner",
        id: "oversized-owner",
        ownerId: "actor-a",
        externalRef: `github:${"a".repeat(40)}/rusa/issues/1`,
      })
    ).toThrow("external ref owner cannot exceed 39 characters");
    expect(() =>
      repository.create({
        title: "oversized-repo",
        id: "oversized-repo",
        ownerId: "actor-a",
        externalRef: `github:dummy-org/${"b".repeat(101)}/issues/1`,
      })
    ).toThrow("external ref repository cannot exceed 100 characters");

    const maxBounds = repository.create({
      title: "max-bounds",
      id: "max-bounds",
      ownerId: "actor-a",
      externalRef: `github:${"a".repeat(39)}/${"b".repeat(100)}/issues/1`,
    });
    const maxRef = maxBounds.externalRef;
    if (!maxRef) throw new Error("expected an external ref");
    expect(asGitHubIssue(maxRef)).toMatchObject({
      owner: "a".repeat(39),
      repo: "b".repeat(100),
    });

    repository.setTerminalStatus("original", "done");
    repository.setTerminalStatus("max-bounds", "done");
    expect(
      repository.create({
        title: "successor",
        id: "successor",
        ownerId: "actor-b",
        externalRef: "github:dummy-org/dummy-repo/issues/1485",
      }).status
    ).toBe("ready");
  });

  it("finds the live obligation claiming an external ref and excludes it once terminal", () => {
    repository.create({
      title: "claimed work",
      id: "claimed",
      ownerId: "actor-b",
      externalRef: "github:dummy-org/dummy-repo/issues/7",
    });

    expect(repository.findLiveByExternalRef("github:DUMMY-ORG/DUMMY-REPO/issues/7")).toEqual({
      ownerId: "actor-b",
    });

    repository.setTerminalStatus("claimed", "done");
    expect(repository.findLiveByExternalRef("github:dummy-org/dummy-repo/issues/7")).toBeNull();
  });

  it("blocks a parent on live children and re-readies at its retained priority", () => {
    repository.create({
      title: "first",
      id: "first",
      ownerId: "actor-a",
    });
    repository.create({
      title: "parent",
      id: "parent",
      ownerId: "actor-a",
    });
    repository.create({
      title: "third",
      id: "third",
      ownerId: "actor-a",
    });
    repository.setPriorityInternal("third", 100);
    repository.setPriorityInternal("parent", 200);
    repository.setPriorityInternal("first", 300);
    repository.create({
      title: "child",
      id: "child",
      parentId: "parent",
      ownerId: "actor-b",
      intent: "review the parent artifact",
    });

    expect(repository.require("parent").status).toBe("waiting");
    expect(repository.listOwned("actor-a", { status: "ready" }).map((o) => o.id)).toEqual([
      "third",
      "first",
    ]);
    expect(repository.getTree("parent").blockingChildren.map((o) => o.id)).toEqual(["child"]);

    repository.setTerminalStatus("child", "done");

    expect(repository.require("parent").status).toBe("ready");
    expect(repository.listOwned("actor-a", { status: "ready" }).map((o) => o.id)).toEqual([
      "third",
      "parent",
      "first",
    ]);
    expect(repository.getTree("parent").blockingChildren).toEqual([]);
  });

  it("rejects invalid, nonadjacent, cross-owner, and non-ready priority moves", () => {
    repository.create({
      title: "first",
      id: "first",
      ownerId: "actor-a",
    });
    repository.create({
      title: "second",
      id: "second",
      ownerId: "actor-a",
    });
    repository.create({
      title: "foreign",
      id: "foreign",
      ownerId: "actor-b",
    });

    expect(() => repository.movePriorityInternal("second", "foreign", null)).toThrow(
      "neighbors must be adjacent ready obligations owned by the target owner"
    );
    expect(() => repository.movePriorityInternal("second", "first", "first")).toThrow(
      "neighbors must be adjacent"
    );
    repository.create({
      title: "child",
      id: "child",
      parentId: "first",
      ownerId: "actor-b",
    });
    expect(() => repository.movePriorityInternal("first", null, "second")).toThrow(
      "only ready obligations can be reordered"
    );
    expect(() => repository.setPriorityInternal("second", Number.NaN)).toThrow(
      "priority must be finite"
    );
  });

  it("resolves nullable child priority through the nearest explicit ancestor", () => {
    repository.create({
      title: "root",
      id: "root",
      ownerId: "actor-a",
      priority: 10,
    });
    repository.create({
      title: "child",
      id: "child",
      parentId: "root",
      ownerId: "actor-b",
    });
    repository.create({
      title: "override",
      id: "override",
      parentId: "child",
      ownerId: "actor-c",
      priority: 20,
    });
    repository.create({
      title: "leaf",
      id: "leaf",
      parentId: "override",
      ownerId: "actor-a",
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
    repository.create({
      title: "root",
      id: "root",
      ownerId: "actor-a",
      priority: 10,
    });
    repository.create({
      title: "child",
      id: "child",
      parentId: "root",
      ownerId: "actor-b",
      priority: 20,
    });
    repository.create({
      title: "leaf",
      id: "leaf",
      parentId: "child",
      ownerId: "actor-c",
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
    repository.create({
      title: "root",
      id: "root",
      ownerId: "actor-a",
      priority: 10,
    });
    repository.create({
      title: "inheriting",
      id: "inheriting",
      parentId: "root",
      ownerId: "actor-b",
    });
    repository.create({
      title: "leaf",
      id: "leaf",
      parentId: "inheriting",
      ownerId: "actor-c",
    });
    repository.create({
      title: "explicit",
      id: "explicit",
      parentId: "root",
      ownerId: "actor-b",
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
    repository.create({
      title: "a",
      id: "a",
      ownerId: "actor-a",
      priority: 10,
    });
    repository.create({
      title: "b",
      id: "b",
      ownerId: "actor-a",
      priority: 20,
    });
    repository.create({
      title: "c",
      id: "c",
      ownerId: "actor-a",
      priority: 30,
    });
    repository.create({
      title: "moved",
      id: "moved",
      ownerId: "actor-a",
      priority: 40,
    });

    expect(repository.movePriorityInternal("moved", "a", "b").effectivePriority).toBe(15);
    expect(repository.listOwned("actor-a", { status: "ready" }).map((o) => o.id)).toEqual([
      "a",
      "moved",
      "b",
      "c",
    ]);

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
    repository.create({
      title: "low",
      id: "low",
      ownerId: "actor-a",
      priority: -1e308,
    });
    repository.create({
      title: "high",
      id: "high",
      ownerId: "actor-a",
      priority: 1e308,
    });
    repository.create({
      title: "moved",
      id: "moved",
      ownerId: "actor-a",
      priority: 0,
    });

    expect(repository.movePriorityInternal("moved", "low", "high").effectivePriority).toBe(0);
    expect(repository.movePriorityInternal("moved", null, "low").effectivePriority).toSatisfy(
      (priority: number) => Number.isFinite(priority) && priority < -1e308
    );
    expect(repository.movePriorityInternal("moved", "high", null).effectivePriority).toSatisfy(
      (priority: number) => Number.isFinite(priority) && priority > 1e308
    );
  });

  it("repairs large equal-priority bands using the next representable values", () => {
    repository.create({
      title: "a",
      id: "a",
      ownerId: "actor-a",
      priority: 1e308,
    });
    repository.create({
      title: "b",
      id: "b",
      ownerId: "actor-a",
      priority: 1e308,
    });
    repository.create({
      title: "c",
      id: "c",
      ownerId: "actor-a",
      priority: 1e308,
    });
    repository.create({
      title: "moved",
      id: "moved",
      ownerId: "actor-a",
      priority: 1.5e308,
    });

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
    repository.create({
      title: "parent",
      id: "parent",
      ownerId: "actor-a",
    });
    repository.create({
      title: "child-a",
      id: "child-a",
      parentId: "parent",
      ownerId: "actor-b",
    });
    repository.create({
      title: "child-b",
      id: "child-b",
      parentId: "parent",
      ownerId: "human:operator",
    });

    repository.setTerminalStatus("child-a", "done");
    expect(repository.require("parent").status).toBe("waiting");
    repository.setTerminalStatus("child-b", "cancelled");
    expect(repository.require("parent").status).toBe("ready");
  });

  it("guards terminal transitions with live children and makes terminal state final", () => {
    repository.create({
      title: "parent",
      id: "parent",
      ownerId: "actor-a",
    });
    repository.create({
      title: "child",
      id: "child",
      parentId: "parent",
      ownerId: "actor-b",
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
        title: "late-child",
        id: "late-child",
        parentId: "parent",
        ownerId: "actor-b",
      })
    ).toThrow("cannot add a child to a terminal obligation");
  });

  it("does not treat a scheduled child as blocking a parent's completion or reparenting", () => {
    const parent = repository.create({ ownerId: "actor-a", title: "parent" });
    const child = repository.create({ ownerId: "actor-a", title: "child", parentId: parent.id });

    // change child to scheduled
    db.prepare(
      "UPDATE obligations SET status = 'scheduled', recurrence_policy = 'cron', recurrence_cron = '* * * * *', next_ready_at = '2026-08-01T00:00:00.000Z' WHERE id = ?"
    ).run(child.id);

    // parent should not be blocked from completion
    const completed = repository.setTerminalStatus(parent.id, "done");
    expect(completed.status).toBe("done");

    // test reparenting a scheduled child
    const newParent = repository.create({ ownerId: "actor-a", title: "new parent" });
    repository.reparent(child.id, newParent.id);

    // new parent should not be blocked
    const newParentAfter = repository.get(newParent.id);
    expect(newParentAfter?.status).toBe("ready");
  });

  it("includes scheduled identities in findLiveObligationByExternalRef and internal inheritance", () => {
    const externalRef = "github:owner/repo/issues/1";
    const ob = repository.create({ ownerId: "actor-a", title: "ob", externalRef });

    db.prepare(
      "UPDATE obligations SET status = 'scheduled', recurrence_policy = 'cron', recurrence_cron = '* * * * *', next_ready_at = '2026-08-01T00:00:00.000Z' WHERE id = ?"
    ).run(ob.id);

    // should find scheduled identity
    const found = repository.findLiveObligationByExternalRef(externalRef);
    expect(found?.ownerId).toBe("actor-a");
  });

  it("returns a complete tree that names the live child explaining waiting", () => {
    repository.create({
      title: "root",
      id: "root",
      ownerId: "actor-a",
      externalRef: "github:dummy-org/dummy-repo/pulls/2000",
    });
    repository.create({
      title: "review",
      id: "review",
      parentId: "root",
      ownerId: "human:operator",
    });
    repository.create({
      title: "check",
      id: "check",
      parentId: "review",
      ownerId: "actor-b",
    });

    const tree = repository.getTree("root");
    expect(tree.obligation).toMatchObject({
      id: "root",
      status: "waiting",
      ownerId: "actor-a",
    });
    expect(tree.blockingChildren.map((o) => o.id)).toEqual(["review"]);
    expect(tree.children[0]?.blockingChildren.map((o) => o.id)).toEqual(["check"]);
  });

  describe("getTree / getForest query cost (#241)", () => {
    /** A forest deep/wide enough that a per-node query pattern would be obvious in the prepare count. */
    function buildForest(rootId: string, ownerId: string, depth: number, branching: number): void {
      repository.create({ id: rootId, title: rootId, ownerId });
      let frontier = [rootId];
      for (let level = 0; level < depth; level += 1) {
        const next: string[] = [];
        for (const parentId of frontier) {
          for (let branch = 0; branch < branching; branch += 1) {
            const id = `${parentId}-${branch}`;
            repository.create({ id, title: id, parentId, ownerId });
            next.push(id);
          }
        }
        frontier = next;
      }
    }

    it("reads a 40-node subtree in a bounded number of statements, not one per node", () => {
      buildForest("root-a", "actor-a", 3, 3); // 1 + 3 + 9 + 27 = 40 nodes
      const prepareSpy = vi.spyOn(db, "prepare");
      const tree = repository.getTree("root-a");
      expect(prepareSpy.mock.calls.length).toBe(1);
      prepareSpy.mockRestore();

      let total = 1;
      const walk = (node: typeof tree): void => {
        total += node.children.length;
        for (const child of node.children) walk(child);
      };
      walk(tree);
      expect(total).toBe(40);
    });

    it("builds multiple root trees from one bulk read, in the order requested, with terminal children retained but non-blocking", () => {
      buildForest("root-x", "actor-a", 1, 2); // root-x, root-x-0, root-x-1
      buildForest("root-y", "actor-b", 1, 2);
      repository.setTerminalStatus("root-x-0", "done");

      const prepareSpy = vi.spyOn(db, "prepare");
      const [treeY, treeX] = repository.getForest(["root-y", "root-x"]);
      expect(prepareSpy.mock.calls.length).toBe(1);
      prepareSpy.mockRestore();

      expect(treeY.obligation.id).toBe("root-y");
      expect(treeX.obligation.id).toBe("root-x");
      expect(treeX.children.map((c) => c.obligation.id).sort()).toEqual(["root-x-0", "root-x-1"]);
      expect(treeX.children.find((c) => c.obligation.id === "root-x-0")?.obligation.status).toBe(
        "done"
      );
      expect(treeX.blockingChildren.map((c) => c.id)).toEqual(["root-x-1"]);
    });

    it("orders children by effective priority then id, matching listChildren", () => {
      repository.create({ id: "ord-root", title: "ord-root", ownerId: "actor-a" });
      repository.create({
        id: "ord-b",
        title: "b",
        parentId: "ord-root",
        ownerId: "actor-a",
        priority: 5,
      });
      repository.create({
        id: "ord-a",
        title: "a",
        parentId: "ord-root",
        ownerId: "actor-a",
        priority: 5,
      });
      repository.create({
        id: "ord-c",
        title: "c",
        parentId: "ord-root",
        ownerId: "actor-a",
        priority: 1,
      });

      const tree = repository.getTree("ord-root");
      expect(tree.children.map((c) => c.obligation.id)).toEqual(
        repository.listChildren("ord-root").map((o) => o.id)
      );
      expect(tree.children.map((c) => c.obligation.id)).toEqual(["ord-c", "ord-a", "ord-b"]);
    });

    it("getForest does not misreport a cycle when a requested root is also a descendant of another requested root", () => {
      repository.create({ id: "ancestor", title: "ancestor", ownerId: "actor-a" });
      repository.create({
        id: "descendant",
        title: "descendant",
        parentId: "ancestor",
        ownerId: "actor-a",
      });
      repository.create({
        id: "grandchild",
        title: "grandchild",
        parentId: "descendant",
        ownerId: "actor-a",
      });

      const [ancestorTree, descendantTree] = repository.getForest(["ancestor", "descendant"]);
      expect(ancestorTree.obligation.id).toBe("ancestor");
      expect(ancestorTree.children.map((c) => c.obligation.id)).toEqual(["descendant"]);
      expect(ancestorTree.children[0]?.children.map((c) => c.obligation.id)).toEqual([
        "grandchild",
      ]);
      expect(descendantTree.obligation.id).toBe("descendant");
      expect(descendantTree.children.map((c) => c.obligation.id)).toEqual(["grandchild"]);
    });

    it("getForest returns [] for no roots and omits roots that don't exist", () => {
      expect(repository.getForest([])).toEqual([]);
      buildForest("root-z", "actor-a", 0, 0);
      expect(repository.getForest(["missing", "root-z"]).map((t) => t.obligation.id)).toEqual([
        "root-z",
      ]);
    });

    it("listPage excludeQuietTerminalRoots drops done/cancelled roots with no recurrence or completion history, keeps everything else", () => {
      repository.create({ id: "live-root", title: "live-root", ownerId: "actor-a" });
      repository.create({ id: "quiet-done", title: "quiet-done", ownerId: "actor-a" });
      repository.setTerminalStatus("quiet-done", "done");
      repository.create({ id: "quiet-cancelled", title: "quiet-cancelled", ownerId: "actor-a" });
      repository.setTerminalStatus("quiet-cancelled", "cancelled");

      repository.create({ id: "recurring-done", title: "recurring-done", ownerId: "actor-a" });
      repository.setRecurrence("recurring-done", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("recurring-done", "done");

      repository.create({ id: "historied-done", title: "historied-done", ownerId: "actor-a" });
      repository.setRecurrence("historied-done", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("historied-done", "done");
      repository.activateScheduled("historied-done");
      repository.setRecurrence("historied-done", null);
      repository.setTerminalStatus("historied-done", "done");

      const filtered = repository.listPage({
        rootsOnly: true,
        excludeQuietTerminalRoots: true,
        limit: 50,
      });
      expect(filtered.obligations.map((o) => o.id).sort()).toEqual([
        "historied-done",
        "live-root",
        "recurring-done",
      ]);
      expect(filtered.total).toBe(3);
      expect(filtered.hasMore).toBe(false);

      const unfiltered = repository.listPage({ rootsOnly: true, limit: 50 });
      expect(unfiltered.obligations.map((o) => o.id).sort()).toEqual([
        "historied-done",
        "live-root",
        "quiet-cancelled",
        "quiet-done",
        "recurring-done",
      ]);
      expect(unfiltered.total).toBe(5);
    });
  });

  it("does not cap or warn on an owner ready queue", () => {
    for (let index = 0; index < 150; index += 1) {
      repository.create({
        title: "work-${index.toString().padStart(3, ",
        id: `work-${index.toString().padStart(3, "0")}`,
        ownerId: "actor-a",
      });
    }
    const queue = repository.listOwned("actor-a", { status: "ready" });
    expect(queue).toHaveLength(150);
    expect(queue.at(0)?.id).toBe("work-000");
    expect(queue.at(-1)?.id).toBe("work-149");
  });

  it("provides bounded pages without capping the durable queue", () => {
    for (let index = 0; index < 150; index += 1) {
      repository.create({
        title: "work-${index.toString().padStart(3, ",
        id: `work-${index.toString().padStart(3, "0")}`,
        ownerId: "actor-a",
      });
    }

    const first = repository.listOwnedPage("actor-a", { status: "ready", limit: 50 });
    const last = repository.listOwnedPage("actor-a", { status: "ready", limit: 50, offset: 100 });

    expect(first).toMatchObject({ total: 150, hasMore: true });
    expect(first.obligations).toHaveLength(50);
    expect(first.obligations.at(0)?.id).toBe("work-000");
    expect(last).toMatchObject({ total: 150, hasMore: false });
    expect(last.obligations).toHaveLength(50);
    expect(last.obligations.at(-1)?.id).toBe("work-149");
    expect(repository.listOwned("actor-a")).toHaveLength(150);
  });

  it("internally inherits only a retiring actor's nonterminal obligations", () => {
    repository.create({
      title: "parent-existing",
      id: "parent-existing",
      ownerId: "actor-b",
    });
    repository.create({
      title: "retiring-first",
      id: "retiring-first",
      ownerId: "actor-a",
    });
    repository.create({
      title: "retiring-second",
      id: "retiring-second",
      ownerId: "actor-a",
    });
    repository.create({
      title: "retiring-terminal",
      id: "retiring-terminal",
      ownerId: "actor-a",
    });
    repository.setTerminalStatus("retiring-terminal", "done");
    repository.create({
      title: "waiting-parent",
      id: "waiting-parent",
      ownerId: "actor-a",
    });
    repository.create({
      title: "child-keeps-owner",
      id: "child-keeps-owner",
      parentId: "waiting-parent",
      ownerId: "actor-c",
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
      scheduled: 0,
    });
    expect(
      repository
        .listOwned("actor-b", { status: "ready" })
        .map((o) => o.id)
        .sort()
    ).toEqual(["parent-existing", "retiring-first", "retiring-second"].sort());
    expect(repository.require("waiting-parent").ownerId).toEqual("actor-b");
    expect(repository.require("child-keeps-owner").ownerId).toEqual("actor-c");
    expect(repository.require("retiring-terminal").ownerId).toEqual("actor-a");
    for (const [id, priority] of storedPriorities) {
      expect(repository.require(id).priority).toBe(priority);
    }
  });

  it("inherits a scheduled recurring obligation's ownership, keeping its recurrence and next_ready_at intact", () => {
    repository.create({
      title: "recurring-work",
      id: "retiring-recurring",
      ownerId: "actor-a",
    });
    repository.setRecurrence("retiring-recurring", { policy: "cron", cronExpr: "0 * * * *" });
    const scheduled = repository.setTerminalStatus("retiring-recurring", "done", "cycle one");
    expect(scheduled.status).toBe("scheduled");

    expect(repository.inheritRetiringActorObligationsInternal("actor-a", "actor-b")).toEqual({
      ready: 0,
      waiting: 0,
      scheduled: 1,
    });

    const inherited = repository.require("retiring-recurring");
    expect(inherited.ownerId).toBe("actor-b");
    expect(inherited.status).toBe("scheduled");
    expect(inherited.recurrencePolicy).toBe("cron");
    expect(inherited.recurrenceCron).toBe("0 * * * *");
    expect(inherited.nextReadyAt).toBe(scheduled.nextReadyAt);
  });

  it("supports child-first inheritance moving upward again when the parent retires", () => {
    repository.create({
      title: "grandparent-existing",
      id: "grandparent-existing",
      ownerId: "actor-c",
    });
    repository.create({
      title: "child-work",
      id: "child-work",
      ownerId: "actor-a",
    });

    expect(repository.inheritRetiringActorObligationsInternal("actor-a", "actor-b")).toEqual({
      ready: 1,
      waiting: 0,
      scheduled: 0,
    });
    expect(repository.inheritRetiringActorObligationsInternal("actor-b", "actor-c")).toEqual({
      ready: 1,
      waiting: 0,
      scheduled: 0,
    });
    expect(
      repository
        .listOwned("actor-c", { status: "ready" })
        .map((o) => o.id)
        .sort()
    ).toEqual(["grandparent-existing", "child-work"].sort());
  });

  it("leaves root/no-parent inheritance visibly unresolved and validates the recipient", () => {
    repository.create({
      title: "root-work",
      id: "root-work",
      ownerId: "actor-a",
    });

    expect(() => repository.inheritRetiringActorObligationsInternal("actor-a", null)).toThrow(
      "root/no-parent behavior is unresolved (ISSUE_NUM Q69)"
    );
    expect(() => repository.inheritRetiringActorObligationsInternal("actor-a", "unknown")).toThrow(
      "actor owner does not exist: unknown"
    );
    expect(repository.require("root-work").ownerId).toEqual("actor-a");
  });

  it("enforces reserved status and relational invariants at the persistence boundary", () => {
    const insert = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_id, intent, external_ref, status, priority)
       VALUES (?, ?, ?, NULL, NULL, ?, 0)`
    );
    expect(() => insert.run("snoozed", null, "actor-a", "snoozed")).toThrow(
      "CHECK constraint failed"
    );
    expect(() => insert.run("ownerless", null, " ", "ready")).toThrow("CHECK constraint failed");
    expect(() => insert.run("self", "self", "actor-a", "ready")).toThrow("CHECK constraint failed");
  });

  it("enforces recurrence invariants at the migration's CHECK constraint, not just repository validation", () => {
    const insertCron = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_id, status, priority, recurrence_policy, recurrence_cron, recurrence_interval_seconds)
       VALUES (?, NULL, 'actor-a', 'ready', 0, 'cron', ?, NULL)`
    );
    // An empty (or whitespace-only) cron string must be rejected at the DB layer too.
    expect(() => insertCron.run("empty-cron", "")).toThrow("CHECK constraint failed");
    expect(() => insertCron.run("blank-cron", "   ")).toThrow("CHECK constraint failed");
    expect(() => insertCron.run("ok-cron", "0 * * * *")).not.toThrow();

    const insertInterval = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_id, status, priority, recurrence_policy, recurrence_cron, recurrence_interval_seconds)
       VALUES (?, NULL, 'actor-a', 'ready', 0, 'completion_interval', NULL, ?)`
    );
    // SQLite's dynamic typing would otherwise let a REAL slip past a bare `> 0` check.
    expect(() => insertInterval.run("fractional-interval", 1.5)).toThrow("CHECK constraint failed");
    expect(() => insertInterval.run("zero-interval", 0)).toThrow("CHECK constraint failed");
    expect(() => insertInterval.run("negative-interval", -60)).toThrow("CHECK constraint failed");
    expect(() => insertInterval.run("ok-interval", 60)).not.toThrow();
  });

  describe("list and listPage", () => {
    it("filters obligations by ownerId, status, and rootsOnly with pagination", () => {
      repository.create({
        title: "root-1",
        id: "root-1",
        ownerId: "actor-a",
      });
      repository.create({
        title: "root-2",
        id: "root-2",
        ownerId: "human:operator",
      });
      repository.create({
        title: "child-1",
        id: "child-1",
        parentId: "root-1",
        ownerId: "actor-a",
      });
      repository.setTerminalStatus("root-2", "done");

      const all = repository.list();
      expect(all.map((o) => o.id).sort()).toEqual(["child-1", "root-1", "root-2"].sort());

      const roots = repository.list({ rootsOnly: true });
      expect(roots.map((o) => o.id).sort()).toEqual(["root-1", "root-2"].sort());

      const actorA = repository.list({ ownerId: "actor-a" });
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
        title: "parent",
        id: "parent",
        ownerId: "actor-a",
        externalRef: "github:dummy-org/dummy-repo/issues/1636",
        priority: 42.5,
      });
      repository.create({
        title: "child",
        id: "child",
        parentId: "parent",
        ownerId: "actor-b",
      });

      const before = repository.require("parent");
      // `updatedAt` is excluded from the identity comparison because reassigning
      // is a mutation and must advance it; that it advances is asserted in the
      // timestamp tests. Comparing the rest pins that nothing ELSE moved.
      const identity = ({ ownerId: _ownerId, updatedAt: _updatedAt, ...rest }: Obligation) => rest;

      const humanOwned = repository.reassign("parent", "human:operator");
      expect(identity(humanOwned)).toEqual(identity(before));
      expect(humanOwned.ownerId).toEqual("human:operator");
      expect(repository.listOwned("actor-a")).toEqual([]);
      expect(repository.listOwned("human:operator").map((o) => o.id)).toEqual(["parent"]);

      const actorOwned = repository.reassign("parent", "actor-c");
      expect(identity(actorOwned)).toEqual(identity(before));
      expect(actorOwned.ownerId).toEqual("actor-c");
      expect(repository.getTree("parent").children[0].obligation.id).toBe("child");
    });

    it("validates actor targets, permits same-owner no-op, and rejects terminal obligations", () => {
      const task = repository.create({
        title: "task",
        id: "task",
        ownerId: "actor-a",
      });
      expect(repository.reassign("task", task.ownerId)).toEqual(task);
      expect(() => repository.reassign("task", "missing")).toThrow("actor owner does not exist");
      repository.setTerminalStatus("task", "done");
      expect(() => repository.reassign("task", "human:operator")).toThrow(
        "terminal obligations cannot be reassigned"
      );
    });
  });

  describe("reparent", () => {
    it("reparents a child to a new parent, updating both parents' ready/waiting states", () => {
      const p1 = repository.create({
        title: "parent-1",
        id: "parent-1",
        ownerId: "actor-a",
      });
      const p2 = repository.create({
        title: "parent-2",
        id: "parent-2",
        ownerId: "actor-a",
      });
      repository.create({
        title: "child-1",
        id: "child-1",
        parentId: "parent-1",
        ownerId: "actor-a",
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
      repository.create({
        title: "parent-1",
        id: "parent-1",
        ownerId: "actor-a",
      });
      const child = repository.create({
        title: "child-1",
        id: "child-1",
        parentId: "parent-1",
        ownerId: "actor-a",
      });
      expect(child.priority).toBeNull();

      const reparented = repository.reparent("child-1", null);
      expect(reparented.parentId).toBeNull();
      expect(reparented.priority).toBeTypeOf("number");
      expect(Number.isFinite(reparented.priority)).toBe(true);
      expect(repository.require("parent-1").status).toBe("ready");
    });

    it("preserves explicit priority when reparenting", () => {
      repository.create({
        title: "p1",
        id: "p1",
        ownerId: "actor-a",
      });
      repository.create({
        title: "p2",
        id: "p2",
        ownerId: "actor-a",
      });
      repository.create({
        title: "c1",
        id: "c1",
        parentId: "p1",
        ownerId: "actor-a",
        priority: 42.5,
      });

      const reparented = repository.reparent("c1", "p2");
      expect(reparented.priority).toBe(42.5);
      expect(reparented.parentId).toBe("p2");
    });

    it("rejects reparenting to self, cycle creation, terminal parent, and terminal target", () => {
      repository.create({
        title: "root-a",
        id: "root-a",
        ownerId: "actor-a",
      });
      repository.create({
        title: "child-a",
        id: "child-a",
        parentId: "root-a",
        ownerId: "actor-a",
      });
      repository.create({
        title: "grandchild-a",
        id: "grandchild-a",
        parentId: "child-a",
        ownerId: "actor-a",
      });
      repository.create({
        title: "terminal-root",
        id: "terminal-root",
        ownerId: "actor-a",
      });
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

  describe("recurrence, scheduling, and the completion ledger", () => {
    let scheduler: FakeObligationScheduler;

    beforeEach(() => {
      scheduler = new FakeObligationScheduler();
      repository.setOsScheduler(scheduler);
      repository.create({ title: "rec", id: "rec-1", ownerId: "actor-a", intent: "recur" });
    });

    it("completing a never-recurring ready obligation makes no scheduler call (#227)", () => {
      const scheduleSpy = vi.spyOn(scheduler, "scheduleObligationActivation");
      const cancelSpy = vi.spyOn(scheduler, "cancelObligationActivation");
      repository.setTerminalStatus("rec-1", "done");
      expect(scheduleSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it("cancelling a never-recurring waiting obligation makes no scheduler call (#227)", () => {
      const scheduleSpy = vi.spyOn(scheduler, "scheduleObligationActivation");
      const cancelSpy = vi.spyOn(scheduler, "cancelObligationActivation");
      repository.setTerminalStatus("rec-1", "cancelled");
      expect(scheduleSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it("rejects an invalid cron expression or non-positive interval without mutating", () => {
      expect(() => repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "bad" })).toThrow(
        "invalid cron expression"
      );
      expect(() =>
        repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 0 })
      ).toThrow("recurrence interval must be a positive integer");
      expect(() =>
        repository.setRecurrence("rec-1", {
          policy: "completion_interval",
          intervalSeconds: 1.5,
        })
      ).toThrow("recurrence interval must be a positive integer");
      expect(repository.require("rec-1").recurrencePolicy).toBeNull();
      expect(scheduler.activations.size).toBe(0);
    });

    it("rejects a calendar-impossible cron expression before persisting recurrence", () => {
      expect(() =>
        repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 0 31 2 *" })
      ).toThrow("cron expression can never fire");
      expect(repository.require("rec-1").recurrencePolicy).toBeNull();
      expect(scheduler.activations.size).toBe(0);
    });

    it("rejects setting or disabling recurrence on a terminal obligation", () => {
      repository.setTerminalStatus("rec-1", "done");
      expect(() =>
        repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" })
      ).toThrow("terminal obligations cannot be recurring");
      expect(() => repository.setRecurrence("rec-1", null)).toThrow(
        "terminal obligations cannot be recurring"
      );
    });

    it("rejects enabling recurrence on an obligation already named as a prerequisite (#212)", () => {
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["rec-1"],
      });

      expect(() =>
        repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" })
      ).toThrow(/recurring or scheduled/);
      expect(() =>
        repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 60 })
      ).toThrow(/recurring or scheduled/);
      expect(repository.require("rec-1").recurrencePolicy).toBeNull();
      // Disabling recurrence is not naming it as one, so it stays unaffected by the guard.
      expect(() => repository.setRecurrence("rec-1", null)).not.toThrow();
    });

    it("sets a cron policy on a ready obligation without touching next_ready_at, and arms the OS entry", () => {
      const updated = repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      expect(updated.status).toBe("ready");
      expect(updated.recurrencePolicy).toBe("cron");
      expect(updated.recurrenceCron).toBe("0 * * * *");
      expect(updated.nextReadyAt).toBeNull();
      expect(scheduler.activations.get("rec-1")).toEqual({ kind: "cron", cronExpr: "0 * * * *" });
    });

    it("completing a cron-recurring obligation moves it to scheduled, ledgers the completion, and leaves the cron entry armed", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "30 4 * * *" });
      const done = repository.setTerminalStatus("rec-1", "done", "cycle one");
      expect(done.status).toBe("scheduled");
      expect(done.recurrencePolicy).toBe("cron");
      expect(done.nextReadyAt).not.toBeNull();

      const page = repository.listCompletionsPage("rec-1", { limit: 10, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.completions[0]).toMatchObject({
        obligationId: "rec-1",
        sequence: 1,
        note: "cycle one",
        nextReadyAt: done.nextReadyAt,
      });
      // The cron entry stays armed across the cycle — no extra OS job needed.
      expect(scheduler.activations.get("rec-1")).toEqual({
        kind: "cron",
        cronExpr: "30 4 * * *",
      });
    });

    it("rejects completing a scheduled obligation as done until it returns to ready", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "30 4 * * *" });
      repository.setTerminalStatus("rec-1", "done");
      expect(() => repository.setTerminalStatus("rec-1", "done")).toThrow(
        "scheduled obligations cannot be completed until they are ready"
      );
    });

    it("cancelling a scheduled recurring obligation clears recurrence columns and cancels the OS entry", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "30 4 * * *" });
      repository.setTerminalStatus("rec-1", "done");
      const cancelled = repository.setTerminalStatus("rec-1", "cancelled");
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.recurrencePolicy).toBeNull();
      expect(cancelled.recurrenceCron).toBeNull();
      expect(cancelled.nextReadyAt).toBeNull();
      expect(scheduler.cancelled).toContain("rec-1");
      expect(scheduler.activations.has("rec-1")).toBe(false);
    });

    it("completing a completion_interval obligation schedules a one-off `at` activation at completedAt + interval", () => {
      repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 60 });
      const done = repository.setTerminalStatus("rec-1", "done");
      expect(done.status).toBe("scheduled");
      expect(done.nextReadyAt).toBe(
        new Date(Date.parse(done.updatedAt as string) + 60_000).toISOString()
      );
      const armed = scheduler.activations.get("rec-1");
      expect(armed?.kind).toBe("at");
      expect((armed as { kind: "at"; date: Date }).date.toISOString()).toBe(done.nextReadyAt);
    });

    it("disabling recurrence on a non-scheduled obligation clears columns without changing status", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      const updated = repository.setRecurrence("rec-1", null);
      expect(updated.status).toBe("ready");
      expect(updated.recurrencePolicy).toBeNull();
      expect(scheduler.cancelled).toContain("rec-1");
    });

    it("disabling recurrence on a scheduled obligation forfeits the pending cycle and finalizes as done", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("rec-1", "done");
      const disabled = repository.setRecurrence("rec-1", null);
      expect(disabled.status).toBe("done");
      expect(disabled.recurrencePolicy).toBeNull();
      expect(disabled.nextReadyAt).toBeNull();
      expect(disabled.hasCompletionHistory).toBe(true);
      expect("completionsTotal" in disabled).toBe(false);
      expect(scheduler.cancelled).toContain("rec-1");
    });

    it("switching a scheduled obligation's policy to cron computes a fresh next_ready_at in the same statement", () => {
      repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 60 });
      repository.setTerminalStatus("rec-1", "done");
      expect(repository.require("rec-1").status).toBe("scheduled");

      // The CHECK constraint requires a non-null next_ready_at throughout —
      // this must not throw a SQLITE_CONSTRAINT error.
      const switched = repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      expect(switched.status).toBe("scheduled");
      expect(switched.recurrencePolicy).toBe("cron");
      expect(switched.nextReadyAt).not.toBeNull();
      expect(scheduler.activations.get("rec-1")).toMatchObject({ kind: "cron" });
    });

    it("switching a scheduled obligation to completion_interval with an overdue interval returns it to ready immediately", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("rec-1", "done");
      // Back-date the completion so any positive interval is already overdue,
      // independent of the fixture clock's own small increasing values.
      db.prepare(`UPDATE obligation_completions SET completed_at = ? WHERE obligation_id = ?`).run(
        "1960-01-01T00:00:00.000Z",
        "rec-1"
      );

      const switched = repository.setRecurrence("rec-1", {
        policy: "completion_interval",
        intervalSeconds: 1,
      });
      expect(switched.status).toBe("ready");
      expect(switched.nextReadyAt).toBeNull();
      expect(switched.recurrencePolicy).toBe("completion_interval");
      expect(scheduler.cancelled).toContain("rec-1");
    });

    it("rejects naming a prerequisite for a dependent that is currently scheduled", () => {
      repository.create({ title: "blocker", id: "blocker-1", ownerId: "actor-a", intent: "block" });
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("rec-1", "done");
      expect(repository.require("rec-1").status).toBe("scheduled");

      // A scheduled row re-arms on its own cycle independent of any wait-for
      // graph (#212) — it cannot pick up a prerequisite while armed, whether
      // via addPrerequisite or by re-enabling recurrence with one already
      // named, since neither direction of that edge is ever allowed to exist.
      expect(() => repository.addPrerequisite("rec-1", "blocker-1")).toThrow(
        /recurring or scheduled/
      );
    });

    it("switching a scheduled obligation to completion_interval with a future interval stays scheduled and re-arms an `at` job", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("rec-1", "done");

      const switched = repository.setRecurrence("rec-1", {
        policy: "completion_interval",
        intervalSeconds: 999_999_999,
      });
      expect(switched.status).toBe("scheduled");
      expect(switched.nextReadyAt).not.toBeNull();
      const armed = scheduler.activations.get("rec-1");
      expect(armed?.kind).toBe("at");
      expect((armed as { kind: "at"; date: Date }).date.toISOString()).toBe(switched.nextReadyAt);
    });

    it("switching recurrence policy while not scheduled has no lastCompletion to react to, and is a plain column update", () => {
      const updated = repository.setRecurrence("rec-1", {
        policy: "completion_interval",
        intervalSeconds: 30,
      });
      expect(updated.status).toBe("ready");
      expect(updated.recurrenceIntervalSeconds).toBe(30);
      expect(updated.nextReadyAt).toBeNull();
      expect(scheduler.cancelled).toContain("rec-1");
    });

    it("activateScheduled returns a scheduled obligation to ready and clears next_ready_at", () => {
      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      repository.setTerminalStatus("rec-1", "done");
      expect(repository.require("rec-1").status).toBe("scheduled");

      const activated = repository.activateScheduled("rec-1");
      expect(activated?.status).toBe("ready");
      expect(activated?.nextReadyAt).toBeNull();
    });

    it("activateScheduled is a no-op for a non-scheduled obligation and null for a missing one", () => {
      const unchanged = repository.activateScheduled("rec-1");
      expect(unchanged?.status).toBe("ready");
      expect(repository.activateScheduled("does-not-exist")).toBeNull();
    });

    it("paginates the completion ledger newest-sequence-first with hasMore/total", () => {
      repository.setRecurrence("rec-1", {
        policy: "completion_interval",
        intervalSeconds: 999_999_999,
      });
      for (let i = 0; i < 3; i++) {
        repository.setTerminalStatus("rec-1", "done", `cycle ${i}`);
        repository.activateScheduled("rec-1");
      }

      const page1 = repository.listCompletionsPage("rec-1", { limit: 2, offset: 0 });
      expect(page1.total).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.completions.map((c) => c.sequence)).toEqual([3, 2]);

      const page2 = repository.listCompletionsPage("rec-1", { limit: 2, offset: 2 });
      expect(page2.hasMore).toBe(false);
      expect(page2.completions.map((c) => c.sequence)).toEqual([1]);
    });

    it("commits the policy change even when the OS scheduler call fails, instead of rolling it back", () => {
      vi.useFakeTimers();
      let attempts = 0;
      scheduler.scheduleObligationActivation = () => {
        attempts++;
        if (attempts === 1) throw new Error("crontab write failed");
      };

      expect(() =>
        repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" })
      ).not.toThrow();
      expect(attempts).toBe(1);
      vi.runAllTimers();
      expect(attempts).toBe(2);
      vi.useRealTimers();

      // The database write is not an OS side effect and must not roll back
      // with it; a bounded post-commit retry re-derives the scheduler job from
      // the policy that actually committed.
      const row = repository.require("rec-1");
      expect(row.recurrencePolicy).toBe("cron");
      expect(row.recurrenceCron).toBe("0 * * * *");
    });

    it("bounds post-commit scheduler reconciliation retries", () => {
      vi.useFakeTimers();
      let attempts = 0;
      scheduler.scheduleObligationActivation = () => {
        attempts++;
        throw new Error("persistent crontab failure");
      };

      repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      vi.runAllTimers();
      // One committed mutation plus the two explicitly bounded retries.
      expect(attempts).toBe(3);
      vi.useRealTimers();
    });

    it("replaces a switched-away completion_interval `at` job with the new cron job outside the transaction", () => {
      const scheduleCalls: string[] = [];
      const originalCancel = scheduler.cancelObligationActivation.bind(scheduler);
      const originalSchedule = scheduler.scheduleObligationActivation.bind(scheduler);
      scheduler.cancelObligationActivation = (id) => {
        scheduleCalls.push(`cancel:${id}`);
        originalCancel(id);
      };
      scheduler.scheduleObligationActivation = (id, time) => {
        scheduleCalls.push(`schedule:${id}:${time.kind}`);
        originalSchedule(id, time);
      };

      repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 60 });
      repository.setTerminalStatus("rec-1", "done");
      scheduleCalls.length = 0;

      const switched = repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
      expect(switched.recurrencePolicy).toBe("cron");
      // Exactly one reconciliation call for the id, derived from the row the
      // transaction actually committed — not a remove-then-install pair that
      // could be interrupted mid-way while still inside the transaction.
      expect(scheduleCalls).toEqual(["schedule:rec-1:cron"]);
    });

    describe("reconcileScheduledObligations (boot reconciliation)", () => {
      it("re-arms a cron entry regardless of the obligation's current status", () => {
        repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
        scheduler.activations.clear(); // simulate a restart: nothing armed yet
        repository.reconcileScheduledObligations();
        expect(scheduler.activations.get("rec-1")).toEqual({ kind: "cron", cronExpr: "0 * * * *" });
      });

      it("activates an overdue scheduled obligation immediately instead of arming a past OS job", () => {
        repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 1 });
        repository.setTerminalStatus("rec-1", "done");
        db.prepare(`UPDATE obligations SET next_ready_at = ? WHERE id = ?`).run(
          "1960-01-01T00:00:00.000Z",
          "rec-1"
        );
        scheduler.activations.clear();

        repository.reconcileScheduledObligations();
        expect(repository.require("rec-1").status).toBe("ready");
        expect(scheduler.activations.has("rec-1")).toBe(false);
      });

      it("arms a future `at` job for a scheduled obligation that has not yet come due", () => {
        repository.setRecurrence("rec-1", { policy: "completion_interval", intervalSeconds: 1 });
        repository.setTerminalStatus("rec-1", "done");
        db.prepare(`UPDATE obligations SET next_ready_at = ? WHERE id = ?`).run(
          "2999-01-01T00:00:00.000Z",
          "rec-1"
        );
        scheduler.activations.clear();

        repository.reconcileScheduledObligations();
        expect(repository.require("rec-1").status).toBe("scheduled");
        expect(scheduler.activations.get("rec-1")).toEqual({
          kind: "at",
          date: new Date("2999-01-01T00:00:00.000Z"),
        });
      });

      it("cancels an orphaned OS activation for an obligation that no longer needs one", () => {
        scheduler.activations.set("ghost-id", { kind: "cron", cronExpr: "0 * * * *" });
        repository.reconcileScheduledObligations();
        expect(scheduler.cancelled).toContain("ghost-id");
        expect(scheduler.activations.has("ghost-id")).toBe(false);
      });

      it("keeps reconciling other rows when one row's OS scheduler call fails (e.g. `at` confirmed unavailable)", () => {
        repository.create({ title: "iv", id: "rec-2", ownerId: "actor-a", intent: "recur" });
        repository.setRecurrence("rec-1", { policy: "cron", cronExpr: "0 * * * *" });
        repository.setRecurrence("rec-2", { policy: "completion_interval", intervalSeconds: 1 });
        repository.setTerminalStatus("rec-2", "done");
        db.prepare(`UPDATE obligations SET next_ready_at = ? WHERE id = ?`).run(
          "2999-01-01T00:00:00.000Z",
          "rec-2"
        );
        scheduler.activations.clear();
        const original = scheduler.scheduleObligationActivation.bind(scheduler);
        scheduler.scheduleObligationActivation = (id, time) => {
          if (time.kind === "at") throw new Error("`at` scheduling is unavailable: at missing");
          original(id, time);
        };

        expect(() => repository.reconcileScheduledObligations()).not.toThrow();
        // rec-2's `at`-kind reconciliation failed and was logged, but rec-1's
        // cron reconciliation still ran — one row's OS failure must not abort
        // the sweep for every other row queued behind it.
        expect(scheduler.activations.get("rec-1")).toEqual({ kind: "cron", cronExpr: "0 * * * *" });
        expect(scheduler.activations.has("rec-2")).toBe(false);
      });

      it("is a no-op when no OS scheduler is attached", () => {
        const bare = new ObligationRepository(
          db,
          (id) => ["actor-a"].includes(id),
          () => now++
        );
        expect(() => bare.reconcileScheduledObligations()).not.toThrow();
      });
    });
  });

  describe("prerequisite dependencies (#212)", () => {
    it("creates a blocked obligation as waiting outright, with no ready-head event", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });

      const heads: Array<{ ownerId: string; headId: string | null }> = [];
      repository.setReadyHeadListener(({ ownerId, head }) =>
        heads.push({ ownerId, headId: head?.id ?? null })
      );

      const dependent = repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      expect(dependent.status).toBe("waiting");
      // Never observed ready, not even transiently within the same transaction.
      expect(heads).toEqual([]);
    });

    it("creates ready outright when every named prerequisite is already done", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.setTerminalStatus("prereq", "done");

      const dependent = repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });
      expect(dependent.status).toBe("ready");
    });

    it("releases every dependent fanned out from one prerequisite once it's done", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dep-1",
        id: "dep-1",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });
      repository.create({
        title: "dep-2",
        id: "dep-2",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });
      expect(repository.require("dep-1").status).toBe("waiting");
      expect(repository.require("dep-2").status).toBe("waiting");

      repository.setTerminalStatus("prereq", "done");

      expect(repository.require("dep-1").status).toBe("ready");
      expect(repository.require("dep-2").status).toBe("ready");
    });

    it("keeps a dependent waiting while any one of several prerequisites is unmet", () => {
      repository.create({ title: "p1", id: "p1", ownerId: "actor-a" });
      repository.create({ title: "p2", id: "p2", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["p1", "p2"],
      });

      repository.setTerminalStatus("p1", "done");
      expect(repository.require("dependent").status).toBe("waiting");

      repository.setTerminalStatus("p2", "done");
      expect(repository.require("dependent").status).toBe("ready");
    });

    it("does not release a dependent when its prerequisite is cancelled, and retains the edge", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      repository.setTerminalStatus("prereq", "cancelled");

      expect(repository.require("dependent").status).toBe("waiting");
      expect(
        repository.listBlockedByPage("dependent", { limit: 10, offset: 0 }).obligations
      ).toHaveLength(1);
    });

    it("queues durable cancellation-repair attention for each affected dependent, and delivers it after commit", () => {
      const delivered: Array<{ dependentId: string; prerequisiteId: string }> = [];
      repository.setCancellationAttentionListener((attention) => delivered.push(attention));

      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dep-1",
        id: "dep-1",
        ownerId: "actor-b",
        blockedBy: ["prereq"],
      });
      repository.create({
        title: "dep-2",
        id: "dep-2",
        ownerId: "actor-c",
        blockedBy: ["prereq"],
      });

      repository.setTerminalStatus("prereq", "cancelled");

      expect(delivered).toEqual(
        expect.arrayContaining([
          { dependentId: "dep-1", dependentOwnerId: "actor-b", prerequisiteId: "prereq" },
          { dependentId: "dep-2", dependentOwnerId: "actor-c", prerequisiteId: "prereq" },
        ])
      );
      expect(delivered).toHaveLength(2);

      // The fact is also recoverable straight from state, for boot reconciliation.
      expect(repository.listPrerequisiteCancellationAttention()).toEqual(
        expect.arrayContaining([
          { dependentId: "dep-1", dependentOwnerId: "actor-b", prerequisiteId: "prereq" },
          { dependentId: "dep-2", dependentOwnerId: "actor-c", prerequisiteId: "prereq" },
        ])
      );
    });

    it("retries a cancellation-repair attention that failed to append, on the next mutation, without a restart", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      let shouldThrow = true;
      const delivered: Array<{ dependentId: string; prerequisiteId: string }> = [];
      repository.setCancellationAttentionListener((attention) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("transient append failure");
        }
        delivered.push(attention);
      });

      repository.setTerminalStatus("prereq", "cancelled");
      expect(delivered).toEqual([]);

      repository.create({ title: "unrelated", id: "unrelated", ownerId: "actor-a" });

      expect(delivered).toEqual([
        { dependentId: "dependent", dependentOwnerId: "actor-a", prerequisiteId: "prereq" },
      ]);
      warn.mockRestore();
    });

    it("retries both failed cancellation-repair attentions when the two id pairs collide under a delimiter join (#212)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Obligation ids are opaque non-empty strings, so a space is legal
      // inside one: `("dep 1", "gate")` and `("dep", "1 gate")` are different
      // edges that a space-joined retry key cannot tell apart.
      repository.create({ title: "gate", id: "gate", ownerId: "actor-a" });
      repository.create({ title: "one gate", id: "1 gate", ownerId: "actor-a" });
      repository.create({
        title: "dep one",
        id: "dep 1",
        ownerId: "actor-a",
        blockedBy: ["gate"],
      });
      repository.create({ title: "dep", id: "dep", ownerId: "actor-a", blockedBy: ["1 gate"] });

      let shouldThrow = true;
      const delivered: Array<{
        dependentId: string;
        dependentOwnerId: string;
        prerequisiteId: string;
      }> = [];
      repository.setCancellationAttentionListener((attention) => {
        if (shouldThrow) throw new Error("transient append failure");
        delivered.push(attention);
      });

      repository.setTerminalStatus("gate", "cancelled");
      repository.setTerminalStatus("1 gate", "cancelled");
      expect(delivered).toEqual([]);

      shouldThrow = false;
      repository.create({ title: "unrelated", id: "unrelated", ownerId: "actor-a" });

      expect(delivered).toEqual(
        expect.arrayContaining([
          { dependentId: "dep 1", dependentOwnerId: "actor-a", prerequisiteId: "gate" },
          { dependentId: "dep", dependentOwnerId: "actor-a", prerequisiteId: "1 gate" },
        ])
      );
      expect(delivered).toHaveLength(2);
      warn.mockRestore();
    });

    it("queues cancellation attention immediately when the prerequisite is already cancelled at edge-creation time", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.setTerminalStatus("prereq", "cancelled");

      const delivered: Array<{ dependentId: string; prerequisiteId: string }> = [];
      repository.setCancellationAttentionListener((attention) => delivered.push(attention));

      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-b",
        blockedBy: ["prereq"],
      });

      expect(delivered).toEqual([
        { dependentId: "dependent", dependentOwnerId: "actor-b", prerequisiteId: "prereq" },
      ]);
    });

    it("demotes an already-ready dependent to waiting when addPrerequisite names an already-cancelled prerequisite", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.setTerminalStatus("prereq", "cancelled");
      const dependent = repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
      });
      expect(dependent.status).toBe("ready");

      const delivered: Array<{
        dependentId: string;
        dependentOwnerId: string;
        prerequisiteId: string;
      }> = [];
      repository.setCancellationAttentionListener((attention) => delivered.push(attention));

      repository.addPrerequisite("dependent", "prereq");

      expect(repository.require("dependent").status).toBe("waiting");
      expect(delivered).toEqual([
        { dependentId: "dependent", dependentOwnerId: "actor-a", prerequisiteId: "prereq" },
      ]);
    });

    it("repairs a cancellation-blocked dependent when its owner removes the edge", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });
      repository.setTerminalStatus("prereq", "cancelled");

      repository.removePrerequisite("dependent", "prereq");

      expect(repository.require("dependent").status).toBe("ready");
      expect(repository.listPrerequisiteCancellationAttention()).toEqual([]);
    });

    it("rejects a recurring obligation as a prerequisite, at create and via addPrerequisite", () => {
      repository.create({
        title: "recurring",
        id: "recurring",
        ownerId: "actor-a",
        recurrence: { policy: "cron", cronExpr: "0 * * * *" },
      });
      repository.create({ title: "plain", id: "plain", ownerId: "actor-a" });

      expect(() =>
        repository.create({
          title: "dependent",
          id: "dependent",
          ownerId: "actor-a",
          blockedBy: ["recurring"],
        })
      ).toThrow(/recurring or scheduled/);

      repository.create({ title: "dependent", id: "dependent", ownerId: "actor-a" });
      expect(() => repository.addPrerequisite("dependent", "recurring")).toThrow(
        /recurring or scheduled/
      );
    });

    it("rejects a recurring obligation as a dependent, at create and via addPrerequisite", () => {
      repository.create({
        title: "recurring",
        id: "recurring",
        ownerId: "actor-a",
        recurrence: { policy: "cron", cronExpr: "0 * * * *" },
      });
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });

      expect(() =>
        repository.create({
          title: "dependent",
          id: "dependent",
          ownerId: "actor-a",
          recurrence: { policy: "cron", cronExpr: "0 * * * *" },
          blockedBy: ["prereq"],
        })
      ).toThrow(/recurring or scheduled/);

      expect(() => repository.addPrerequisite("recurring", "prereq")).toThrow(
        /recurring or scheduled/
      );
    });

    it("rejects enabling recurrence on an obligation that already names its own prerequisite (#212)", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      expect(() =>
        repository.setRecurrence("dependent", { policy: "cron", cronExpr: "0 * * * *" })
      ).toThrow(/recurring or scheduled/);
      expect(repository.require("dependent").recurrencePolicy).toBeNull();
    });

    it("rejects an obligation naming itself as its own prerequisite, at create and via addPrerequisite", () => {
      expect(() =>
        repository.create({ title: "b", id: "b", ownerId: "actor-a", blockedBy: ["b"] })
      ).toThrow(/blocked by itself/);

      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      expect(() => repository.addPrerequisite("a", "a")).toThrow(/blocked by itself/);
    });

    it("rejects a direct two-node cycle via addPrerequisite", () => {
      repository.create({ title: "a", id: "a", ownerId: "actor-a" });
      repository.create({ title: "b", id: "b", ownerId: "actor-a" });
      repository.addPrerequisite("a", "b");
      expect(() => repository.addPrerequisite("b", "a")).toThrow(/cycle/);
    });

    it("rejects creating a child that names its own new parent as a prerequisite", () => {
      // wouldCreateCycle(parentId, prerequisiteId) asks whether parentId is
      // reachable *from* prerequisiteId — never reflexively true for
      // prerequisiteId === parentId with no self-loop, so this exact case
      // needs its own check rather than relying on the graph walk.
      repository.create({ title: "p", id: "p", ownerId: "actor-a" });

      expect(() =>
        repository.create({
          title: "c",
          id: "c",
          ownerId: "actor-a",
          parentId: "p",
          blockedBy: ["p"],
        })
      ).toThrow(/cycle/);
    });

    it("rejects a cycle formed by combining an explicit edge with the parent-child hierarchy", () => {
      // parent "p" has live child "c"; naming p as a prerequisite of c would
      // make p wait for c (hierarchy) while c waits for p (explicit) — a cycle.
      repository.create({ title: "p", id: "p", ownerId: "actor-a" });
      repository.create({ title: "c", id: "c", ownerId: "actor-a", parentId: "p" });

      expect(() => repository.addPrerequisite("c", "p")).toThrow(/cycle/);
    });

    it("rejects creating a child whose declared prerequisite already transitively waits for the new parent", () => {
      // "gp" already waits for its live child "p" (hierarchy). Making a new
      // child of "p" depend on "gp" would close the loop: gp -> p -> new-child
      // -> gp, the moment the new child's insert lands.
      repository.create({ title: "gp", id: "gp", ownerId: "actor-a" });
      repository.create({ title: "p", id: "p", ownerId: "actor-a", parentId: "gp" });

      expect(() =>
        repository.create({
          title: "new-child",
          id: "new-child",
          ownerId: "actor-a",
          parentId: "p",
          blockedBy: ["gp"],
        })
      ).toThrow(/cycle/);
    });

    it("rejects reparenting an obligation onto something that already transitively waits for it", () => {
      repository.create({ title: "p", id: "p", ownerId: "actor-a" });
      repository.create({ title: "dependent", id: "dependent", ownerId: "actor-a" });
      repository.create({
        title: "gate",
        id: "gate",
        ownerId: "actor-a",
        blockedBy: ["dependent"],
      });
      // gate waits for dependent; reparenting dependent under gate would add
      // gate-waits-for-dependent (hierarchy) on top of the existing edge, and
      // dependent has no path back to gate yet — so make gate the one being
      // moved under dependent instead, which does create the cycle.
      expect(() => repository.reparent("gate", "dependent")).toThrow(/already waits for/);
    });

    it("preserves prerequisite edges across reassignment", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      repository.reassign("dependent", "actor-b");

      expect(repository.require("dependent").ownerId).toBe("actor-b");
      expect(
        repository
          .listBlockedByPage("dependent", { limit: 10, offset: 0 })
          .obligations.map((o) => o.id)
      ).toEqual(["prereq"]);
      repository.setTerminalStatus("prereq", "done");
      expect(repository.require("dependent").status).toBe("ready");
    });

    it("re-delivers cancellation-repair attention to the new owner immediately on reassign, not only after restart", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });
      repository.setTerminalStatus("prereq", "cancelled");

      const delivered: Array<{
        dependentId: string;
        dependentOwnerId: string;
        prerequisiteId: string;
      }> = [];
      repository.setCancellationAttentionListener((attention) => delivered.push(attention));

      repository.reassign("dependent", "actor-b");

      expect(delivered).toEqual([
        { dependentId: "dependent", dependentOwnerId: "actor-b", prerequisiteId: "prereq" },
      ]);
    });

    it("re-delivers cancellation-repair attention to the inheriting owner on retirement inheritance", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-b",
        blockedBy: ["prereq"],
      });
      repository.setTerminalStatus("prereq", "cancelled");

      const delivered: Array<{
        dependentId: string;
        dependentOwnerId: string;
        prerequisiteId: string;
      }> = [];
      repository.setCancellationAttentionListener((attention) => delivered.push(attention));

      repository.inheritRetiringActorObligationsInternal("actor-b", "actor-a");

      expect(delivered).toEqual([
        { dependentId: "dependent", dependentOwnerId: "actor-a", prerequisiteId: "prereq" },
      ]);
      expect(repository.require("dependent").ownerId).toBe("actor-a");
    });

    it("does not queue immediate cancellation attention for a dependent that already reached a terminal status", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });
      repository.setTerminalStatus("dependent", "cancelled");

      const delivered: Array<{
        dependentId: string;
        dependentOwnerId: string;
        prerequisiteId: string;
      }> = [];
      repository.setCancellationAttentionListener((attention) => delivered.push(attention));

      repository.setTerminalStatus("prereq", "cancelled");

      expect(delivered).toEqual([]);
      expect(repository.listPrerequisiteCancellationAttention()).toEqual([]);
    });

    it("survives a repository restart (reload from the same on-disk state)", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      // Simulate a fresh process attaching to the same database.
      const reloaded = new ObligationRepository(
        db,
        (id) => ["actor-a", "actor-b", "actor-c"].includes(id),
        () => now++
      );

      expect(reloaded.require("dependent").status).toBe("waiting");
      expect(
        reloaded
          .listBlockedByPage("dependent", { limit: 10, offset: 0 })
          .obligations.map((o) => o.id)
      ).toEqual(["prereq"]);

      reloaded.setTerminalStatus("prereq", "done");
      expect(reloaded.require("dependent").status).toBe("ready");
    });

    it("survives compaction (VACUUM) with edges and readiness intact", () => {
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["prereq"],
      });

      db.exec("VACUUM");

      expect(repository.require("dependent").status).toBe("waiting");
      repository.setTerminalStatus("prereq", "done");
      expect(repository.require("dependent").status).toBe("ready");
    });

    it("paginates blockedBy and unblocks projections like sibling projections do", () => {
      repository.create({ title: "p1", id: "p1", ownerId: "actor-a" });
      repository.create({ title: "p2", id: "p2", ownerId: "actor-a" });
      repository.create({ title: "p3", id: "p3", ownerId: "actor-a" });
      repository.create({
        title: "dependent",
        id: "dependent",
        ownerId: "actor-a",
        blockedBy: ["p1", "p2", "p3"],
      });

      const page1 = repository.listBlockedByPage("dependent", { limit: 2, offset: 0 });
      expect(page1.obligations.map((o) => o.id)).toEqual(["p1", "p2"]);
      expect(page1.total).toBe(3);
      expect(page1.hasMore).toBe(true);

      const page2 = repository.listBlockedByPage("dependent", { limit: 2, offset: 2 });
      expect(page2.obligations.map((o) => o.id)).toEqual(["p3"]);
      expect(page2.hasMore).toBe(false);

      const unblocks = repository.listUnblocksPage("p1", { limit: 10, offset: 0 });
      expect(unblocks.obligations.map((o) => o.id)).toEqual(["dependent"]);
      expect(unblocks.total).toBe(1);
    });

    it("adding a not-yet-done prerequisite to an already-ready obligation demotes it back to waiting", () => {
      repository.create({ title: "dependent", id: "dependent", ownerId: "actor-a" });
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      expect(repository.require("dependent").status).toBe("ready");

      repository.addPrerequisite("dependent", "prereq");
      expect(repository.require("dependent").status).toBe("waiting");

      repository.setTerminalStatus("prereq", "done");
      expect(repository.require("dependent").status).toBe("ready");
    });

    it("adding the same prerequisite edge twice is a no-op", () => {
      repository.create({ title: "dependent", id: "dependent", ownerId: "actor-a" });
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      repository.addPrerequisite("dependent", "prereq");
      expect(() => repository.addPrerequisite("dependent", "prereq")).not.toThrow();
      expect(
        repository.listBlockedByPage("dependent", { limit: 10, offset: 0 }).obligations
      ).toHaveLength(1);
    });

    it("removing a nonexistent edge is a no-op", () => {
      repository.create({ title: "dependent", id: "dependent", ownerId: "actor-a" });
      repository.create({ title: "prereq", id: "prereq", ownerId: "actor-a" });
      expect(() => repository.removePrerequisite("dependent", "prereq")).not.toThrow();
    });
  });
});
