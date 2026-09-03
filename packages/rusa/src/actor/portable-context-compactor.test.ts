import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactPortableContext } from "../commands/start.js";
import * as dbIdx from "../db/index.js";
import { runMigrations } from "../db/migrations/runner.js";
import {
  ActorRunRepository,
  type PortableLedgerSource,
} from "../db/repositories/actor-run-repository.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import * as geminiUtils from "../understanding/gemini-utils.js";
import {
  applyCompactionOperations,
  DEFAULT_PORTABLE_CONTEXT_COMPACTOR_MODEL,
  describeCompaction,
  GeminiPortableContextCompactor,
  type PortableContextCompactionSummary,
  QUARANTINE_CLASSES,
  QUARANTINE_QUOTE_MAX_BYTES,
  type QuarantineClass,
  quarantineCountsByClass,
  resolvePortableContextCompactorModel,
} from "./portable-context-compactor.js";
import {
  emptyPortableContextState,
  InMemoryPortableContextStore,
  type PortableMemoryItem,
  type PortableMemoryKind,
} from "./portable-context-state.js";

/** A ledger item of a kind that predates ISSUE_NUM's retirement; not buildable via a fold. */
const retiredItem = (
  id: string,
  kind: PortableMemoryKind,
  statement: string
): PortableMemoryItem => ({
  id,
  kind,
  priority: "should",
  status: "active",
  statement,
  evidence: [{ eventId: "seed", sender: "root", ts: "2026-07-01T00:00:00.000Z", quote: statement }],
  updatedAt: "2026-07-01T00:00:00.000Z",
});

const message = (
  id: string,
  body: string,
  ts = "2026-07-21T00:00:00.000Z"
): PortableLedgerSource => ({
  id,
  ts,
  kind: "message_received",
  actorId: "actor-a",
  detail: null,
  body,
  payload: JSON.stringify({ from: "root" }),
  success: null,
});

/** The actor's own end-of-run self-summary: no peer, a complete/blocked detail. */
const yieldNote = (
  id: string,
  body: string,
  detail: "complete" | "blocked",
  ts = "2026-07-21T00:00:00.000Z"
): PortableLedgerSource => ({
  ...message(id, body, ts),
  kind: "run_yielded",
  payload: null,
  detail,
});

/**
 * The full class vector with the named classes overridden.
 *
 * Spelled out rather than derived from QUARANTINE_CLASSES on purpose: adding a
 * class without deciding what the existing expectations say about it should
 * fail here loudly, not be absorbed silently.
 */
const classCounts = (
  overrides: Partial<Record<QuarantineClass, number>>
): Record<QuarantineClass, number> => ({
  "source-outside-batch": 0,
  "quote-not-verbatim": 0,
  "missing-statement": 0,
  "unknown-item": 0,
  "kind-immutable": 0,
  "kind-not-resolvable": 0,
  "kind-retired": 0,
  "self-authored-update": 0,
  "self-authored-supersede": 0,
  "self-authored-add": 0,
  ...overrides,
});

