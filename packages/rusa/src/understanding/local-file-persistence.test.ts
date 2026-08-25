import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cupid, MemoryLocalStore, SyncClient } from "@thkp-eng/goals-core";
import { type AnyOp, compressOp, type DocumentContentsLogEntry } from "@thkp-eng/goals-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFilePersistenceService } from "./local-file-persistence.js";

function createDelta(text: string): Parameters<SyncClient["modifyGoal"]>[0] {
  return {
    id: Cupid.random().encode(),
    text,
    logEntry: {
      id: Cupid.random().encode(),
      creationTime: Date.now(),
      type: "documentContents",
      text: `# ${text}\n`,
    } as DocumentContentsLogEntry,
  };
}

/** Generate real ops (no network) via a throwaway null-persistence client. */
async function genOps(...texts: string[]): Promise<AnyOp[]> {
  const store = new MemoryLocalStore();
  const client = new SyncClient(null, store);
  await client.init();
  for (const t of texts) await client.modifyGoal(createDelta(t));
  return store.getUnsyncedOps();
}

/** A SyncClient over the service, pre-seeded from its files (the production wiring shape). */
async function clientOver(svc: LocalFilePersistenceService): Promise<SyncClient> {
  const store = new MemoryLocalStore();
  await store.storeSyncedOps(svc.readAll()); // seed cache from baseline+ops (no subscribe race)
  const client = new SyncClient(svc, store);
  await client.init();
  return client;
}

const titles = (c: SyncClient): string[] => [...c.getGoals().values()].map((g) => g.text);

describe("LocalFilePersistenceService", () => {
  let baselinePath: string;
  let opsLogPath: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "lfp-"));
    baselinePath = join(dir, "baseline.jsonl");
    opsLogPath = join(dir, "ops.jsonl");
  });

  it("ensureBaseline pulls once, writes the cache, and is idempotent", async () => {
    const baseline = await genOps("Baseline Concept");
    let pulls = 0;
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => {
      pulls++;
      return baseline;
    });
    expect(await svc.ensureBaseline()).toBe(true);
    expect(existsSync(baselinePath)).toBe(true);
    expect(await svc.ensureBaseline()).toBe(true);
    expect(pulls).toBe(1); // write-once
    expect(
      svc
        .readAll()
        .map((o) => o.id)
        .sort()
    ).toEqual(baseline.map((o) => o.id).sort());
  });

  it("ensureBaseline returns false + writes nothing when the remote is unreachable", async () => {
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => null);
    expect(await svc.ensureBaseline()).toBe(false);
    expect(existsSync(baselinePath)).toBe(false); // no phantom baseline
  });

  it("save() appends to the ops-log ONLY — never a remote write", async () => {
    const baseline = await genOps("Baseline");
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => baseline);
    await svc.ensureBaseline();
    const newOps = await genOps("Insight A", "Insight B");
    await svc.save(newOps);
    // ops-log holds exactly the new ops; baseline file untouched.
    expect(existsSync(opsLogPath)).toBe(true);
    expect(readFileSync(opsLogPath, "utf-8").trim().split("\n")).toHaveLength(2);
    expect(svc.readAll()).toHaveLength(3); // baseline (1) + ops (2)
  });

  it("a SyncClient over it reads the baseline and its own writes (read-your-writes)", async () => {
    const baseline = await genOps("Baseline Concept");
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => baseline);
    expect(await svc.ensureBaseline()).toBe(true);

    const client = await clientOver(svc);
    expect(titles(client)).toContain("Baseline Concept");

    await client.modifyGoal(createDelta("Distilled Insight"));
    expect(titles(client)).toContain("Distilled Insight"); // read-your-writes in state
    expect(svc.readAll().some((o) => JSON.stringify(o).includes("Distilled Insight"))).toBe(true);
  });

  it("a fresh client rebuilds the full would-be graph from the files (restart)", async () => {
    const baseline = await genOps("Baseline Concept");
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => baseline);
    await svc.ensureBaseline();
    const first = await clientOver(svc);
    await first.modifyGoal(createDelta("Distilled Insight"));

    // Simulate a restart: a brand-new service + client over the SAME files.
    const svc2 = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => {
      throw new Error("must not re-pull — baseline file already exists");
    });
    expect(await svc2.ensureBaseline()).toBe(true); // file exists → no pull
    const restarted = await clientOver(svc2);
    expect(titles(restarted)).toEqual(
      expect.arrayContaining(["Baseline Concept", "Distilled Insight"])
    );
  });

  it("tolerates a torn/malformed trailing line (crash mid-append) — readAll doesn't throw", async () => {
    const baseline = await genOps("A", "B");
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => baseline);
    await svc.ensureBaseline();
    await svc.save(await genOps("Good Insight"));
    // Simulate a crash mid-`appendFileSync`: a truncated JSON line with no trailing newline.
    appendFileSync(opsLogPath, '{"id":"torn","hlcTimestamp":"zzzz","ty');
    expect(() => svc.readAll()).not.toThrow();
    expect(svc.readAll()).toHaveLength(3); // 2 baseline + 1 good; the torn line is skipped
    // The client still rebuilds cleanly over the torn file.
    const client = await clientOver(svc);
    expect(titles(client)).toEqual(expect.arrayContaining(["A", "B", "Good Insight"]));
  });

  it("load/count honor the cursor; loadString is null", async () => {
    const baseline = await genOps("A", "B", "C");
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => baseline);
    await svc.ensureBaseline();
    const all = svc.readAll();
    expect(await svc.count({})).toBe(3);
    const mid = all[0].hlcTimestamp;
    const after = await svc.load({ cursor: mid });
    expect(after.ops.every((o) => o.hlcTimestamp > mid)).toBe(true);
    expect(await svc.count({ cursor: mid })).toBe(after.ops.length);
    expect(await svc.loadString()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live auto-sync (ISSUE_NUM going-live): the opt-in `pushRemote` outbox path
// ---------------------------------------------------------------------------

/** A fake remote sink recording pushed ops; optionally fails the first N pushes. */
function fakeSink(opts: { failTimes?: number } = {}) {
  const pushed: AnyOp[] = [];
  let fails = opts.failTimes ?? 0;
  return {
    pushed,
    push: async (ops: AnyOp[]) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("remote push failed");
      }
      pushed.push(...ops);
    },
  };
}

