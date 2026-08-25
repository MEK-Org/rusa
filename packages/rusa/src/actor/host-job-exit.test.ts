import { describe, expect, it } from "vitest";
import { handleHostJobExit } from "./host-job-exit.js";
import { type HostJobRecord, InMemoryHostJobStore } from "./host-job-store.js";
import type { MeshEventInput } from "./mesh-events.js";

function job(overrides: Partial<HostJobRecord> = {}): HostJobRecord {
  return {
    id: "job-id-1",
    actorId: "actor-a",
    unitName: "job-handle-a-12345678",
    scriptLabel: "echo hi",
    manifest: { readPaths: [] },
    auditArtifactPath: "/tmp/audit.json",
    auditArtifactSha256: "abc",
    runtimeMaxSec: 60,
    submittedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("handleHostJobExit", () => {
  it("resolves by job id and records/wakes with the stored unit name even if unitName is %n", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job());
    const events: MeshEventInput[] = [];
    const wakes: { actorId: string; reason: string }[] = [];

    handleHostJobExit(
      {
        store,
        recordEvent: (event) => events.push(event),
        deliverWake: (actorId, reason) => {
          wakes.push({ actorId, reason });
          return true;
        },
        now: () => "2026-07-13T00:01:00.000Z",
      },
      {
        jobId: "job-id-1",
        unitName: "%n",
        actorId: "actor-from-script",
        result: "success",
        exitStatus: "0",
      }
    );

    expect(store.get("job-id-1")).toMatchObject({
      completedAt: "2026-07-13T00:01:00.000Z",
      exitStatus: "success",
      exitCode: "0",
    });
    expect(events).toEqual([
      {
        kind: "host_job_exited",
        actorId: "actor-a",
        detail: "job-handle-a-12345678 jobId=job-id-1 result=success exitStatus=0",
      },
    ]);
    expect(wakes).toEqual([
      {
        actorId: "actor-a",
        reason: "host job job-handle-a-12345678 jobId=job-id-1 exited: success",
      },
    ]);
    expect(`${events[0]?.detail}\n${wakes[0]?.reason}`).not.toContain("%n");
  });

  it("stamps structured exitStatus/exitCode/completedAt onto the record from the exit payload, not just liveStatus prose", () => {
    const store = new InMemoryHostJobStore();
    store.submit(job({ id: "job-id-2", unitName: "job-handle-a-87654321" }));

    handleHostJobExit(
      {
        store,
        recordEvent: () => {},
        deliverWake: () => true,
        now: () => "2026-07-13T00:05:00.000Z",
      },
      {
        jobId: "job-id-2",
        unitName: "job-handle-a-87654321",
        actorId: "actor-a",
        result: "exit-code",
        exitStatus: "17",
      }
    );

    const record = store.get("job-id-2");
    expect(record?.completedAt).toBe("2026-07-13T00:05:00.000Z");
    expect(record?.exitStatus).toBe("exit-code");
    expect(record?.exitCode).toBe("17");
  });
});