describe("applyCompactionOperations", () => {
  it("adds source-backed memory and advances the message watermark", () => {
    const source = message("m1", "This must run air-gapped with no new dependencies.");
    const result = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [source],
      operations: [
        {
          action: "add",
          itemId: "",
          kind: "constraint",
          priority: "must",
          statement: "Run air-gapped with no new dependencies.",
          sourceEventId: "m1",
          quote: "air-gapped with no new dependencies",
        },
      ],
      now: "2026-07-21T00:01:00.000Z",
      model: "test-model",
    });

    expect(result.state.generation).toBe(1);
    expect(result.state.lastFoldedSourceId).toBe("m1");
    expect(result.state.items[0]).toMatchObject({
      kind: "constraint",
      priority: "must",
      status: "active",
      statement: "Run air-gapped with no new dependencies.",
    });
    expect(result.state.items[0].evidence[0]).toMatchObject({ eventId: "m1", sender: "root" });
  });

  it("supersedes an existing item only with evidence from the new batch", () => {
    const first = message("m1", "Use the standard library only.");
    const initial = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [first],
      operations: [
        {
          action: "add",
          itemId: "",
          kind: "constraint",
          priority: "must",
          statement: "Use the standard library only.",
          sourceEventId: "m1",
          quote: "standard library only",
        },
      ],
      now: first.ts,
      model: "test-model",
    });
    const replacement = message(
      "m2",
      "The registry is available now; external dependencies are allowed."
    );
    const next = applyCompactionOperations({
      actorId: "actor-a",
      state: initial.state,
      messages: [replacement],
      operations: [
        {
          action: "supersede",
          itemId: initial.state.items[0].id,
          kind: "constraint",
          priority: "must",
          statement: "",
          sourceEventId: "m2",
          quote: "external dependencies are allowed",
        },
      ],
      now: replacement.ts,
      model: "test-model",
    });
    expect(next.state.items[0].status).toBe("superseded");
    expect(next.state.items[0].evidence.at(-1)?.eventId).toBe("m2");
  });

  it("isolates faults per-operation without aborting the batch (spec 6a)", () => {
    const m1 = message("m1", "Good info and other stuff");
    const result = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [m1],
      operations: [
        {
          action: "add",
          itemId: "",
          kind: "decision",
          priority: "should",
          statement: "The good item",
          sourceEventId: "m1",
          quote: "Good info",
        },
        {
          action: "add",
          itemId: "",
          kind: "decision",
          priority: "should",
          statement: "The bad item",
          sourceEventId: "m1",
          quote: "absent from body", // bad quote
        },
      ],
      now: m1.ts,
      model: "test-model",
    });

    expect(result.state.items.find((i) => i.statement === "The good item")).toBeDefined();
    expect(result.state.items.find((i) => i.statement === "The bad item")).toBeUndefined();
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].sourceEventId).toBe("m1");
    expect(result.quarantined[0].reason).toContain("not verbatim");
    expect(result.state.lastFoldedSourceId).toBe("m1");
    // The denominator for the quarantine count: 1-of-2, not a bare 1 .
    expect(result.operations).toBe(2);
  });

  it("counts every proposed operation, including the ones that landed ", () => {
    const m1 = message("m1", "Good info and other stuff");
    const both = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [m1],
      operations: [
        {
          action: "add",
          itemId: "",
          kind: "decision",
          priority: "should",
          statement: "The good item",
          sourceEventId: "m1",
          quote: "Good info",
        },
      ],
      now: m1.ts,
      model: "test-model",
    });
    expect(both.operations).toBe(1);
    expect(both.quarantined).toHaveLength(0);

    // Counter-assertion: `operations` tracks what the compactor proposed, not
    // what survived — otherwise it could not serve as a denominator.
    const none = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [m1],
      operations: [],
      now: m1.ts,
      model: "test-model",
    });
    expect(none.operations).toBe(0);
  });

  it("attributes self-authored evidence to the actor, not to 'unknown' ", () => {
    // A yield note has no peer: the actor is talking about its own run. Left
    // alone that reads as `unknown`, which is the sender an inbound event of
    // genuinely unrecoverable origin gets — the two must not collapse together,
    // because the self/inbound split is how provenance laundering stays visible.
    const note = yieldNote("y1", "All 4,466 tests passed.", "complete");
    const anonymous: PortableLedgerSource = {
      ...message("m1", "All 4,466 tests passed."),
      payload: null,
    };
    const add = (sourceEventId: string) => ({
      action: "add" as const,
      itemId: "",
      kind: "decision" as const,
      priority: "should" as const,
      statement: "The branch ships only with the full suite green.",
      sourceEventId,
      quote: "4,466 tests passed",
    });

    const result = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [note, anonymous],
      operations: [add("y1"), add("m1")],
      now: note.ts,
      model: "test-model",
    });

    const senders = result.state.items.flatMap((item) =>
      item.evidence.map((evidence) => `${evidence.eventId}:${evidence.sender}`)
    );
    expect(senders).toContain("y1:actor-a");
    // Counter-assertion: the rule is scoped to self-authored kinds, so an
    // inbound event with no recoverable sender is still "unknown" — the fix is
    // not "stamp the actor id whenever peerId is missing".
    expect(senders).toContain("m1:unknown");
  });

  describe("quarantines the five bad operation cases (spec 6c)", () => {
    it("quarantines quote not verbatim (line 56)", () => {
      const m1 = message("m1", "Good info");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [m1],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "decision",
            priority: "should",
            statement: "The bad item",
            sourceEventId: "m1",
            quote: "absent from body",
          },
        ],
        now: m1.ts,
        model: "test-model",
      });
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].reason).toContain("not verbatim");
    });

    it("quarantines cited event outside batch (line 80)", () => {
      const m1 = message("m1", "Good info");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [m1],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "decision",
            priority: "should",
            statement: "The bad item",
            sourceEventId: "m2", // outside batch
            quote: "Good info",
          },
        ],
        now: m1.ts,
        model: "test-model",
      });
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].reason).toContain("outside the input batch");
    });

    it("quarantines add with empty statement (line 85)", () => {
      const m1 = message("m1", "Good info");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [m1],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "decision",
            priority: "should",
            statement: "   ", // empty statement
            sourceEventId: "m1",
            quote: "Good info",
          },
        ],
        now: m1.ts,
        model: "test-model",
      });
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].reason).toContain("add operation requires a statement");
    });

    it("quarantines unknown item id (line 106)", () => {
      const m1 = message("m1", "Good info");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [m1],
        operations: [
          {
            action: "update",
            itemId: "unknown-id",
            kind: "decision",
            priority: "should",
            statement: "Valid statement",
            sourceEventId: "m1",
            quote: "Good info",
          },
        ],
        now: m1.ts,
        model: "test-model",
      });
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].reason).toContain("unknown memory item");
    });

    it("quarantines update with empty statement (line 109)", () => {
      const m1 = message("m1", "Good info");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [m1],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "decision",
            priority: "should",
            statement: "Valid statement",
            sourceEventId: "m1",
            quote: "Good info",
          },
        ],
        now: m1.ts,
        model: "test-model",
      });

      const m2 = message("m2", "Better info");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [m2],
        operations: [
          {
            action: "update",
            itemId: initial.state.items[0].id,
            kind: "decision",
            priority: "should",
            statement: "   ", // empty statement
            sourceEventId: "m2",
            quote: "Better info",
          },
        ],
        now: m2.ts,
        model: "test-model",
      });
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].reason).toContain("update operation requires a statement");
    });
  });

  describe("kind-guard for resolve and supersede ", () => {
    it("quarantines a self-authored resolve of a constraint, leaving it active", () => {
      const initMessage = message("m1", "Must operate in read-only mode, avoiding PRs.");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [initMessage],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Must operate in read-only mode, avoiding PRs.",
            sourceEventId: "m1",
            quote: "read-only mode, avoiding PRs",
          },
        ],
        now: initMessage.ts,
        model: "test-model",
      });
      expect(initial.state.items[0].status).toBe("active");

      // Self-authored yield note trying to resolve the constraint
      const note = yieldNote("y1", "Completed scripted task; read-only respected.", "complete");
      const next = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [note],
        operations: [
          {
            action: "resolve",
            itemId: initial.state.items[0].id,
            kind: "constraint",
            priority: "must",
            statement: "",
            sourceEventId: "y1",
            quote: "read-only respected",
          },
        ],
        now: note.ts,
        model: "test-model",
      });

      expect(next.state.items[0].status).toBe("active");
      expect(next.quarantined).toHaveLength(1);
      expect(next.quarantined[0].reason).toMatch(
        /resolve.*constraint|only commitment and open_question/i
      );
    });

    it("quarantines a resolve of decision and rationale, leaving them active", () => {
      for (const kind of ["decision", "rationale"] as const) {
        const initMsg = message("m1", `Initial ${kind} text.`);
        const initial = applyCompactionOperations({
          actorId: "actor-a",
          state: emptyPortableContextState("actor-a"),
          messages: [initMsg],
          operations: [
            {
              action: "add",
              itemId: "",
              kind,
              priority: "should",
              statement: `Initial ${kind} text.`,
              sourceEventId: "m1",
              quote: `Initial ${kind} text`,
            },
          ],
          now: initMsg.ts,
          model: "test-model",
        });

        const resolveMsg = message("m2", "Done with work.");
        const next = applyCompactionOperations({
          actorId: "actor-a",
          state: initial.state,
          messages: [resolveMsg],
          operations: [
            {
              action: "resolve",
              itemId: initial.state.items[0].id,
              kind,
              priority: "should",
              statement: "",
              sourceEventId: "m2",
              quote: "Done with work",
            },
          ],
          now: resolveMsg.ts,
          model: "test-model",
        });

        expect(next.state.items[0].status).toBe("active");
        expect(next.quarantined).toHaveLength(1);
        expect(next.quarantined[0].reason).toMatch(
          /resolve.*(?:decision|rationale)|only commitment and open_question/i
        );
      }
    });

    it("quarantines self-authored supersession of a constraint, but accepts supersession by a different sender", () => {
      const initMessage = message("m1", "Keep dashboard read-only until auth is ready.");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [initMessage],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Keep dashboard read-only until auth is ready.",
            sourceEventId: "m1",
            quote: "read-only until auth is ready",
          },
        ],
        now: initMessage.ts,
        model: "test-model",
      });

      // Self-authored yield note attempting to supersede the constraint -> quarantined
      const selfNote = yieldNote("y1", "Self-releasing the read-only constraint.", "complete");
      const selfSupersedeResult = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [selfNote],
        operations: [
          {
            action: "supersede",
            itemId: initial.state.items[0].id,
            kind: "constraint",
            priority: "must",
            statement: "",
            sourceEventId: "y1",
            quote: "Self-releasing the read-only constraint",
          },
        ],
        now: selfNote.ts,
        model: "test-model",
      });

      expect(selfSupersedeResult.state.items[0].status).toBe("active");
      expect(selfSupersedeResult.quarantined).toHaveLength(1);
      expect(selfSupersedeResult.quarantined[0].reason).toMatch(
        /self-authored|different sender|authority/i
      );

      // Authority release from a different sender -> accepted
      const authorityMsg = message("m2", "Green-light: take write-side next, releasing read-only.");
      const authoritySupersedeResult = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [authorityMsg],
        operations: [
          {
            action: "supersede",
            itemId: initial.state.items[0].id,
            kind: "constraint",
            priority: "must",
            statement: "",
            sourceEventId: "m2",
            quote: "releasing read-only",
          },
        ],
        now: authorityMsg.ts,
        model: "test-model",
      });

      expect(authoritySupersedeResult.state.items[0].status).toBe("superseded");
      expect(authoritySupersedeResult.quarantined).toHaveLength(0);
    });

    it("quarantines a self-authored update of a constraint's statement, leaving it unchanged ", () => {
      const initMessage = message("m1", "Keep dashboard read-only until auth is ready.");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [initMessage],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Keep dashboard read-only until auth is ready.",
            sourceEventId: "m1",
            quote: "read-only until auth is ready",
          },
        ],
        now: initMessage.ts,
        model: "test-model",
      });
      const constraintId = initial.state.items[0].id;
      expect(initial.state.items[0].statement).toBe(
        "Keep dashboard read-only until auth is ready."
      );
      expect(initial.state.items[0].status).toBe("active");

      // Self-authored yield note attempting to rewrite the constraint statement
      const selfNote = yieldNote(
        "y1",
        "Completed auth checks; rewrote rule to allow writes everywhere.",
        "complete"
      );
      const selfUpdateResult = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [selfNote],
        operations: [
          {
            action: "update",
            itemId: constraintId,
            kind: "constraint",
            priority: "must",
            statement: "Allow writes everywhere.",
            sourceEventId: "y1",
            quote: "allow writes everywhere",
          },
        ],
        now: selfNote.ts,
        model: "test-model",
      });

      // Constraint statement must remain unchanged, status active, and operation quarantined
      expect(selfUpdateResult.state.items[0].statement).toBe(
        "Keep dashboard read-only until auth is ready."
      );
      expect(selfUpdateResult.state.items[0].status).toBe("active");
      expect(selfUpdateResult.state.items[0].evidence).toHaveLength(1);
      expect(selfUpdateResult.state.items[0].evidence[0].eventId).toBe("m1");
      expect(selfUpdateResult.quarantined).toHaveLength(1);
      expect(selfUpdateResult.quarantined[0].quarantineClass).toBe("self-authored-update");
      expect(selfUpdateResult.quarantined[0].reason).toMatch(
        /cannot update.*constraint.*self-authored.*different sender/i
      );
    });

    it("accepts an update of a constraint by a different sender ", () => {
      const initMessage = message("m1", "Keep dashboard read-only until auth is ready.");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [initMessage],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Keep dashboard read-only until auth is ready.",
            sourceEventId: "m1",
            quote: "read-only until auth is ready",
          },
        ],
        now: initMessage.ts,
        model: "test-model",
      });
      const constraintId = initial.state.items[0].id;

      // Inbound authority message updating the constraint statement -> accepted
      const authorityMsg = message(
        "m2",
        "Refinement: Keep dashboard read-only except for staging telemetry."
      );
      const authorityUpdateResult = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [authorityMsg],
        operations: [
          {
            action: "update",
            itemId: constraintId,
            kind: "constraint",
            priority: "must",
            statement: "Keep dashboard read-only except for staging telemetry.",
            sourceEventId: "m2",
            quote: "read-only except for staging telemetry",
          },
        ],
        now: authorityMsg.ts,
        model: "test-model",
      });

      expect(authorityUpdateResult.quarantined).toHaveLength(0);
      expect(authorityUpdateResult.state.items[0].statement).toBe(
        "Keep dashboard read-only except for staging telemetry."
      );
      expect(authorityUpdateResult.state.items[0].evidence).toHaveLength(2);
      expect(authorityUpdateResult.state.items[0].evidence[1].eventId).toBe("m2");
    });

    it("accepts self-authored updates on allowed authorable kinds (decision, rationale) ", () => {
      for (const kind of ["decision", "rationale"] as const) {
        const initMsg = message("m1", `Initial ${kind} statement.`);
        const initial = applyCompactionOperations({
          actorId: "actor-a",
          state: emptyPortableContextState("actor-a"),
          messages: [initMsg],
          operations: [
            {
              action: "add",
              itemId: "",
              kind,
              priority: "should",
              statement: `Initial ${kind} statement.`,
              sourceEventId: "m1",
              quote: `Initial ${kind} statement`,
            },
          ],
          now: initMsg.ts,
          model: "test-model",
        });
        const itemId = initial.state.items[0].id;

        const selfNote = yieldNote(
          "y1",
          `Refined ${kind} based on run progress: updated version.`,
          "complete"
        );
        const updateResult = applyCompactionOperations({
          actorId: "actor-a",
          state: initial.state,
          messages: [selfNote],
          operations: [
            {
              action: "update",
              itemId,
              kind,
              priority: "should",
              statement: `Updated ${kind} version.`,
              sourceEventId: "y1",
              quote: `Refined ${kind} based on run progress`,
            },
          ],
          now: selfNote.ts,
          model: "test-model",
        });

        expect(updateResult.quarantined).toHaveLength(0);
        expect(updateResult.state.items[0].statement).toBe(`Updated ${kind} version.`);
        expect(updateResult.state.items[0].evidence.at(-1)?.sender).toBe("actor-a");
      }
    });

    it("accepts a self-authored supersede of decision and rationale, and still refuses it for a constraint ", () => {
      // The asymmetry this fixes, in one batch: the test directly above proves
      // this same actor may `update` a decision or rationale in place, which
      // DESTROYS the old statement. Superseding preserves it. Gating the
      // preserving form more strictly than the destroying one was backwards
      // for provenance, so the gate is now `constraint`-only — matching `add`
      //  and `update` .
      const peerMsg = message(
        "m1",
        "We ship air-gapped. We chose sqlite for durability. Keep the dashboard read-only until auth is ready."
      );
      const seeded = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [peerMsg],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "decision",
            priority: "should",
            statement: "Ship air-gapped.",
            sourceEventId: "m1",
            quote: "We ship air-gapped",
          },
          {
            action: "add",
            itemId: "",
            kind: "rationale",
            priority: "should",
            statement: "sqlite was chosen for durability.",
            sourceEventId: "m1",
            quote: "chose sqlite for durability",
          },
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Keep the dashboard read-only until auth is ready.",
            sourceEventId: "m1",
            quote: "read-only until auth is ready",
          },
        ],
        now: peerMsg.ts,
        model: "test-model",
      });
      // Seeded from a peer, not the actor: a self-authored constraint `add`
      // would be rejected one gate earlier and this would measure ISSUE_NUM.
      expect(seeded.quarantined).toHaveLength(0);
      const [decision, rationale, constraint] = seeded.state.items;

      const selfNote = yieldNote(
        "y1",
        "Reversing course: we are not air-gapped after all. Postgres replaced sqlite. Self-releasing the read-only constraint.",
        "complete"
      );
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: seeded.state,
        messages: [selfNote],
        operations: [
          {
            action: "supersede",
            itemId: decision.id,
            kind: "decision",
            priority: "should",
            statement: "",
            sourceEventId: "y1",
            quote: "not air-gapped after all",
          },
          {
            action: "supersede",
            itemId: rationale.id,
            kind: "rationale",
            priority: "should",
            statement: "",
            sourceEventId: "y1",
            quote: "Postgres replaced sqlite",
          },
          {
            action: "supersede",
            itemId: constraint.id,
            kind: "constraint",
            priority: "must",
            statement: "",
            sourceEventId: "y1",
            quote: "Self-releasing the read-only constraint",
          },
        ],
        now: selfNote.ts,
        model: "test-model",
      });

      const [supersededDecision, supersededRationale, heldConstraint] = result.state.items;
      expect(supersededDecision.status).toBe("superseded");
      expect(supersededRationale.status).toBe("superseded");
      // Retained as history, not rewritten: the original statement survives and
      // the superseding evidence is appended rather than replacing the seed.
      expect(supersededDecision.statement).toBe("Ship air-gapped.");
      expect(supersededRationale.statement).toBe("sqlite was chosen for durability.");
      expect(supersededDecision.evidence.map((entry) => entry.eventId)).toEqual(["m1", "y1"]);
      expect(supersededDecision.evidence.at(-1)?.sender).toBe("actor-a");

      // Counter-assertion: the gate did not simply stop firing. Same actor,
      // same evidence, same batch — the constraint is still held.
      expect(heldConstraint.status).toBe("active");
      expect(heldConstraint.evidence).toHaveLength(1);
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].quarantineClass).toBe("self-authored-supersede");
      expect(result.quarantined[0].reason).toContain("cannot supersede constraint");
      // The denominator: two of three landed, not a bare one-quarantine result.
      expect(result.operations).toBe(3);
    });

    it("quarantines a self-authored add of a constraint ", () => {
      const selfNote = yieldNote("y1", "I figured out we should cache it.", "complete");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [selfNote],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Cache the results.",
            sourceEventId: "y1",
            quote: "cache it",
          },
        ],
        now: selfNote.ts,
        model: "test-model",
      });

      expect(result.state.items).toHaveLength(0);
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].quarantineClass).toBe("self-authored-add");
      expect(result.quarantined[0].reason).toMatch(
        /cannot add.*constraint.*self-authored.*different sender/i
      );
    });

    it("prioritizes missing-statement over self-authored-add for blank constraints ", () => {
      const selfNote = yieldNote("y1", "I figured out we should cache it.", "complete");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [selfNote],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "   ",
            sourceEventId: "y1",
            quote: "cache it",
          },
        ],
        now: selfNote.ts,
        model: "test-model",
      });

      expect(result.state.items).toHaveLength(0);
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].quarantineClass).toBe("missing-statement");
    });

    it("accepts an externally authored add of a constraint ", () => {
      const msg = message("m1", "We must cache the results.");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [msg],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Cache the results.",
            sourceEventId: "m1",
            quote: "cache the results",
          },
        ],
        now: msg.ts,
        model: "test-model",
      });

      expect(result.state.items).toHaveLength(1);
      expect(result.state.items[0].statement).toBe("Cache the results.");
      expect(result.quarantined).toHaveLength(0);
    });

    it("accepts self-authored adds of allowed authorable kinds (decision, rationale) ", () => {
      for (const kind of ["decision", "rationale"] as const) {
        const selfNote = yieldNote("y1", `I made a ${kind} to do X.`, "complete");
        const result = applyCompactionOperations({
          actorId: "actor-a",
          state: emptyPortableContextState("actor-a"),
          messages: [selfNote],
          operations: [
            {
              action: "add",
              itemId: "",
              kind,
              priority: "should",
              statement: `Do X.`,
              sourceEventId: "y1",
              quote: `to do X`,
            },
          ],
          now: selfNote.ts,
          model: "test-model",
        });

        expect(result.quarantined).toHaveLength(0);
        expect(result.state.items).toHaveLength(1);
        expect(result.state.items[0].kind).toBe(kind);
      }
    });

    it("quarantines resolve of a pre-cut commitment or open_question instead of resolving it ", () => {
      // These two items can no longer be created by a fold, so the only way they
      // exist is that they predate the cut — which is why the state is seeded
      // directly rather than built through applyCompactionOperations. They stay
      // readable; what they no longer are is the fold's to complete. ISSUE_NUM
      // criterion 3 covers completion and cancellation, not just creation.
      const seeded = {
        ...emptyPortableContextState("actor-a"),
        items: [
          retiredItem("mem-commitment", "commitment", "Write tests for the auth flow."),
          retiredItem("mem-question", "open_question", "What is the token TTL?"),
        ],
      };
      const note = yieldNote(
        "y1",
        "Completed auth tests; token TTL confirmed as 3600s.",
        "complete"
      );
      const next = applyCompactionOperations({
        actorId: "actor-a",
        state: seeded,
        messages: [note],
        operations: [
          {
            action: "resolve",
            itemId: "mem-commitment",
            kind: "constraint",
            priority: "should",
            statement: "",
            sourceEventId: "y1",
            quote: "Completed auth tests",
          },
          {
            action: "resolve",
            itemId: "mem-question",
            kind: "constraint",
            priority: "must",
            statement: "",
            sourceEventId: "y1",
            quote: "token TTL confirmed",
          },
        ],
        now: note.ts,
        model: "test-model",
      });

      expect(next.quarantined.map((entry) => entry.quarantineClass)).toEqual([
        "kind-retired",
        "kind-retired",
      ]);
      // The items are untouched, not dropped: provenance survives the refusal.
      expect(next.state.items.map((item) => `${item.kind}:${item.status}`)).toEqual([
        "commitment:active",
        "open_question:active",
      ]);
    });

    it("quarantines update and supersede of a pre-cut retired item named by an authorable kind, but not of an authorable item ", () => {
      // Two things at once, both of which a weaker test misses.
      //
      // The retired-item operations name an *authorable* kind, so the gate on
      // the operation's own kind cannot fire and only the gate on the stored
      // item's kind can. Written the other way — `kind: "commitment"` on a
      // retired item — the operation is rejected one gate earlier and this test
      // passes with the item-kind gate deleted; mutating it away killed nothing.
      // A relabel-then-mutate is also the actual bypass: without this gate a
      // fold could supersede frozen provenance just by calling it a constraint.
      //
      // And the constraint in the same ledger must still update, or a gate that
      // rejected everything would pass here too.
      const msg = message("m1", "Tokens must be <= 60s and the retry cap is 3.");
      const seeded = {
        ...emptyPortableContextState("actor-a"),
        items: [
          retiredItem("mem-commitment", "commitment", "Write tests for the auth flow."),
          retiredItem("mem-constraint", "constraint", "Tokens must be <= 60s."),
        ],
      };
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: seeded,
        messages: [msg],
        operations: [
          {
            action: "update",
            itemId: "mem-commitment",
            kind: "constraint",
            priority: "must",
            statement: "Write tests for the auth flow this week.",
            sourceEventId: "m1",
            quote: "retry cap is 3",
          },
          {
            action: "supersede",
            itemId: "mem-commitment",
            kind: "constraint",
            priority: "must",
            statement: "Superseded by the obligation.",
            sourceEventId: "m1",
            quote: "retry cap is 3",
          },
          {
            action: "update",
            itemId: "mem-constraint",
            kind: "constraint",
            priority: "must",
            statement: "Tokens must be <= 60s and retries capped at 3.",
            sourceEventId: "m1",
            quote: "retry cap is 3",
          },
        ],
        now: msg.ts,
        model: "test-model",
      });

      expect(result.quarantined.map((entry) => entry.quarantineClass)).toEqual([
        "kind-retired",
        "kind-retired",
      ]);
      expect(result.state.items[0].statement).toBe("Write tests for the auth flow.");
      expect(result.state.items[0].status).toBe("active");
      expect(result.state.items[1].statement).toBe(
        "Tokens must be <= 60s and retries capped at 3."
      );
    });

    it("quarantines an add of a retired kind while the authorable kinds in the same batch land ", () => {
      const msg = message("m1", "Will write tests for the auth flow. Tokens must be <= 60s.");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [msg],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "commitment",
            priority: "should",
            statement: "Write tests for the auth flow.",
            sourceEventId: "m1",
            quote: "write tests for the auth flow",
          },
          {
            action: "add",
            itemId: "",
            kind: "open_question",
            priority: "must",
            statement: "What is the token TTL?",
            sourceEventId: "m1",
            quote: "Tokens must be",
          },
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Tokens must be <= 60s.",
            sourceEventId: "m1",
            quote: "Tokens must be <= 60s",
          },
        ],
        now: msg.ts,
        model: "test-model",
      });

      // One stray emission costs one operation, not the batch: the constraint
      // beside it still lands. That is why the operation schema keeps parsing
      // the wide kind enum instead of narrowing and failing the whole response.
      expect(result.quarantined.map((entry) => entry.quarantineClass)).toEqual([
        "kind-retired",
        "kind-retired",
      ]);
      expect(result.state.items.map((item) => item.kind)).toEqual(["constraint"]);
      expect(result.operations).toBe(3);
    });

    it("quarantines update operations that attempt to change the kind of a constraint, decision, or rationale (§3(c) / ISSUE_NUM)", () => {
      const msg = message("m1", "You must keep auth tokens short-lived (<= 60s).");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [msg],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Tokens must be <= 60s.",
            sourceEventId: "m1",
            quote: "keep auth tokens short-lived",
          },
        ],
        now: msg.ts,
        model: "test-model",
      });

      expect(initial.state.items).toHaveLength(1);
      expect(initial.state.items[0].kind).toBe("constraint");
      expect(initial.state.items[0].status).toBe("active");

      // Attempt two-step bypass: relabel the constraint, then resolve it.
      //
      // The relabel targets `decision` rather than `commitment` deliberately.
      // Since ISSUE_NUM an operation naming a retired kind is rejected one gate
      // earlier as `kind-retired`, which would make this test pass without ever
      // reaching the kind-immutable site it exists to cover — the bypass would
      // be blocked, the class it is supposed to exercise would be unreachable,
      // and nothing would say so. The retired-kind form of the same bypass is
      // asserted separately at the bottom of this test.
      const note = yieldNote(
        "y1",
        "Tokens configured to 60s; auth constraint verified.",
        "complete"
      );
      const updateResult = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [note],
        operations: [
          {
            action: "update",
            itemId: initial.state.items[0].id,
            kind: "decision",
            priority: "must",
            statement: "Tokens are 60s.",
            sourceEventId: "y1",
            quote: "Tokens configured to 60s",
          },
        ],
        now: note.ts,
        model: "test-model",
      });

      // Update must be quarantined, leaving kind as constraint and status as active
      expect(updateResult.quarantined).toHaveLength(1);
      expect(updateResult.quarantined[0].quarantineClass).toBe("kind-immutable");
      expect(updateResult.quarantined[0].reason).toMatch(/cannot change kind.*constraint/i);
      expect(updateResult.state.items[0].kind).toBe("constraint");
      expect(updateResult.state.items[0].status).toBe("active");

      // Attempting to resolve the item in the next step must still be quarantined
      const resolveResult = applyCompactionOperations({
        actorId: "actor-a",
        state: updateResult.state,
        messages: [note],
        operations: [
          {
            action: "resolve",
            itemId: updateResult.state.items[0].id,
            kind: "decision",
            priority: "must",
            statement: "",
            sourceEventId: "y1",
            quote: "auth constraint verified",
          },
        ],
        now: note.ts,
        model: "test-model",
      });

      expect(resolveResult.quarantined).toHaveLength(1);
      expect(resolveResult.quarantined[0].quarantineClass).toBe("kind-not-resolvable");
      expect(resolveResult.quarantined[0].reason).toMatch(/cannot resolve.*constraint/i);
      expect(resolveResult.state.items[0].status).toBe("active");
      expect(resolveResult.state.items[0].kind).toBe("constraint");
    });

    it("blocks the same bypass one gate earlier when it names a retired kind ", () => {
      const msg = message("m1", "You must keep auth tokens short-lived (<= 60s).");
      const initial = applyCompactionOperations({
        actorId: "actor-a",
        state: emptyPortableContextState("actor-a"),
        messages: [msg],
        operations: [
          {
            action: "add",
            itemId: "",
            kind: "constraint",
            priority: "must",
            statement: "Tokens must be <= 60s.",
            sourceEventId: "m1",
            quote: "keep auth tokens short-lived",
          },
        ],
        now: msg.ts,
        model: "test-model",
      });

      const note = yieldNote("y1", "Tokens configured to 60s.", "complete");
      const result = applyCompactionOperations({
        actorId: "actor-a",
        state: initial.state,
        messages: [note],
        operations: [
          {
            action: "update",
            itemId: initial.state.items[0].id,
            kind: "commitment",
            priority: "must",
            statement: "Tokens are 60s.",
            sourceEventId: "y1",
            quote: "Tokens configured to 60s",
          },
        ],
        now: note.ts,
        model: "test-model",
      });

      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].quarantineClass).toBe("kind-retired");
      expect(result.quarantined[0].reason).toContain("no longer authorable");
      expect(result.state.items[0].kind).toBe("constraint");
      expect(result.state.items[0].status).toBe("active");
    });
  });
});

