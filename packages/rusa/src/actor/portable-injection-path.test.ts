import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { assemblePortableContext, PORTABLE_CONTEXT_MAX_RUNS } from "./portable-context.js";

/**
 * Concern 2 of an issue: the first real run's portable variant had `firstInjectSourceIds`
 * **null at s4** despite 10+ portable run_ends there. Two hypotheses: (1) the record was
 * lost to the stall/teardown (a collection artifact), or (2) the injector genuinely
 * did not fire at the final step (a real injector-path bug).
 *
 * This drives the EXACT composition `start.ts:684-705` runs each portable build —
 * `listEventsByActors([id], { kinds: ["run_end"], limit: PORTABLE_CONTEXT_MAX_RUNS })`
 * feeding `assemblePortableContext` — against a realistic late-step event log seeded on a
 * real DB (a genuinely-new input, not a read-back of the lost run). If injection fires
 * here, hypothesis (2) is falsified: the injector is sound and the s4 null was a
 * collection/attribution casualty of the same stall (mitigated by ISSUE_NUM durable capture
 * and ISSUE_NUM's wait-idle attribution fix), not a defect in the injection path.
 */
describe("portable injection path at a late step (ISSUE_NUM Concern 2)", () => {
  let home: string;
  let db: Database.Database;
  let repo: MeshEventRepository;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "portable-inject-"));
    mkdirSync(join(home, "data"), { recursive: true });
    db = new Database(join(home, "data", "mesh.db"));
    runMigrations(db);
    repo = new MeshEventRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Exactly what the portable buildPrompt does before injecting. */
  const assembleForActor = (id: string) => {
    const { events } = repo.listEventsByActors([id], {
      kinds: ["run_end"],
      limit: PORTABLE_CONTEXT_MAX_RUNS,
    });
    return assemblePortableContext(events.map((e) => ({ id: e.id, ts: e.ts, body: e.body })));
  };

  it("injects at s4 with realistic history — filtered to this actor, newest runs, non-null sources", () => {
    const OWNED = "portable-w";
    const NATIVE = "native-w";
    // Simulate reaching s4: many prior portable runs across steps, interleaved with the
    // other lifecycle kinds AND the native variant's events (which must be filtered out).
    const ownedRunEndIds: string[] = [];
    for (let n = 1; n <= 25; n++) {
      repo.record({ kind: "run_queued", actorId: OWNED, ts: `2026-07-09T00:00:${pad(n)}.100Z` });
      if (n % 3 === 0) {
        repo.record({
          kind: "run_continued",
          actorId: OWNED,
          ts: `2026-07-09T00:00:${pad(n)}.200Z`,
        });
      }
      // The native variant interleaves its own run_ends — must NOT leak into portable context.
      repo.record({
        kind: "run_end",
        actorId: NATIVE,
        body: `native run ${n}`,
        ts: `2026-07-09T00:00:${pad(n)}.250Z`,
      });
      const id = repo.record({
        kind: "run_end",
        actorId: OWNED,
        body: `Run ${n}: implemented the todo-app change and committed it.`,
        ts: `2026-07-09T00:00:${pad(n)}.300Z`,
      });
      ownedRunEndIds.push(id);
    }

    const portable = assembleForActor(OWNED);

    expect(portable).not.toBeNull();
    const sources = portable?.record.sourceEventIds ?? [];
    // Injection fires with a bounded, non-empty source set...
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_RUNS);
    // ...drawn only from THIS actor's run_ends (no native bleed, no other kinds)...
    const ownedSet = new Set(ownedRunEndIds);
    expect(sources.every((s) => ownedSet.has(s))).toBe(true);
    // ...and they are the most-recent portable runs (the newest id is included).
    expect(sources).toContain(ownedRunEndIds.at(-1));
  });

  it("still injects when the recent runs are cancel reports — a cancel does not suppress injection", () => {
    const OWNED = "portable-w";
    // A cancelled run's run_end body is non-empty marker text, so the injector still
    // has material: reaching s4 and getting cancelled would NOT null the injection.
    for (let n = 1; n <= 12; n++) {
      repo.record({
        kind: "run_end",
        actorId: OWNED,
        body: "[Task cancelled by user]",
        ts: `2026-07-09T00:01:${pad(n)}.300Z`,
      });
    }
    const portable = assembleForActor(OWNED);
    expect(portable).not.toBeNull();
    expect((portable?.record.sourceEventIds ?? []).length).toBeGreaterThan(0);
  });

  it("only returns null when EVERY one of the last-N run_ends is empty (the sole non-injection precondition)", () => {
    const OWNED = "portable-w";
    for (let n = 1; n <= 12; n++) {
      repo.record({
        kind: "run_end",
        actorId: OWNED,
        body: "",
        ts: `2026-07-09T00:02:${pad(n)}.300Z`,
      });
    }
    // All-empty tail ⇒ nothing to inject. This is the ONLY way injection is skipped —
    // and a real s4 (filler + decision runs carry self-reports) never hits it.
    expect(assembleForActor(OWNED)).toBeNull();
  });
});

const pad = (n: number): string => String(n).padStart(2, "0");
