import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshActor } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { type RunNudge, TriggerRunner } from "../actor/trigger-runner.js";
import { runMigrations } from "../db/migrations/runner.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import {
  EmptyInboxRepository,
  type InboxListOptions,
  type InboxPayload,
  type InboxRepository,
} from "../repositories/inbox-repository.js";
import {
  type MeshProviderGate,
  type QueuedSelection,
  RunManager,
  type RunManagerInternalPort,
  type RunManagerOptions,
} from "./run-manager.js";

/**
 * A live actor backed by the real {@link TriggerRunner}, so per-actor debounce,
 * coalescing, single-flight and the one queued follow-up are exercised rather
 * than asserted against a stub. Everything a dispatch can observe about it —
 * the nudges it received, the runs it actually performed, whether it is queued
 * — is recorded, and nothing about the work itself crosses the seam.
 */
interface FakeActor extends MeshActor {
  readonly nudges: RunNudge[];
  readonly runs: RunNudge[];
  /** Let a held run complete, then drain the follow-up microtasks. */
  finishRun(): Promise<void>;
  /** What a preemption attempt should report; null means "nothing to replace". */
  preemptPhase: "running" | "winding_down" | "queued" | null;
  queued: boolean;
  preemptions: number;
  closed: number;
  isQueued: boolean;
}

/**
 * A live actor backed by the real {@link TriggerRunner}, so per-actor debounce,
 * coalescing, single-flight and the one queued follow-up are exercised rather
 * than asserted against a stub. Everything a dispatch can observe about it —
 * the nudges it received, the runs it actually performed, whether it is queued
 * — is recorded, and nothing about the work itself crosses the seam.
 */