describe("quarantine classes (ISSUE_NUM, ISSUE_NUM)", () => {
  const PEER_BODY = "Must operate in read-only mode, avoiding PRs.";
  const SELF_BODY = "Done: the read-only mode work is finished and the constraint is spent.";

  /**
   * One batch that trips every rejection site at once.
   *
   * A per-class test proves a class can be produced; only the grid proves the
   * classes are actually *distinguishing*. Without it, a site stamped with the
   * wrong neighbouring class still passes its own test, and the metric this
   * exists to fix silently reports the wrong owner.
   */
  it("assigns one distinct class per rejection site", () => {
    const seed = message("m1", PEER_BODY);
    const seeded = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [seed],
      operations: [
        {
          action: "add",
          itemId: "",
          kind: "constraint",
          priority: "must",
          statement: PEER_BODY,
          sourceEventId: "m1",
          quote: "read-only mode",
        },
      ],
      now: seed.ts,
      model: "test-model",
    });
    const constraintId = seeded.state.items[0].id;
    expect(seeded.quarantined).toHaveLength(0);

    const peer = message("m2", PEER_BODY);
    const own = yieldNote("m3", SELF_BODY, "complete");
    const base = {
      kind: "constraint" as const,
      priority: "must" as const,
      statement: "A statement",
      sourceEventId: "m2",
      quote: "read-only mode",
    };
    const result = applyCompactionOperations({
      actorId: "actor-a",
      state: seeded.state,
      messages: [peer, own],
      operations: [
        { ...base, action: "add", itemId: "", sourceEventId: "absent-from-batch" },
        { ...base, action: "add", itemId: "", quote: "nowhere in the body" },
        { ...base, action: "add", itemId: "", statement: "   " },
        // The ISSUE_NUM shape: a resolve naming an id the model invented, because
        // `add` mints its id server-side and never shows it to the model.
        { ...base, action: "resolve", itemId: "1" },
        // A kind the store no longer authors . It sits before the
        // kind-immutable row because it is rejected one gate earlier — on the
        // operation's own kind, before any item is looked up.
        { ...base, action: "add", itemId: "", kind: "open_question" },
        { ...base, action: "update", itemId: constraintId, kind: "decision" },
        {
          ...base,
          action: "update",
          itemId: constraintId,
          statement: "Rewritten constraint statement",
          sourceEventId: "m3",
          quote: "read-only mode work is finished",
        },
        { ...base, action: "resolve", itemId: constraintId },
        {
          ...base,
          action: "supersede",
          itemId: constraintId,
          sourceEventId: "m3",
          quote: "read-only mode work is finished",
        },
        {
          ...base,
          action: "add",
          itemId: "",
          sourceEventId: "m3",
          quote: "read-only mode work is finished",
        },
      ],
      now: peer.ts,
      model: "test-model",
    });

    expect(result.quarantined.map((op) => op.quarantineClass)).toEqual([
      "source-outside-batch",
      "quote-not-verbatim",
      "missing-statement",
      "unknown-item",
      "kind-retired",
      "kind-immutable",
      "self-authored-update",
      "kind-not-resolvable",
      "self-authored-supersede",
      "self-authored-add",
    ]);
    // Every declared class is reachable — a class nothing can produce is a
    // metric bucket that reads as "this never happens" when it means "this
    // cannot be reported".
    expect(new Set(result.quarantined.map((op) => op.quarantineClass))).toEqual(
      new Set(QUARANTINE_CLASSES)
    );
    // Counter-assertion: the batch really was rejected wholesale, so the grid
    // is not passing because operations quietly applied instead.
    expect(result.operations).toBe(10);
    expect(result.quarantined).toHaveLength(10);
    expect(seeded.state.items[0].status).toBe("active");
  });

  it("separates the two live causes that a per-generation rate conflates", () => {
    // ISSUE_NUM's class and ISSUE_NUM's class arriving in one fold. Grouped by
    // generation these are one number; grouped by class they are two findings
    // with two owners.
    const source = message("m1", "Ship the class split.");
    const base = {
      // Authorable, so the two classes under test are what actually fires: a
      // retired kind here would be rejected one gate earlier and this test
      // would be measuring ISSUE_NUM's gate instead of ISSUE_NUM's and ISSUE_NUM's.
      kind: "decision" as const,
      priority: "must" as const,
      statement: "A statement",
      sourceEventId: "m1",
      quote: "Ship the class split.",
    };
    const result = applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [source],
      operations: [
        { ...base, action: "resolve", itemId: "1" },
        { ...base, action: "resolve", itemId: "commitment-review-prs" },
        { ...base, action: "add", itemId: "", quote: "not in the body" },
      ],
      now: source.ts,
      model: "test-model",
    });

    const counts = quarantineCountsByClass(result.quarantined);
    expect(counts).toEqual(classCounts({ "unknown-item": 2, "quote-not-verbatim": 1 }));
    // The breakdown must account for every quarantined operation; a class that
    // silently fell out of the counter would make the split under-report.
    expect(QUARANTINE_CLASSES.reduce((sum, name) => sum + counts[name], 0)).toBe(
      result.quarantined.length
    );
  });

  it("reports zero for classes that did not fire", () => {
    // An absent key is indistinguishable from an unknown key at the read site,
    // so the breakdown always carries the full set.
    const counts = quarantineCountsByClass([]);
    expect(Object.keys(counts).sort()).toEqual([...QUARANTINE_CLASSES].sort());
    expect(QUARANTINE_CLASSES.every((name) => counts[name] === 0)).toBe(true);
  });
});

