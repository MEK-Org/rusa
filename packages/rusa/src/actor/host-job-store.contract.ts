import { describe, expect, it } from "vitest";
import type { HostJobRecord, HostJobStore } from "./host-job-store.js";

export const ACTOR_A = "actor-a";
export const ACTOR_B = "actor-b";

export const job = (over: Partial<HostJobRecord> = {}): HostJobRecord => ({
  id: "job-1",
  actorId: ACTOR_A,
  unitName: "job-handle-a-12345678",
  scriptLabel: "echo hi",
  manifest: { readPaths: [] },
  auditArtifactPath: "/tmp/mc-home/host-jobs/audit/job-1.json",
  auditArtifactSha256: "a".repeat(64),
  runtimeMaxSec: 3600,
  submittedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const byId = (a: HostJobRecord, b: HostJobRecord): number => a.id.localeCompare(b.id);

/**
 * Behavior every {@link HostJobStore} implementation must satisfy, independent
 * of backing storage — run against both `InMemoryHostJobStore` and
 * `DbHostJobStore`. Implementation-specific concerns (FK/uniqueness
 * enforcement, reopen, cross-connection visibility) stay in each store's own
 * test file. `list()` has no documented ordering, so multi-row assertions here
 * sort before comparing.
 */
export function testHostJobStoreContract(name: string, makeStore: () => HostJobStore): void {
  describe(`${name} (HostJobStore contract)`, () => {
    it("submits and reads back a job", () => {
      const store = makeStore();
      store.submit(job());
      expect(store.get("job-1")).toEqual(job());
    });

    it("round-trips every optional field once set", () => {
      const store = makeStore();
      store.submit(job({ manifest: { readPaths: ["/srv/data", "/etc/hosts"] } }));
      store.recordStopRequested("job-1", "2026-07-01T01:00:00.000Z");
      store.recordExit("job-1", "2026-07-01T02:00:00.000Z", "exit-code", "17");
      expect(store.get("job-1")).toEqual(
        job({
          manifest: { readPaths: ["/srv/data", "/etc/hosts"] },
          stopRequestedAt: "2026-07-01T01:00:00.000Z",
          completedAt: "2026-07-01T02:00:00.000Z",
          exitStatus: "exit-code",
          exitCode: "17",
        })
      );
    });

    it("records an exit with no exit code", () => {
      const store = makeStore();
      store.submit(job());
      store.recordExit("job-1", "2026-07-01T02:00:00.000Z", "oom-kill");
      const exited = store.get("job-1");
      expect(exited?.exitStatus).toBe("oom-kill");
      expect(exited?.exitCode).toBeUndefined();
    });

    it("returns undefined for an unknown job", () => {
      const store = makeStore();
      expect(store.get("no-such-job")).toBeUndefined();
    });

    it("finds a job by its unit name", () => {
      const store = makeStore();
      store.submit(job());
      expect(store.findByUnitName("job-handle-a-12345678")?.id).toBe("job-1");
      expect(store.findByUnitName("no-such-unit")).toBeUndefined();
    });

    it("scopes listFor to one actor and list() to all of them", () => {
      const store = makeStore();
      store.submit(job({ id: "job-1", actorId: ACTOR_A, unitName: "unit-1" }));
      store.submit(job({ id: "job-2", actorId: ACTOR_B, unitName: "unit-2" }));
      expect(store.listFor(ACTOR_A).map((j) => j.id)).toEqual(["job-1"]);
      expect(store.listFor(ACTOR_B).map((j) => j.id)).toEqual(["job-2"]);
      expect([...store.list()].sort(byId).map((j) => j.id)).toEqual(["job-1", "job-2"]);
    });

    it("counts only active (not-yet-exited) jobs toward activeCountFor", () => {
      const store = makeStore();
      store.submit(job({ id: "job-1", actorId: ACTOR_A, unitName: "unit-1" }));
      store.submit(job({ id: "job-2", actorId: ACTOR_A, unitName: "unit-2" }));
      expect(store.activeCountFor(ACTOR_A)).toBe(2);
      store.recordExit("job-1", "2026-07-01T01:00:00.000Z", "success");
      expect(store.activeCountFor(ACTOR_A)).toBe(1);
      expect(store.activeCountFor(ACTOR_B)).toBe(0);
    });

    // A stop request does not free the slot: the unit may take a while to exit,
    // and until it does it is still consuming host-plane concurrency.
    it("keeps a stop-requested job active until it actually exits", () => {
      const store = makeStore();
      store.submit(job());
      store.recordStopRequested("job-1", "2026-07-01T01:00:00.000Z");
      expect(store.activeCountFor(ACTOR_A)).toBe(1);
      store.recordExit("job-1", "2026-07-01T02:00:00.000Z", "signal", "15");
      expect(store.activeCountFor(ACTOR_A)).toBe(0);
    });

    it("recordStopRequested and recordExit are no-ops on an unknown id", () => {
      const store = makeStore();
      expect(() =>
        store.recordStopRequested("no-such-job", "2026-07-01T00:00:00.000Z")
      ).not.toThrow();
      expect(() =>
        store.recordExit("no-such-job", "2026-07-01T00:00:00.000Z", "success")
      ).not.toThrow();
      expect(store.list()).toEqual([]);
    });

    it("recordStopRequested and recordExit do not overwrite an already-set timestamp", () => {
      const store = makeStore();
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

    it("get/list/findByUnitName return copies the caller cannot write through", () => {
      const store = makeStore();
      store.submit(job());
      const got = store.get("job-1");
      expect(got).toBeDefined();
      if (got) {
        got.scriptLabel = "mutated";
        got.manifest.readPaths.push("/etc/shadow");
      }
      expect(store.get("job-1")?.scriptLabel).toBe("echo hi");
      expect(store.get("job-1")?.manifest.readPaths).toEqual([]);
    });
  });
}