function liveActor(id: string, opts: { debounceMs?: number; hold?: boolean } = {}): FakeActor {
  let release: (() => void) | null = null;
  let running = false;
  const self: FakeActor = {
    id,
    nudges: [],
    runs: [],
    preemptPhase: null,
    queued: false,
    preemptions: 0,
    closed: 0,
    isQueued: false,
    requestRun: (nudge: RunNudge = {}) => {
      self.nudges.push(nudge);
      runner.requestRun(nudge);
    },
    declareYield: () => {},
    markUnkillable: () => {},
    close: () => {
      self.closed += 1;
      runner.close();
    },
    get isRunning() {
      return running;
    },
    preemptForResponsive: () => {
      self.preemptions += 1;
      return self.preemptPhase === null
        ? { preempted: false }
        : { preempted: true, phase: self.preemptPhase };
    },
    async finishRun() {
      release?.();
      release = null;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  // `isQueued` is what dispatch reads; `queued` is the knob tests turn.
  Object.defineProperty(self, "isQueued", { get: () => self.queued });
  const runner = new TriggerRunner({
    debounceMs: opts.debounceMs ?? 0,
    run: async (nudge) => {
      self.runs.push(nudge);
      running = true;
      try {
        if (!opts.hold) return;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      } finally {
        running = false;
      }
    },
    isKillable: () => true,
  });
  return self;
}

/** The normalized shape TriggerRunner hands a run for ordinary work. */
const ORDINARY_RUN = { priority: "normal", mode: "ordinary" };

function record(id: string, overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id,
    charter: `charter for ${id}`,
    parentId: "root",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const CANDIDATE: RawProviderModelConfig = { provider: "claude", model: "opus" };

/** A fixed reservation, so these tests assert the plumbing rather than pacing. */
function selectionFor(candidate: RawProviderModelConfig, responsive: boolean): QueuedSelection {
  return {
    provider: candidate.provider,
    lane: "default",
    model: candidate.model ?? "unspecified",
    declaredIndex: 0,
    eligibleAt: 1_700_000_000_000,
    responsive,
  };
}

describe("RunManager", () => {
  let db: Database.Database;
  let inbox: SqliteInboxRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    inbox = new SqliteInboxRepository(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  /** Durable work, left exactly as a producer would leave it. */
  const append = (actorId: string, payload: InboxPayload, deliveredAt?: Date) =>
    inbox.append([
      { actorId, source: "test", payload, ...(deliveredAt ? { deliveredAt } : {}) },
    ])[0];

  interface Harness {
    manager: RunManager;
    actors: Map<string, FakeActor>;
    statuses: Map<string, string>;
    preempted: Array<[string, string]>;
    seen: string[];
    logs: string[];
    constructed: ActorRecord[];
    internalPort?: RunManagerInternalPort;
  }

  function setup(
    opts: {
      maxConcurrent?: number;
      providerGate?: MeshProviderGate;
      isVoiceSessionActive?: (actorId: string) => boolean;
      constructActor?: (rec: ActorRecord) => MeshActor;
      inbox?: InboxRepository;
      debounceMs?: number;
      onResponsiveArrived?: RunManagerOptions["onResponsiveArrived"];
    } = {}
  ): Harness {
    const actors = new Map<string, FakeActor>();
    const statuses = new Map<string, string>();
    const preempted: Array<[string, string]> = [];
    const seen: string[] = [];
    const logs: string[] = [];
    const constructed: ActorRecord[] = [];
    let internalPort: RunManagerInternalPort | undefined;
    const manager = new RunManager({
      inbox: opts.inbox ?? inbox,
      maxConcurrent: opts.maxConcurrent,
      providerGate: opts.providerGate,
      onInternalPort: (port) => {
        internalPort = port;
      },
      constructActor: (rec) => {
        constructed.push(rec);
        if (opts.constructActor) return opts.constructActor(rec);
        const actor = liveActor(rec.id, { debounceMs: opts.debounceMs });
        actors.set(rec.id, actor);
        return actor;
      },
      recordStatus: (actorId) => statuses.get(actorId),
      isVoiceSessionActive: opts.isVoiceSessionActive,
      markInboxSeen: (actorId) => seen.push(actorId),
      onPreempted: (actorId, phase) => preempted.push([actorId, phase]),
      ...(opts.onResponsiveArrived ? { onResponsiveArrived: opts.onResponsiveArrived } : {}),
      log: (msg) => logs.push(msg),
    });
    return { manager, actors, statuses, preempted, seen, logs, constructed, internalPort };
  }

  /** Register a live actor the way the mesh does, with an active record. */
  function live(h: Harness, id: string, opts: { debounceMs?: number; hold?: boolean } = {}) {
    const actor = liveActor(id, opts);
    h.statuses.set(id, "active");
    h.manager.register(id, actor);
    h.actors.set(id, actor);
    return actor;
  }

  describe("content-free dispatch reads its work from durable state", () => {
    it("is a no-op when durable state holds no work for the actor", () => {
      const h = setup();
      const actor = live(h, "a1");

      expect(h.manager.dispatch("a1")).toBe(false);
      expect(actor.nudges).toEqual([]);
      expect(actor.runs).toEqual([]);
      expect(h.logs).toContain("dispatch(a1) is a no-op — no durable work");
    });

    it("is a no-op again once the only entry has been handled", () => {
      const h = setup();
      const actor = live(h, "a1");
      const entry = append("a1", { type: "mesh.message" });
      expect(h.manager.dispatch("a1")).toBe(true);

      inbox.markHandled("a1", [entry.id], new Date(), "done");
      expect(h.manager.dispatch("a1")).toBe(false);
      expect(actor.nudges).toHaveLength(1);
    });

    it("derives ordinary priority from an ordinary entry, with no caller input", () => {
      const h = setup();
      const actor = live(h, "a1");
      append("a1", { type: "github.issue" });

      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.nudges).toEqual([{}]);
    });

    it("promotes to responsive when any pending entry is responsive", () => {
      const h = setup();
      const actor = live(h, "a1");
      append("a1", { type: "github.issue" });
      append("a1", { type: "human.message", priority: "responsive" });

      // The same promotion `actorsWithUnhandled()` reports for the whole mesh,
      // derived per actor. The caller still said only the actor's name.
      // No run has absorbed the responsive entry yet, so it is still arriving.
      expect(h.manager.durableWork("a1")).toEqual({
        priority: "responsive",
        unseenResponsive: true,
      });
      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.nudges).toEqual([{ priority: "responsive" }]);
    });

    it("demotes back to ordinary once the responsive entry is handled", () => {
      const h = setup();
      live(h, "a1");
      append("a1", { type: "github.issue" });
      const urgent = append("a1", { type: "human.message", priority: "responsive" });

      inbox.markHandled("a1", [urgent.id], new Date(), "read it");
      expect(h.manager.durableWork("a1")).toEqual({ priority: "normal" });
    });

    it("recovers voice timing from the pending voice entry rather than an argument", () => {
      const h = setup();
      const actor = live(h, "a1");
      const at = new Date("2026-03-04T05:06:07.000Z");
      append("a1", { type: "human.voice", priority: "responsive" }, at);

      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.nudges).toEqual([{ priority: "responsive", voiceTimestamp: at.getTime() }]);
    });

    it("recovers voice timing from a memo sitting behind a newer responsive entry", () => {
      const h = setup();
      const actor = live(h, "a1");
      append("a1", { type: "human.voice", priority: "responsive" }, new Date(1_000));
      append("a1", { type: "human.message", priority: "responsive" }, new Date(2_000));

      // Recovery — a reattach, a resume sweep — is exactly where the memo is
      // most likely to sit behind a newer responsive row, so voice timing is
      // read from the memo itself rather than from whatever arrived last.
      h.manager.dispatch("a1");
      expect(actor.nudges).toEqual([{ priority: "responsive", voiceTimestamp: 1_000 }]);
    });

    it("leaves voice timing off once the memo has been absorbed by an opportunity", () => {
      const h = setup();
      const actor = live(h, "a1");
      append("a1", { type: "human.voice", priority: "responsive" }, new Date(1_000));
      inbox.markSeen("a1");
      append("a1", { type: "github.issue" }, new Date(2_000));

      // The quick-start and coalesce-kill belong to the memo's own delivery.
      // A later ordinary delivery must not replay them against the run that
      // already holds the memo.
      h.manager.dispatch("a1");
      expect(actor.nudges).toEqual([{ priority: "responsive" }]);
    });

    it("refuses a retired actor and a name with no live actor", () => {
      const h = setup();
      live(h, "a1");
      append("a1", { type: "mesh.message" });
      append("gone", { type: "mesh.message" });

      h.statuses.set("a1", "retired");
      expect(h.manager.dispatch("a1")).toBe(false);
      expect(h.logs).toContain("dispatch(a1) refused — actor is retired");

      expect(h.manager.dispatch("gone")).toBe(false);
      expect(h.logs).toContain("dispatch(gone) refused — no live actor");
    });

    it("pages through unhandled responsive entries past 100 rows to find unseen work and voice timing", () => {
      const h = setup();
      const actor = live(h, "a1");

      // 1. Append 100 responsive entries with newer timestamps (t=2000..2099)
      for (let i = 0; i < 100; i++) {
        append("a1", { type: "human.message", priority: "responsive" }, new Date(2_000 + i));
      }
      // 2. Mark them seen so unseen is false on the first page
      inbox.markSeen("a1");

      // 3. Append older unseen entries with older timestamps (t=1000..1004)
      append("a1", { type: "human.voice", priority: "responsive" }, new Date(1_000));
      for (let i = 1; i <= 4; i++) {
        append("a1", { type: "human.message", priority: "responsive" }, new Date(1_000 + i));
      }

      // Exact paging must traverse beyond the first 100 rows, discover the unseen work,
      // and extract the newest unabsorbed voice timing from page 2.
      expect(h.manager.durableWork("a1")).toEqual({
        priority: "responsive",
        unseenResponsive: true,
        voiceAt: 1_000,
      });

      h.manager.dispatch("a1");
      expect(actor.nudges).toEqual([{ priority: "responsive", voiceTimestamp: 1_000 }]);
    });

    it("pages and collects arriving rows only when a policy hook is wired", () => {
      // A counting view of the real repository: the difference between the two
      // deployments is how much of the inbox each one reads.
      const counted = (): { repo: InboxRepository; responsiveLists: () => number } => {
        let responsiveLists = 0;
        const repo = new Proxy(inbox, {
          get(target, prop, receiver) {
            if (prop !== "list") return Reflect.get(target, prop, receiver);
            return (actorId: string, options: InboxListOptions = {}) => {
              if (options.responsiveOnly) responsiveLists++;
              return target.list(actorId, options);
            };
          },
        }) as InboxRepository;
        return { repo, responsiveLists: () => responsiveLists };
      };

      // An unseen voice memo on the first page, with a second page behind it.
      append("a1", { type: "human.voice", priority: "responsive" }, new Date(9_000));
      for (let i = 0; i < 120; i++) {
        append("a1", { type: "human.message", priority: "responsive" }, new Date(1_000 + i));
      }

      const plain = counted();
      const noHook = setup({ inbox: plain.repo });
      live(noHook, "a1");
      expect(noHook.manager.durableWork("a1")).toEqual({
        priority: "responsive",
        unseenResponsive: true,
        voiceAt: 9_000,
      });
      // The early exit is live: one page answered both questions.
      expect(plain.responsiveLists()).toBe(1);

      const observed = counted();
      const arrivals: string[][] = [];
      const withHook = setup({
        inbox: observed.repo,
        onResponsiveArrived: (_actorId, entries) => {
          arrivals.push(entries.map((entry) => entry.id));
        },
      });
      live(withHook, "a1");
      const work = withHook.manager.durableWork("a1");
      expect(work?.unseenResponsiveEntries).toHaveLength(121);
      expect(observed.responsiveLists()).toBeGreaterThan(1);

      withHook.manager.dispatch("a1");
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0]).toHaveLength(121);
    });

    it("forgets an actor's observed responsive rows when it is released or forgotten", () => {
      const arrivals: string[][] = [];
      const h = setup({
        onResponsiveArrived: (_actorId, entries) => {
          arrivals.push(entries.map((entry) => entry.id));
        },
      });
      live(h, "a1");
      // No run is admitted, so the row is never marked seen and stays unabsorbed.
      const entry = append("a1", { type: "human.message", priority: "responsive" });
      h.manager.dispatch("a1");
      h.manager.dispatch("a1");
      expect(arrivals).toEqual([[entry.id]]);

      // A released actor's state goes with it, so the row is a new arrival to
      // whatever comes back under that id rather than an inherited memory.
      h.manager.release("a1");
      live(h, "a1");
      h.manager.dispatch("a1");
      expect(arrivals).toEqual([[entry.id], [entry.id]]);

      h.manager.forget("a1");
      live(h, "a1");
      h.manager.dispatch("a1");
      expect(arrivals).toEqual([[entry.id], [entry.id], [entry.id]]);
    });

    it("returns no durable work and no-ops dispatch when backed by an empty inbox repository", () => {
      const emptyInbox = new EmptyInboxRepository();
      const h = setup({ inbox: emptyInbox });
      const actor = live(h, "a1");

      expect(h.manager.durableWork("a1")).toBeNull();
      expect(h.manager.dispatch("a1")).toBe(false);
      expect(actor.nudges).toEqual([]);
    });
  });

  describe("coalescing, single-flight and follow-up runs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("coalesces a burst of ordinary dispatches into one run", async () => {
      const h = setup();
      const actor = live(h, "a1", { debounceMs: 50 });
      append("a1", { type: "github.issue" });
      append("a1", { type: "github.issue" });
      append("a1", { type: "github.issue" });

      h.manager.dispatch("a1");
      h.manager.dispatch("a1");
      h.manager.dispatch("a1");
      await vi.advanceTimersByTimeAsync(60);

      expect(actor.nudges).toHaveLength(3);
      expect(actor.runs).toHaveLength(1);
    });

    it("collapses duplicate pokes for one durable entry into one run", async () => {
      const h = setup();
      const actor = live(h, "a1", { debounceMs: 20 });
      append("a1", { type: "mesh.message" });

      for (let i = 0; i < 5; i++) expect(h.manager.dispatch("a1")).toBe(true);
      await vi.advanceTimersByTimeAsync(30);

      expect(actor.runs).toEqual([ORDINARY_RUN]);
    });

    it("keeps a single run in flight and performs exactly one follow-up", async () => {
      const h = setup();
      const actor = live(h, "a1", { hold: true });
      append("a1", { type: "mesh.message" });

      h.manager.dispatch("a1");
      await vi.advanceTimersByTimeAsync(0);
      expect(actor.runs).toHaveLength(1);
      expect(actor.isRunning).toBe(true);

      // Three more dispatches while the run is in flight: one follow-up, not three.
      h.manager.dispatch("a1");
      h.manager.dispatch("a1");
      h.manager.dispatch("a1");
      expect(actor.runs).toHaveLength(1);

      await actor.finishRun();
      await vi.advanceTimersByTimeAsync(0);
      expect(actor.runs).toHaveLength(2);
    });

    it("quick-starts responsive work past the debounce window", async () => {
      const h = setup();
      const actor = live(h, "a1", { debounceMs: 5_000 });
      append("a1", { type: "human.message", priority: "responsive" });

      h.manager.dispatch("a1");
      await vi.advanceTimersByTimeAsync(0);

      expect(actor.runs).toEqual([{ priority: "responsive" }]);
    });
  });

  describe("responsive interruption", () => {
    it("replaces an in-flight run and reports the phase it interrupted", () => {
      const h = setup();
      const actor = live(h, "a1");
      actor.preemptPhase = "running";
      append("a1", { type: "system.disk", priority: "responsive" });

      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.preemptions).toBe(1);
      expect(h.preempted).toEqual([["a1", "running"]]);
    });

    it("reports nothing when there was no run to replace", () => {
      const h = setup();
      const actor = live(h, "a1");
      actor.preemptPhase = null;
      append("a1", { type: "system.disk", priority: "responsive" });

      h.manager.dispatch("a1");
      expect(actor.preemptions).toBe(1);
      expect(h.preempted).toEqual([]);
    });

    it("never preempts for ordinary durable work", () => {
      const h = setup();
      const actor = live(h, "a1");
      actor.preemptPhase = "running";
      append("a1", { type: "github.issue" });

      h.manager.dispatch("a1");
      expect(actor.preemptions).toBe(0);
      expect(h.preempted).toEqual([]);
    });

    it("does not replace a run over responsive work that run already absorbed", () => {
      const h = setup();
      const actor = live(h, "a1");
      actor.preemptPhase = "running";
      append("a1", { type: "human.message", priority: "responsive" });

      // The operator's message starts a run, which absorbs it. The row stays
      // unhandled for almost the whole run, because an actor marks its work
      // handled at the end.
      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.preemptions).toBe(1);
      inbox.markSeen("a1");

      // Ordinary traffic arriving mid-run — a child reporting in — must not
      // abort the run it is arriving behind. Left unguarded, the replacement
      // run re-selects the same entries and the next ordinary delivery aborts
      // that one too, so steady child traffic starves the operator's message.
      append("a1", { type: "mesh.message" });
      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.preemptions).toBe(1);
      expect(h.preempted).toEqual([["a1", "running"]]);

      // Genuinely new responsive work still replaces the run.
      append("a1", { type: "human.message", priority: "responsive" });
      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.preemptions).toBe(2);
      expect(h.preempted).toEqual([
        ["a1", "running"],
        ["a1", "running"],
      ]);
    });

    it("joins an active run instead of replacing it, via the internal construction port", () => {
      const h = setup();
      const actor = live(h, "a1");
      actor.preemptPhase = "running";
      append("a1", { type: "event.copy", priority: "responsive" });

      expect(h.internalPort).toBeDefined();
      expect(h.internalPort?.dispatchJoiningActiveRun("a1")).toBe(true);
      expect(actor.preemptions).toBe(0);
      expect(h.preempted).toEqual([]);
      // Responsive scheduling and admission are kept; only the abort is not.
      expect(actor.nudges).toEqual([{ priority: "responsive" }]);
    });
  });

  describe("voice session admission", () => {
    it("holds ordinary work for an active session without losing it", () => {
      const h = setup({ isVoiceSessionActive: (id) => id === "a1" });
      const actor = live(h, "a1");
      const entry = append("a1", { type: "github.issue" });

      expect(h.manager.dispatch("a1")).toBe(false);
      expect(actor.nudges).toEqual([]);
      expect(h.logs).toContain("dispatch(a1) held — active voice session");
      // Held, not dropped: the row is still the source of truth.
      expect(inbox.read("a1", entry.id)?.handledAt).toBeNull();
      expect(h.manager.durableWork("a1")).toEqual({ priority: "normal" });
    });

    it("admits responsive work through the hold", () => {
      const h = setup({ isVoiceSessionActive: () => true });
      const actor = live(h, "a1");
      append("a1", { type: "human.message", priority: "responsive" });

      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.nudges).toEqual([{ priority: "responsive" }]);
    });

    it("holds ordinary work arriving behind responsive work the session already holds", () => {
      const h = setup({ isVoiceSessionActive: () => true });
      const actor = live(h, "a1");
      append("a1", { type: "human.voice", priority: "responsive" });
      expect(h.manager.dispatch("a1")).toBe(true);
      inbox.markSeen("a1");

      // The memo is still unhandled, so the actor's durable priority is still
      // responsive — but nothing responsive has *arrived*. Admitting an
      // execution opportunity per ordinary delivery is exactly the traffic the
      // hold exists to keep out of the conversation.
      append("a1", { type: "github.issue" });
      expect(h.manager.dispatch("a1")).toBe(false);
      expect(actor.nudges).toHaveLength(1);
      expect(h.logs).toContain("dispatch(a1) held — active voice session");
    });

    it("releases the held work on the next dispatch once the session ends", () => {
      let active = true;
      const h = setup({ isVoiceSessionActive: () => active });
      const actor = live(h, "a1");
      append("a1", { type: "github.issue" });
      expect(h.manager.dispatch("a1")).toBe(false);

      active = false;
      expect(h.manager.dispatch("a1")).toBe(true);
      expect(actor.nudges).toEqual([{}]);
    });
  });

  describe("seen accounting", () => {
    it("marks the absorbed entries seen when an opportunity is already queued", () => {
      const h = setup();
      const actor = live(h, "a1");
      append("a1", { type: "mesh.message" });

      h.manager.dispatch("a1");
      expect(h.seen).toEqual([]);

      actor.queued = true;
      append("a1", { type: "mesh.message" });
      h.manager.dispatch("a1");
      expect(h.seen).toEqual(["a1"]);
    });
  });

  describe("construction, registration and terminal cleanup", () => {
    it("builds through the construction seam with the whole durable record", () => {
      const h = setup();
      const rec = record("w1", {
        executionTarget: "mac-mini",
        modelConfig: [{ provider: "claude", model: "opus" }],
        sessionId: "sess-1",
      });

      const actor = h.manager.instantiate(rec);

      expect(h.constructed).toEqual([rec]);
      expect(h.manager.isLive("w1")).toBe(true);
      expect(h.manager.liveActor("w1")).toBe(actor);
      expect(h.manager.liveIds()).toEqual(["w1"]);
    });

    it("registers nothing when construction throws", () => {
      const h = setup({
        constructActor: () => {
          throw new Error("no provider available");
        },
      });

      expect(() => h.manager.instantiate(record("w1"))).toThrow("no provider available");
      expect(h.manager.isLive("w1")).toBe(false);
      expect(h.manager.liveActor("w1")).toBeUndefined();
    });

    it("refuses to dispatch an actor that construction never produced", () => {
      const h = setup({
        constructActor: () => {
          throw new Error("boom");
        },
      });
      h.statuses.set("w1", "active");
      append("w1", { type: "mesh.message", priority: "responsive" });
      expect(() => h.manager.instantiate(record("w1"))).toThrow();

      expect(h.manager.dispatch("w1")).toBe(false);
      expect(h.logs).toContain("dispatch(w1) refused — no live actor");
    });

    it("closes and forgets one actor on release, and refuses it afterwards", () => {
      const h = setup();
      const actor = live(h, "a1");
      append("a1", { type: "mesh.message" });

      h.manager.release("a1");
      expect(actor.closed).toBe(1);
      expect(h.manager.isLive("a1")).toBe(false);
      expect(h.manager.dispatch("a1")).toBe(false);

      // Idempotent: a second release neither throws nor double-closes.
      h.manager.release("a1");
      expect(actor.closed).toBe(1);
    });

    it("forgets without closing, for a construction that never landed", () => {
      const h = setup();
      const actor = live(h, "a1");

      h.manager.forget("a1");
      expect(actor.closed).toBe(0);
      expect(h.manager.isLive("a1")).toBe(false);
    });

    it("closes every live actor on shutdown and keeps none registered", () => {
      const h = setup();
      const first = live(h, "a1");
      const second = live(h, "a2");

      h.manager.closeAll();

      expect(first.closed).toBe(1);
      expect(second.closed).toBe(1);
      expect(h.manager.liveIds()).toEqual([]);
    });

    it("exposes every live actor for mesh-wide sweeps", () => {
      const h = setup();
      live(h, "a1");
      live(h, "a2");

      expect([...h.manager.liveEntries()].map(([id]) => id)).toEqual(["a1", "a2"]);
    });
  });

  describe("admission: parallelism and quota together", () => {
    it("bounds concurrent ordinary runs at the configured parallelism", async () => {
      const h = setup({ maxConcurrent: 2 });
      const started: number[] = [];
      // One resolver per run, keyed by run rather than by start order, so a run
      // admitted later is still releasable.
      const release = [0, 1, 2, 3].map(() => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      });
      const handles = [0, 1, 2, 3].map((index) =>
        h.manager.gateRun(async () => {
          started.push(index);
          await release[index].promise;
        }, [CANDIDATE])
      );
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      await settle();
      expect(started).toEqual([0, 1]);
      expect(h.manager.inFlight).toBe(2);

      // Freeing one slot admits exactly the next queued run, in FIFO order.
      release[0].resolve();
      await handles[0].result;
      await settle();
      expect(started).toEqual([0, 1, 2]);
      expect(h.manager.inFlight).toBe(2);

      for (const entry of release) entry.resolve();
      await Promise.all(handles.map((handle) => handle.result));
      expect(started).toEqual([0, 1, 2, 3]);
      expect(h.manager.inFlight).toBe(0);
    });

    it("lets responsive runs bypass the parallelism bound", async () => {
      const h = setup({ maxConcurrent: 1 });
      const started: string[] = [];
      const blocker = h.manager.gateRun(async () => {
        started.push("normal");
        await new Promise(() => {});
      }, [CANDIDATE]);
      await Promise.resolve();
      expect(started).toEqual(["normal"]);

      const urgent = h.manager.gateRun(
        async () => {
          started.push("responsive");
        },
        [CANDIDATE],
        true
      );
      await urgent.result;

      expect(started).toEqual(["normal", "responsive"]);
      expect(blocker.started).toBe(true);
    });

    it("admits pacing and parallelism through one gate and records its selection", async () => {
      const paced: Array<{ responsive: boolean; threadId?: string }> = [];
      const gate: MeshProviderGate = (fn, candidates, opts) => {
        paced.push({ responsive: opts.responsive, threadId: opts.threadId });
        opts.onSelected?.(selectionFor(candidates[0], opts.responsive));
        return opts.enqueueNormal(() => fn(candidates[0]));
      };
      const h = setup({ providerGate: gate, maxConcurrent: 1 });

      const handle = h.manager.gateRun(async () => "ok", [CANDIDATE], false, "a1");
      await expect(handle.result).resolves.toBe("ok");

      expect(paced).toEqual([{ responsive: false, threadId: "a1" }]);
      expect(h.manager.selectionFor("a1")).toMatchObject({
        provider: "claude",
        model: "opus",
        declaredIndex: 0,
        responsive: false,
      });

      h.manager.clearSelection("a1");
      expect(h.manager.selectionFor("a1")).toBeUndefined();
    });

    it("records no selection for a run with no owning thread", async () => {
      const gate: MeshProviderGate = (fn, candidates, opts) => {
        opts.onSelected?.(selectionFor(candidates[0], false));
        return opts.enqueueNormal(() => fn(candidates[0]));
      };
      const h = setup({ providerGate: gate });

      await h.manager.gateRun(async () => "ok", [CANDIDATE]).result;
      expect(h.manager.selectionFor("")).toBeUndefined();
    });

    it("drops a released actor's reservation with it", async () => {
      const gate: MeshProviderGate = (fn, candidates, opts) => {
        opts.onSelected?.(selectionFor(candidates[0], false));
        return opts.enqueueNormal(() => fn(candidates[0]));
      };
      const h = setup({ providerGate: gate });
      live(h, "a1");
      await h.manager.gateRun(async () => "ok", [CANDIDATE], false, "a1").result;
      expect(h.manager.selectionFor("a1")).toBeDefined();

      h.manager.release("a1");
      expect(h.manager.selectionFor("a1")).toBeUndefined();
    });

    it("surfaces a run's own failure without disturbing the parallelism bound", async () => {
      const h = setup({ maxConcurrent: 1 });

      const failing = h.manager.gateRun(async () => {
        throw new Error("provider exploded");
      }, [CANDIDATE]);
      await expect(failing.result).rejects.toThrow("provider exploded");

      expect(h.manager.inFlight).toBe(0);
      const next = h.manager.gateRun(async () => "recovered", [CANDIDATE]);
      await expect(next.result).resolves.toBe("recovered");
    });
  });
});