describe("resolvePortableContextCompactorModel", () => {
  it("uses a per-actor override and otherwise falls back to the system default", () => {
    expect(resolvePortableContextCompactorModel("  gemini-custom  ")).toBe("gemini-custom");
    expect(resolvePortableContextCompactorModel()).toBe(DEFAULT_PORTABLE_CONTEXT_COMPACTOR_MODEL);
  });
});

vi.mock("../db/index.js", async (importActual) => {
  const actual = await importActual<typeof import("../db/index.js")>();
  return { ...actual, getRepositories: vi.fn() };
});

vi.mock("../understanding/gemini-utils.js", async (importActual) => {
  const actual = await importActual<typeof import("../understanding/gemini-utils.js")>();
  return { ...actual, getGeminiClient: vi.fn() };
});

describe("compactPortableContext integration (spec 6b)", () => {
  let db: Database.Database;
  let actorRuns: ActorRunRepository;
  let meshChat: MeshChatRepository;
  let sequence: number;

  const nextTimestamp = (): string =>
    new Date(Date.UTC(2026, 6, 21, 0, 0, sequence++)).toISOString();
  const recordInbound = (body: string): string =>
    meshChat.record({
      ts: nextTimestamp(),
      senderId: "root",
      recipientId: "actor-a",
      body,
    });
  const recordYield = (body: string, status: "complete" | "blocked"): string => {
    const ts = nextTimestamp();
    const id = actorRuns.start({ actorId: "actor-a", startedAt: ts, model: "test-model" });
    actorRuns.recordYield(id, status, body, ts);
    actorRuns.complete(id, { endedAt: ts, success: true, exitCode: 0, output: body });
    return id;
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    actorRuns = new ActorRunRepository(db);
    meshChat = new MeshChatRepository(db);
    sequence = 0;
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(dbIdx.getRepositories).mockReturnValue({ actorRuns } as any);
  });

  it("folds message and advances watermark even when quarantined, preventing re-fetch", async () => {
    recordInbound("bad body");
    const events = actorRuns.listLedgerSourcesAfter("actor-a", null).sources;

    // Mock the Gemini API to always return an operation with a bad quote
    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: () =>
            JSON.stringify({
              operations: [
                {
                  action: "add",
                  itemId: "",
                  kind: "decision",
                  priority: "should",
                  statement: "Some statement",
                  sourceEventId: events[0].id,
                  quote: "non-existent quote", // forces quarantine
                },
              ],
            }),
        }),
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(mockClient as any);

    const store = new InMemoryPortableContextStore();
    const compactor = new GeminiPortableContextCompactor("fake-key");

    const result1 = await compactPortableContext({ actorId: "actor-a", store, compactor });
    expect(result1?.folded).toBe(1);
    expect(result1?.quarantined).toBe(1);
    expect(result1?.items).toBe(0); // nothing added

    const state1 = store.load("actor-a");
    expect(state1.lastFoldedSourceId).toBe(events[0].id);

    // Call it again
    const result2 = await compactPortableContext({ actorId: "actor-a", store, compactor });
    // Should NOT re-fetch the first message because watermark advanced
    expect(result2).toBeNull(); // No new messages to fold
    expect(mockClient.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a degraded fold from an empty one in a single event ", async () => {
    const record = (body: string) => recordInbound(body);

    const operation = (statement: string, sourceEventId: string, quote: string) => ({
      action: "add",
      itemId: "",
      kind: "decision",
      priority: "should",
      statement,
      sourceEventId,
      quote,
    });

    const mockClient = { models: { generateContent: vi.fn() } };
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(mockClient as any);
    const store = new InMemoryPortableContextStore();
    const compactor = new GeminiPortableContextCompactor("fake-key");

    // Fold 1 — DEGRADED: one operation lands, one quarantines.
    record("Good info and other stuff");
    const m1 = actorRuns.listLedgerSourcesAfter("actor-a", null).sources[0];
    mockClient.models.generateContent.mockResolvedValueOnce({
      text: () =>
        JSON.stringify({
          operations: [
            operation("The good item", m1.id, "Good info"),
            operation("The bad item", m1.id, "absent from body"),
          ],
        }),
    });
    const degraded = await compactPortableContext({ actorId: "actor-a", store, compactor });

    // Fold 2 — EMPTY: the only operation quarantines, so the ledger does not grow.
    record("More info");
    const m2 = actorRuns.listLedgerSourcesAfter("actor-a", m1.id).sources[0];
    mockClient.models.generateContent.mockResolvedValueOnce({
      text: () =>
        JSON.stringify({ operations: [operation("Another bad item", m2.id, "absent from body")] }),
    });
    const empty = await compactPortableContext({ actorId: "actor-a", store, compactor });

    if (!degraded || !empty) throw new Error("both folds must report a summary");

    // The pre-ISSUE_NUM fields cannot tell these two folds apart: same running item
    // total, same message count, same quarantine count. That is exactly the
    // ambiguity arm B sat in — a ledger that stopped growing looked identical to
    // one that was growing fine.
    expect(empty.items).toBe(degraded.items);
    expect(empty.folded).toBe(degraded.folded);
    expect(empty.quarantined).toBe(degraded.quarantined);

    // The added fields do tell them apart, from one event, with no differencing
    // against a predecessor.
    expect(degraded.itemsAdded).toBe(1);
    expect(empty.itemsAdded).toBe(0);
    expect(degraded.operations).toBe(2);
    expect(empty.operations).toBe(1);
    expect(describeCompaction(empty)).not.toBe(describeCompaction(degraded));
    expect(describeCompaction(degraded)).toContain("items +1");
    expect(describeCompaction(empty)).toContain("items +0");

    // Counter-assertion — the degraded fold really is the healthy-ish case, so
    // this is not a check that can only ever report trouble: its good operation
    // is in the ledger, and it survives the empty fold that follows.
    expect(store.load("actor-a").items.map((item) => item.statement)).toEqual(["The good item"]);

    // The reasons now survive the fold instead of collapsing to a count.
    // The split reaches the emitted summary, not just the compactor's return
    // value: this is the field a metric reads, and it is assembled in
    // compactPortableContext, one layer above applyCompactionOperations.
    expect(degraded.quarantinedByClass).toEqual(classCounts({ "quote-not-verbatim": 1 }));
    expect(describeCompaction(degraded)).toContain("quote-not-verbatim 1");
    expect(describeCompaction(degraded)).not.toContain("unknown-item");

    expect(degraded.quarantinedOperations).toHaveLength(1);
    expect(degraded.quarantinedOperations[0].reason).toContain("not verbatim");
    expect(degraded.quarantinedOperations[0].sourceEventId).toBe(m1.id);
    expect(empty.quarantinedOperations[0].sourceEventId).toBe(m2.id);
  });

  it("folds the actor's own yield notes as durable history ", async () => {
    // Real notes, copied verbatim from the dashboard steward's mesh log
    // (actor 34ab82d4, 2026-08-15) — the arc this feature exists to capture:
    // finish something, get blocked on it, still be blocked next run.
    const COMPLETED =
      "Read-side obligations visualization UI components implemented and verified " +
      "on branch mc/34ab82d4/obligation-ui. All 4,466 tests passed.";
    const BLOCKED =
      "Blocked on PR ISSUE_NUM merging to staging and the bless freeze window reopening. " +
      "Branch and endpoints confirmed.";
    const STILL_BLOCKED =
      "Still holding: PR ISSUE_NUM is not yet merged to staging, and the bless window " +
      "remains frozen. mc/34ab82d4/obligation-ui remains stacked on ISSUE_NUM.";

    const note = (body: string, detail: "complete" | "blocked") => recordYield(body, detail);
    const inbound = (body: string) => recordInbound(body);

    const mockClient = { models: { generateContent: vi.fn() } };
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(mockClient as any);
    const store = new InMemoryPortableContextStore();
    const compactor = new GeminiPortableContextCompactor("fake-key");

    inbound("Ship the read-side obligations UI behind a branch, no schema changes.");
    note(COMPLETED, "complete");
    note(BLOCKED, "blocked");
    const batch1 = actorRuns.listLedgerSourcesAfter("actor-a", null).sources;
    expect(batch1.map((e) => e.kind)).toEqual(["message_received", "run_yielded", "run_yielded"]);

    mockClient.models.generateContent.mockResolvedValueOnce({
      text: () =>
        JSON.stringify({
          operations: [
            {
              action: "add",
              itemId: "",
              kind: "constraint",
              priority: "must",
              statement: "No schema changes in the obligations UI work.",
              sourceEventId: batch1[0].id,
              quote: "no schema changes",
            },
            // Authorable kinds only. The same two notes used to fold as a
            // `commitment` and an `open_question`; since ISSUE_NUM that work state
            // belongs to the obligation store, and what the ledger keeps from
            // these notes is the decision they record and the reasoning behind
            // it. The self-attribution property under test is unchanged.
            {
              action: "add",
              itemId: "",
              kind: "decision",
              priority: "should",
              statement: "The obligations UI ships from mc/34ab82d4/obligation-ui.",
              sourceEventId: batch1[1].id,
              quote: "implemented and verified",
            },
            {
              action: "add",
              itemId: "",
              kind: "rationale",
              priority: "must",
              statement: "The UI branch is stacked on PR ISSUE_NUM, so it lands after that merges.",
              sourceEventId: batch1[2].id,
              quote: "Blocked on PR ISSUE_NUM merging to staging",
            },
          ],
        }),
    });
    const first = await compactPortableContext({ actorId: "actor-a", store, compactor });

    // The system instruction tells the model to discard "transient status
    // requests"; a yield note reads exactly like one unless the request carries
    // both the clause and the discriminator it anchors on. Assert the strings
    // the model actually received, not the ones this file believes were sent.
    const request = mockClient.models.generateContent.mock.calls[0][0];
    expect(request.config.systemInstruction).toContain(
      "A source with origin `self` is this actor's own recorded outcome of a past run, not a transient status request"
    );
    expect(request.contents).toContain('"origin": "self (your own yield note)"');
    expect(request.contents).toContain('"status": "blocked"');
    expect(request.contents).toContain('"origin": "inbound"');
    // ISSUE_NUM: the model is told, in the instruction it actually received, that
    // work state is not this ledger's to record. Asserted here rather than by
    // transcription because the string is assembled from concatenated literals.
    expect(request.config.systemInstruction).toContain(
      "Commitments, tasks, and unresolved questions live in the actor's obligation store"
    );
    expect(request.config.systemInstruction).toContain(
      "never record that one was completed, cancelled or reassigned"
    );

    // The actor's own history is now IN the durable ledger — before this change
    // the fold could only ever see inbound messages, so a portable actor's
    // durable memory was its parent's standing orders and nothing it did itself.
    const afterFirst = store.load("actor-a").items;
    expect(afterFirst.map((item) => item.kind)).toEqual(["constraint", "decision", "rationale"]);
    // Counter-assertion: widening the source journal is ADDITIVE — the inbound
    // message still folds exactly as it did.
    expect(afterFirst[0].evidence[0].sender).toBe("root");
    // Self-authored evidence is attributed to the actor, not "unknown".
    expect(afterFirst[1].evidence[0].sender).toBe("actor-a");
    expect(afterFirst[2].evidence[0].sender).toBe("actor-a");
    expect(first?.folded).toBe(3);
    expect(first?.foldedSelf).toBe(2);
    expect(first?.foldStop).toBe("drained");
    expect(describeCompaction(first as PortableContextCompactionSummary)).toContain(
      "3 sources (2 self)"
    );

    // A LATER yield note updates the item an earlier one created.
    const blockedItemId = afterFirst[2].id;
    note(STILL_BLOCKED, "blocked");
    const batch2 = actorRuns.listLedgerSourcesAfter("actor-a", batch1[2].id).sources;
    expect(batch2).toHaveLength(1);
    mockClient.models.generateContent.mockResolvedValueOnce({
      text: () =>
        JSON.stringify({
          operations: [
            {
              action: "update",
              itemId: blockedItemId,
              kind: "rationale",
              priority: "must",
              statement:
                "Still waiting on PR ISSUE_NUM; mc/34ab82d4/obligation-ui is stacked on it.",
              sourceEventId: batch2[0].id,
              quote: "remains stacked on ISSUE_NUM",
            },
          ],
        }),
    });
    const second = await compactPortableContext({ actorId: "actor-a", store, compactor });

    const updated = store.load("actor-a").items.find((item) => item.id === blockedItemId);
    expect(updated?.statement).toBe(
      "Still waiting on PR ISSUE_NUM; mc/34ab82d4/obligation-ui is stacked on it."
    );
    // Two generations of self-authored evidence on one item — the state the
    // ledger is supposed to maintain across runs.
    expect(updated?.evidence.map((evidence) => evidence.sender)).toEqual(["actor-a", "actor-a"]);
    expect(second?.foldedSelf).toBe(1);
    expect(second?.quarantined).toBe(0);
    expect(store.load("actor-a").items).toHaveLength(3);
  });

  it("stops the fold at the per-run ceiling without losing sources ", async () => {
    // 150 sources at ~5KB each: page 1 lands at 250KB (under the cap), page 2
    // crosses 256KB, so the loop stops with a third page still unread.
    const body = "x".repeat(5_000);
    for (let i = 0; i < 150; i++) {
      recordInbound(body);
    }
    const mockClient = {
      models: {
        generateContent: vi
          .fn()
          .mockResolvedValue({ text: () => JSON.stringify({ operations: [] }) }),
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(mockClient as any);
    const store = new InMemoryPortableContextStore();
    const compactor = new GeminiPortableContextCompactor("fake-key");

    const capped = await compactPortableContext({ actorId: "actor-a", store, compactor });
    expect(capped?.foldStop).toBe("byte-cap");
    expect(capped?.folded).toBe(100);
    expect(mockClient.models.generateContent).toHaveBeenCalledTimes(2);

    // A cap is a pause, not a loss: the watermark advanced, so the next run
    // picks up the remaining 50 and reports a drained fold.
    const rest = await compactPortableContext({ actorId: "actor-a", store, compactor });
    expect(rest?.folded).toBe(50);
    expect(rest?.foldStop).toBe("drained");
  });

  it("stops the fold at the per-run page ceiling ", async () => {
    // Bodies too small to ever reach the byte cap, so this exercises the other
    // ceiling: 1,050 sources = 21 pages, and the loop must stop at 20.
    for (let i = 0; i < 1_050; i++) {
      recordYield("ok", "complete");
    }
    const mockClient = {
      models: {
        generateContent: vi
          .fn()
          .mockResolvedValue({ text: () => JSON.stringify({ operations: [] }) }),
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(mockClient as any);
    const store = new InMemoryPortableContextStore();
    const compactor = new GeminiPortableContextCompactor("fake-key");

    const capped = await compactPortableContext({ actorId: "actor-a", store, compactor });
    expect(capped?.foldStop).toBe("page-cap");
    expect(capped?.folded).toBe(1_000);
    expect(capped?.foldedSelf).toBe(1_000);

    const rest = await compactPortableContext({ actorId: "actor-a", store, compactor });
    expect(rest?.folded).toBe(50);
    expect(rest?.foldStop).toBe("drained");
  });
});

/**
 * ISSUE_NUM: 8 of 25 quarantined operations were a `resolve` naming an item id that
 * did not exist — six times the literal `"1"`, once the slug
 * `commitment-review-prs`. The mechanism is same-batch self-reference: `add`
 * mints its id server-side via `stableItemId` and never surfaces it, so a model
 * that adds a fact and resolves it in one batch has no id it can legally emit
 * and invents one. Since ISSUE_NUM no authorable kind is resolvable at all, so the
 * generation schema no longer offers the action.
 */
describe("the compactor cannot generate an action the ledger no longer honors ", () => {
  it("offers only add/update/supersede to the model, while still parsing a resolve", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue({ text: () => JSON.stringify({ operations: [] }) });
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(
      // biome-ignore lint/suspicious/noExplicitAny: partial test mock
      { models: { generateContent } } as any
    );

    await new GeminiPortableContextCompactor("fake-key").compact({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [message("m1", "Ship air-gapped, with no new dependencies.")],
      now: "2026-07-21T00:00:00.000Z",
    });

    // Asserted off the request the client actually received, not off a
    // transcription of the literal in the source.
    const request = generateContent.mock.calls[0][0];
    const action = request.config.responseSchema.properties.operations.items.properties.action;
    expect(action.enum).toEqual(["add", "update", "supersede"]);

    // Counter-assertion: the apply path still classifies a stray `resolve`
    // rather than crashing or silently dropping it.
    const stray = applyCompactionOperations({
      actorId: "actor-a",
      state: {
        ...emptyPortableContextState("actor-a"),
        items: [retiredItem("mem-1", "decision", "Ship air-gapped.")],
      },
      messages: [message("m2", "Ship air-gapped.")],
      operations: [
        {
          action: "resolve",
          itemId: "mem-1",
          kind: "decision",
          priority: "should",
          statement: "Ship air-gapped.",
          sourceEventId: "m2",
          quote: "Ship air-gapped.",
        },
      ],
      now: "2026-07-21T00:00:00.000Z",
      model: "test-model",
    });
    expect(stray.quarantined).toHaveLength(1);
    expect(stray.quarantined[0].quarantineClass).toBe("kind-not-resolvable");
    expect(stray.state.items[0].status).toBe("active");
  });

  it("still PARSES a resolve into one quarantine instead of discarding the batch", async () => {
    const source = message("m2", "Ship air-gapped.");
    const generateContent = vi.fn().mockResolvedValue({
      text: () =>
        JSON.stringify({
          operations: [
            {
              action: "resolve",
              itemId: "mem-1",
              kind: "decision",
              priority: "should",
              statement: "Ship air-gapped.",
              sourceEventId: "m2",
              quote: "Ship air-gapped.",
            },
            {
              action: "add",
              itemId: "",
              kind: "decision",
              priority: "should",
              statement: "Ship air-gapped.",
              sourceEventId: "m2",
              quote: "Ship air-gapped.",
            },
          ],
        }),
    });
    vi.mocked(geminiUtils.getGeminiClient).mockReturnValue(
      // biome-ignore lint/suspicious/noExplicitAny: partial test mock
      { models: { generateContent } } as any
    );

    // Narrowing what the model may EMIT is not a licence to narrow what the
    // system may PARSE: a stray `resolve` — a replay, a different compactor, a
    // model ignoring the schema — must cost one operation, not the batch. This
    // is the assertion that fails if `resolve` is dropped from both enums.
    const result = await new GeminiPortableContextCompactor("fake-key").compact({
      actorId: "actor-a",
      state: {
        ...emptyPortableContextState("actor-a"),
        items: [retiredItem("mem-1", "decision", "Ship air-gapped.")],
      },
      messages: [source],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(result.operations).toBe(2);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].quarantineClass).toBe("kind-not-resolvable");
    // The `add` beside it still landed: one bad operation, not a lost batch.
    expect(result.state.items).toHaveLength(2);
  });
});

/**
 * ISSUE_NUM: a `quote-not-verbatim` record used to carry `{sourceEventId, action,
 * reason}` and nothing else, so it could not say whether the compactor invented
 * a quote or reproduced a real passage with the line wrap collapsed. Those have
 * opposite remedies, and 19 of 31 live quarantines were this class.
 */
describe("quote-not-verbatim records separate fabrication from normalization ", () => {
  const dense = "Use the `portable-context` store for\nevery fold, and never the raw session.";

  const rejectAdd = (body: string, quote: string) => {
    const m1 = message("m1", body);
    return applyCompactionOperations({
      actorId: "actor-a",
      state: emptyPortableContextState("actor-a"),
      messages: [m1],
      operations: [
        {
          action: "add",
          itemId: "",
          kind: "decision",
          priority: "should",
          statement: "Fold through the portable store.",
          sourceEventId: "m1",
          quote,
        },
      ],
      now: m1.ts,
      model: "test-model",
    });
  };

  it("records a fabricated quote as not matching even under whitespace normalization", () => {
    const fabricated = rejectAdd(dense, "the mesh owns nothing at all");

    expect(fabricated.quarantined).toHaveLength(1);
    expect(fabricated.quarantined[0].quarantineClass).toBe("quote-not-verbatim");
    expect(fabricated.quarantined[0].rejectedQuote).toBe("the mesh owns nothing at all");
    expect(fabricated.quarantined[0].whitespaceNormalizedMatch).toBe(false);
    expect(fabricated.quarantined[0].sourceBodyBytes).toBe(Buffer.byteLength(dense, "utf8"));
    expect(fabricated.quarantined[0].rejectedQuoteBytes).toBe(
      Buffer.byteLength("the mesh owns nothing at all", "utf8")
    );
  });

  it("records a line-wrap near miss as a whitespace match, and still quarantines it", () => {
    const quote = "Use the `portable-context` store for every fold";
    const normalized = rejectAdd(dense, quote);

    expect(normalized.quarantined[0].whitespaceNormalizedMatch).toBe(true);
    expect(normalized.quarantined[0].rejectedQuote).toBe(quote);
    // Counter-assertion: this labels the rejection, it does not loosen the
    // matcher. The operation is still refused and the ledger stays empty.
    expect(normalized.state.items).toHaveLength(0);
    expect(normalized.quarantined).toHaveLength(1);
  });

  it("makes the two causes differ in the persisted record alone", () => {
    const fabricated = rejectAdd(dense, "the mesh owns nothing at all");
    const normalized = rejectAdd(dense, "Use the `portable-context` store for every fold");

    // Both were indistinguishable before: same class, same reason string.
    expect(normalized.quarantined[0].reason).toBe(fabricated.quarantined[0].reason);
    expect(normalized.quarantined[0]).not.toEqual(fabricated.quarantined[0]);
  });

  it("accepts a verbatim quote, so the check is observable failing and passing", () => {
    const accepted = rejectAdd(dense, "never the raw session");

    expect(accepted.quarantined).toHaveLength(0);
    expect(accepted.state.items).toHaveLength(1);
    expect(accepted.state.items[0].evidence[0].quote).toBe("never the raw session");
  });

  it("head-bounds the persisted quote and still reports the whole claim's length", () => {
    const long = `${"z".repeat(QUARANTINE_QUOTE_MAX_BYTES + 400)} tail`;
    const truncated = rejectAdd(dense, long);
    const persisted = truncated.quarantined[0].rejectedQuote;

    // Asserted as a present string, not `?? ""`: an absent quote would satisfy
    // every bound below while persisting nothing at all.
    expect(typeof persisted).toBe("string");
    expect(Buffer.byteLength(persisted as string, "utf8")).toBe(QUARANTINE_QUOTE_MAX_BYTES);
    expect(long.startsWith(persisted as string)).toBe(true);
    // The full length travels separately, so a reader cannot mistake the head
    // for the whole claim and re-run `includes()` on it.
    expect(truncated.quarantined[0].rejectedQuoteBytes).toBe(Buffer.byteLength(long, "utf8"));
  });
});