describe("LocalFilePersistenceService — live auto-sync ", () => {
  let baselinePath: string;
  let opsLogPath: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "lfp-sync-"));
    baselinePath = join(dir, "baseline.jsonl");
    opsLogPath = join(dir, "ops.jsonl");
  });
  afterEach(() => vi.restoreAllMocks());

  it("save() pushes immediately (restamped), folds into baseline, and empties the outbox", async () => {
    const sink = fakeSink();
    const svc = new LocalFilePersistenceService(
      baselinePath,
      opsLogPath,
      async () => [],
      sink.push
    );
    await svc.ensureBaseline();
    const ops = await genOps("Live Node");
    await svc.save(ops);

    // Pushed the same ops BY IDENTITY (op.id), but with FRESH HLCs (restamped for cursor-visibility).
    expect(sink.pushed.map((o) => o.id).sort()).toEqual(ops.map((o) => o.id).sort());
    expect(sink.pushed.map((o) => o.hlcTimestamp)).not.toEqual(ops.map((o) => o.hlcTimestamp));
    expect(readFileSync(opsLogPath, "utf-8").trim()).toBe(""); // outbox drained
    expect(svc.readAll()).toHaveLength(ops.length); // graph intact (moved log → baseline)
    expect(svc.unsyncedCount()).toBe(0);
  });

  it("restamps ops with fresh HLCs on push (op.id preserved; dominates the graph's max HLC)", async () => {
    // Baseline already holds an op; a held op must be restamped ABOVE the graph's highest HLC so
    // it lands ahead of every client's incremental-sync cursor (Firestore orders by __name__=HLC).
    const baseline = await genOps("Existing Node");
    const local = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => baseline);
    await local.ensureBaseline();
    const stale = await genOps("Stale Op One", "Stale Op Two");
    await local.save(stale); // held locally (no sink)

    const sink = fakeSink();
    const svc = new LocalFilePersistenceService(
      baselinePath,
      opsLogPath,
      async () => [],
      sink.push
    );
    await svc.syncOutbox(1); // chunk of 1 → exercises per-chunk restamping

    expect(sink.pushed.map((o) => o.id).sort()).toEqual(stale.map((o) => o.id).sort()); // op.id preserved
    const baselineMax = [...baseline.map((o) => o.hlcTimestamp)].sort().at(-1) ?? "";
    for (const p of sink.pushed) {
      const original = stale.find((s) => s.id === p.id);
      expect(p.hlcTimestamp).not.toBe(original?.hlcTimestamp); // restamped fresh
      // string compare mirrors Firestore's orderBy(__name__): the restamped HLC sorts AFTER the
      // graph's highest, so it's visible to a cursor paging startAfter().
      expect(p.hlcTimestamp > baselineMax).toBe(true);
    }
    expect(svc.unsyncedCount()).toBe(0); // outbox drained; restamped versions folded into baseline
  });

  it("syncOutbox() batch-drains a pre-existing backlog (the going-live first push)", async () => {
    // Seed an outbox WITHOUT a sink (no push), then re-open WITH a sink and drain.
    const local = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => []);
    await local.ensureBaseline();
    const backlog = await genOps("Alpha", "Beta", "Gamma");
    await local.save(backlog);
    expect(local.unsyncedCount()).toBe(backlog.length); // held locally, unsynced

    const sink = fakeSink();
    const svc = new LocalFilePersistenceService(
      baselinePath,
      opsLogPath,
      async () => [],
      sink.push
    );
    await svc.syncOutbox(2); // chunked
    expect(sink.pushed).toHaveLength(backlog.length);
    expect(svc.unsyncedCount()).toBe(0);
  });

  it("a failed push warns LOUDLY with the held count, leaves the outbox, and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = fakeSink({ failTimes: 1 });
    const svc = new LocalFilePersistenceService(
      baselinePath,
      opsLogPath,
      async () => [],
      sink.push
    );
    await svc.ensureBaseline();
    const ops = await genOps("Node A", "Node B");

    await expect(svc.save(ops)).resolves.toBeUndefined(); // never throws out of the local write
    expect(svc.unsyncedCount()).toBe(ops.length); // outbox intact for retry
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${ops.length} op(s) held UNSYNCED`),
      expect.anything()
    );

    // A later sync (push now succeeds) drains the retained backlog — no silent loss.
    await svc.syncOutbox();
    expect(sink.pushed).toHaveLength(ops.length);
    expect(svc.unsyncedCount()).toBe(0);
  });

  it("without a pushRemote sink it stays purely local (read paths never push)", async () => {
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => []);
    await svc.ensureBaseline();
    await svc.save(await genOps("Local Only"));
    await svc.syncOutbox(); // no-op (no sink configured)
    expect(svc.unsyncedCount()).toBeGreaterThan(0); // ops remain held locally, never pushed
  });

  it("syncOutbox is idempotent: a second drain finds nothing to push", async () => {
    const sink = fakeSink();
    const svc = new LocalFilePersistenceService(
      baselinePath,
      opsLogPath,
      async () => [],
      sink.push
    );
    await svc.ensureBaseline();
    await svc.save(await genOps("Once"));
    const pushedAfterFirst = sink.pushed.length;
    await svc.syncOutbox();
    expect(sink.pushed.length).toBe(pushedAfterFirst); // nothing new pushed
  });

  // String-externalization contract (Operator's ISSUE_NUM review). The push reuses glass_goals' own
  // `FirestorePersistenceService.save()`, which runs `extractEntryTextField(compressOp(op))`:
  // it moves the documentContents BODY (`d.lE.te`) to `v001_strings/{d.lE.i}` and NULLS `te`
  // on the op before writing to `v001_ops` — so pushed ops are body-text-LESS (the node title
  // `d.t` stays inline). Our distiller ops store the body inline locally; this locks that they
  // compress to exactly the shape that externalization reads, so a goals-types key change can't
  // silently push un-externalized inline bodies upstream.
  it("distiller ops compress so the remote save() externalizes the body (not the title)", async () => {
    const [op] = await genOps("Body Node"); // title "Body Node"; documentContents body "# Body Node\n"
    const wire = compressOp(op) as unknown as {
      d: { t?: unknown; lE?: { i?: unknown; te?: unknown } };
    };
    expect(typeof wire.d.lE?.i).toBe("string"); // entry id → the v001_strings doc key
    expect(wire.d.lE?.te).toContain("Body Node"); // body lives at d.lE.te (externalized + stripped on push)
    expect(wire.d.t).toBe("Body Node"); // title stays inline in the op (short; not externalized)
  });

  it("serializes concurrent syncOutbox drains — no interleaved read-modify-write race ", async () => {
    // Seed a multi-op backlog locally (no sink → held).
    const local = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => []);
    await local.ensureBaseline();
    await local.save(await genOps("A", "B", "C", "D"));

    // A slow sink that tracks concurrent push depth: without serialization, two drains' pushes
    // overlap and depth hits 2; with the syncChain guard they run one-at-a-time (depth stays 1).
    let active = 0;
    let maxActive = 0;
    const slowSink = async (_ops: AnyOp[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => [], slowSink);

    // Fire two drains concurrently (the ISSUE_NUM trigger shape: rapid saves each awaiting their own
    // syncOutbox). chunkSize 1 → many small pushes → a wide interleave window.
    await Promise.all([svc.syncOutbox(1), svc.syncOutbox(1)]);

    expect(maxActive).toBe(1); // serialized — pushes never overlapped
    expect(svc.unsyncedCount()).toBe(0); // every op drained; none silently dropped by a race
  });
});
