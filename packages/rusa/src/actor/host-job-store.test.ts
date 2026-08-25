import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileHostJobStore, type HostJobRecord, InMemoryHostJobStore } from "./host-job-store.js";

function job(overrides: Partial<HostJobRecord> = {}): HostJobRecord {
  return {
    id: "job-1",
    actorId: "actor-a",
    unitName: "job-handle-a-12345678",
    scriptLabel: "echo hi",
    manifest: { readPaths: [] },
    auditArtifactPath: "/tmp/mc-home/host-jobs/audit/job-1.json",
    auditArtifactSha256: "a".repeat(64),
    runtimeMaxSec: 3600,
    submittedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("InMemoryHostJobStore", () => {
  it("submits and reads back a job", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job());
    expect(store.get("job-1")).toEqual(job());
  });

  it("finds a job by its unit name", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job());
    expect(store.findByUnitName("job-handle-a-12345678")?.id).toBe("job-1");
    expect(store.findByUnitName("no-such-unit")).toBeUndefined();
  });

  it("scopes listFor to one actor", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job({ id: "job-1", actorId: "actor-a" }));
    store.submit(job({ id: "job-2", actorId: "actor-b" }));
    expect(store.listFor("actor-a").map((j) => j.id)).toEqual(["job-1"]);
    expect(
      store
        .list()
        .map((j) => j.id)
        .sort()
    ).toEqual(["job-1", "job-2"]);
  });

  it("counts only active (not-yet-exited) jobs toward activeCountFor", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job({ id: "job-1", actorId: "actor-a" }));
    store.submit(job({ id: "job-2", actorId: "actor-a" }));
    expect(store.activeCountFor("actor-a")).toBe(2);
    store.recordExit("job-1", "2026-07-01T01:00:00.000Z", "success");
    expect(store.activeCountFor("actor-a")).toBe(1);
  });

  it("recordStopRequested and recordExit are no-ops on an unknown id", () => {
    const store = new InMemoryHostJobStore();
    expect(() =>
      store.recordStopRequested("no-such-job", "2026-07-01T00:00:00.000Z")
    ).not.toThrow();
    expect(() =>
      store.recordExit("no-such-job", "2026-07-01T00:00:00.000Z", "success")
    ).not.toThrow();
  });

  it("recordStopRequested and recordExit do not overwrite an already-set timestamp", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job());
    store.recordStopRequested("job-1", "2026-07-01T01:00:00.000Z");
    store.recordStopRequested("job-1", "2026-07-01T02:00:00.000Z");
    expect(store.get("job-1")?.stopRequestedAt).toBe("2026-07-01T01:00:00.000Z");
    store.recordExit("job-1", "2026-07-01T03:00:00.000Z", "success", "0");
    store.recordExit("job-1", "2026-07-01T04:00:00.000Z", "signal", "15");
    expect(store.get("job-1")?.completedAt).toBe("2026-07-01T03:00:00.000Z");
    expect(store.get("job-1")?.exitStatus).toBe("success");
    expect(store.get("job-1")?.exitCode).toBe("0");
  });

  it("get/list/findByUnitName return defensive copies", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job());
    const got = store.get("job-1");
    expect(got).toBeDefined();
    if (got) got.scriptLabel = "mutated";
    expect(store.get("job-1")?.scriptLabel).toBe("echo hi");
  });
});

describe("FileHostJobStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-job-store-test-"));
    file = join(dir, "host-jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a submitted job across store instances", () => {
    const store1 = new FileHostJobStore(file);
    store1.submit(job());

    const store2 = new FileHostJobStore(file);
    expect(store2.get("job-1")).toEqual(job());
  });

  it("picks up a write from another process (refreshFromDisk on every read)", () => {
    const store1 = new FileHostJobStore(file);
    const store2 = new FileHostJobStore(file);
    store1.submit(job());
    // store2 never called submit itself; it must see store1's write on its next read.
    expect(store2.get("job-1")).toEqual(job());
    expect(store2.activeCountFor("actor-a")).toBe(1);
  });

  it("tolerates a missing file (starts empty rather than throwing)", () => {
    const store = new FileHostJobStore(join(dir, "does-not-exist.json"));
    expect(store.list()).toEqual([]);
  });

  it("persists recordStopRequested and recordExit", () => {
    const store1 = new FileHostJobStore(file);
    store1.submit(job());
    store1.recordStopRequested("job-1", "2026-07-01T01:00:00.000Z");
    store1.recordExit("job-1", "2026-07-01T02:00:00.000Z", "success", "0");

    const store2 = new FileHostJobStore(file);
    const reloaded = store2.get("job-1");
    expect(reloaded?.stopRequestedAt).toBe("2026-07-01T01:00:00.000Z");
    expect(reloaded?.completedAt).toBe("2026-07-01T02:00:00.000Z");
    expect(reloaded?.exitStatus).toBe("success");
    expect(reloaded?.exitCode).toBe("0");
  });
});
