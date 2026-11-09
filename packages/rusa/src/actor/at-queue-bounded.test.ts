// Reproduction and verification for MEK-Org/rusa#1274.
//
// Scheduling a wake re-reads the whole `at` queue with one synchronous process
// spawn per queued job, blocking the event loop.
//
// Scheduling, confirming or removing one wake must do a bounded amount of
// blocking work that does not grow with the number of unrelated jobs in the queue.

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type AtIo, execAtIo, unavailableAtIo } from "./at-queue.js";
import { type CrontabIo, CrontabMutator } from "./crontab.js";
import {
  AtEnqueueUnconfirmedError,
  DefaultOsScheduler,
  type ScheduledMessage,
} from "./os-scheduler.js";

vi.mock("node:child_process", () => {
  const mocked = { spawnSync: vi.fn(), execFileSync: vi.fn() };
  return { ...mocked, default: mocked };
});

interface InstrumentedQueue {
  io: AtIo;
  jobs: Map<string, string>;
  counts: {
    schedule: number;
    list: number;
    remove: number;
    readJob: number;
    listJobIds: number;
  };
  totalScriptReads: () => number;
}

function createInstrumentedQueue(
  initialJobs: Array<{ id: string; script: string }> = [],
  options: { withSingleJobSeam?: boolean } = { withSingleJobSeam: true }
): InstrumentedQueue {
  const jobs = new Map<string, string>();
  for (const job of initialJobs) {
    jobs.set(job.id, job.script);
  }

  const counts = {
    schedule: 0,
    list: 0,
    remove: 0,
    readJob: 0,
    listJobIds: 0,
  };

  let nextId = 1000;

  const baseIo: AtIo = {
    schedule: vi.fn((script: string) => {
      counts.schedule++;
      const id = String(nextId++);
      jobs.set(id, script);
      return id;
    }),
    list: vi.fn(() => {
      counts.list++;
      return Array.from(jobs.entries()).map(([id, script]) => ({ id, script }));
    }),
    remove: vi.fn((id: string) => {
      counts.remove++;
      jobs.delete(id);
    }),
  };

  const io: AtIo = options.withSingleJobSeam
    ? {
        ...baseIo,
        readJob: vi.fn((id: string) => {
          counts.readJob++;
          const script = jobs.get(id);
          return script !== undefined ? { id, script } : null;
        }),
        listJobIds: vi.fn(() => {
          counts.listJobIds++;
          return Array.from(jobs.keys());
        }),
      }
    : baseIo;

  return {
    io,
    jobs,
    counts,
    totalScriptReads: () => counts.list * jobs.size + counts.readJob,
  };
}

describe("MEK-Org/rusa#1274 bounded at-queue operations", () => {
  const crontabIo: CrontabIo = {
    read: () => "",
    write: () => {},
  };

  const createScheduler = (io: AtIo, instanceId = "test-instance", nowMs = 1757937600000) => {
    return new DefaultOsScheduler(new CrontabMutator(crontabIo), io, {
      tokenFile: "/tmp/token",
      portFile: "/tmp/port",
      instanceId,
      now: () => nowMs,
    });
  };

  const makeMessage = (id: string, deliverAt = "2026-09-16T12:00:00.000Z"): ScheduledMessage => ({
    id,
    toId: "recipient",
    fromId: "sender",
    body: `body-${id}`,
    deliverAt,
  });

  it("scheduling one wake does bounded script reads independent of queue size", () => {
    // 50 unrelated jobs sitting in the queue
    const unrelatedJobs = Array.from({ length: 50 }, (_, i) => ({
      id: `foreign-${i}`,
      script: `# foreign-tag-${i}\ncurl /wake\n`,
    }));

    const queue = createInstrumentedQueue(unrelatedJobs);
    const scheduler = createScheduler(queue.io);

    // Schedule one message wake
    scheduler.scheduleMessageDelivery(makeMessage("msg-1"));

    // Before #1274: staleAtIds calls list() (50 reads) and confirmAtEnqueue calls list() (51 reads) -> >100 script reads!
    // After #1274: confirm only reads msg-1's script (1 read) and staleAtIds does 0 full queue reads -> <= 2 script reads.
    expect(queue.totalScriptReads()).toBeLessThanOrEqual(2);
  });

  it("confirming an enqueue only reads the target job, not every job in the queue", () => {
    const unrelatedJobs = Array.from({ length: 50 }, (_, i) => ({
      id: `foreign-${i}`,
      script: `# foreign-tag-${i}\ncurl /wake\n`,
    }));

    const queue = createInstrumentedQueue(unrelatedJobs);
    const scheduler = createScheduler(queue.io);

    scheduler.scheduleMessageDelivery(makeMessage("msg-confirm"));

    // Script reads must NOT scale with the 50 foreign jobs
    expect(queue.counts.list).toBe(0);
    expect(queue.totalScriptReads()).toBeLessThanOrEqual(2);
  });

  it("cancelling a wake does not re-read unrelated jobs in the queue", () => {
    const unrelatedJobs = Array.from({ length: 50 }, (_, i) => ({
      id: `foreign-${i}`,
      script: `# foreign-tag-${i}\ncurl /wake\n`,
    }));

    const queue = createInstrumentedQueue(unrelatedJobs);
    const scheduler = createScheduler(queue.io);

    scheduler.scheduleMessageDelivery(makeMessage("msg-cancel"));
    const readsAfterSchedule = queue.totalScriptReads();

    // Cancel the wake
    scheduler.cancelMessageDelivery("msg-cancel");

    // Before #1274: cancel calls staleAtIds which calls list() over all 51 jobs.
    // After #1274: cancel answers from what the scheduler knows it wrote -> 0 script reads!
    const readsDuringCancel = queue.totalScriptReads() - readsAfterSchedule;
    expect(readsDuringCancel).toBe(0);
  });

  it("scheduling and cancelling obligation activation with at does bounded script reads", () => {
    const unrelatedJobs = Array.from({ length: 50 }, (_, i) => ({
      id: `foreign-${i}`,
      script: `# foreign-tag-${i}\ncurl /wake\n`,
    }));

    const queue = createInstrumentedQueue(unrelatedJobs);
    const scheduler = createScheduler(queue.io);

    scheduler.scheduleObligationActivation("ob-1", {
      kind: "at",
      date: new Date("2026-09-16T12:00:00.000Z"),
    });

    // Schedule activation reads 0 full lists
    expect(queue.counts.list).toBe(0);
    expect(queue.totalScriptReads()).toBe(0);

    // Cancel obligation activation
    scheduler.cancelObligationActivation("ob-1");
    expect(queue.counts.list).toBe(0);
    expect(queue.totalScriptReads()).toBe(0);
    expect(queue.counts.remove).toBe(1);
  });

  it("confirmAtEnqueue fails closed when the newly scheduled job is missing from queue before run minute", () => {
    const queue = createInstrumentedQueue();
    // Simulate schedule writing but job vanishing before confirm
    queue.io.schedule = vi.fn(() => "missing-job-id");

    const scheduler = createScheduler(
      queue.io,
      "test-instance",
      Date.parse("2026-09-15T12:00:00.000Z")
    );

    expect(() =>
      scheduler.scheduleMessageDelivery(makeMessage("msg-fail", "2026-09-16T12:00:00.000Z"))
    ).toThrow(AtEnqueueUnconfirmedError);

    // Verifies removal attempt on unconfirmed enqueue
    expect(queue.counts.remove).toBe(1);
  });

  it("confirmAtEnqueue tolerates missing job when job run minute has already begun", () => {
    const queue = createInstrumentedQueue();
    queue.io.schedule = vi.fn(() => "already-ran-id");

    // Current time is past deliverAt
    const deliverAt = "2026-09-15T12:00:00.000Z";
    const scheduler = createScheduler(
      queue.io,
      "test-instance",
      Date.parse("2026-09-15T12:01:00.000Z")
    );

    expect(() =>
      scheduler.scheduleMessageDelivery(makeMessage("msg-tolerated", deliverAt))
    ).not.toThrow();
  });

  it("confirmAtEnqueue fails closed when job is in queue but tag does not match", () => {
    const queue = createInstrumentedQueue();
    queue.io.schedule = vi.fn(() => {
      const id = "tampered-id";
      queue.jobs.set(id, "# wrong-tag\ncurl /wake\n");
      return id;
    });

    const scheduler = createScheduler(
      queue.io,
      "test-instance",
      Date.parse("2026-09-15T12:00:00.000Z")
    );

    expect(() =>
      scheduler.scheduleMessageDelivery(makeMessage("msg-bad-tag", "2026-09-16T12:00:00.000Z"))
    ).toThrow(AtEnqueueUnconfirmedError);
  });

  it("backward compatibility: falls back to list() when readJob is not implemented on AtIo", () => {
    const queue = createInstrumentedQueue([], { withSingleJobSeam: false });
    expect(queue.io.readJob).toBeUndefined();

    const scheduler = createScheduler(queue.io);
    scheduler.scheduleMessageDelivery(makeMessage("msg-fallback"));

    // Legacy list() path was used
    expect(queue.counts.list).toBeGreaterThan(0);
  });
});

describe("execAtIo and unavailableAtIo unit behavior", () => {
  const mockedSpawnSync = vi.mocked(spawnSync);

  const makeResult = (overrides: Partial<ReturnType<typeof spawnSync>>) =>
    ({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
      ...overrides,
    }) as ReturnType<typeof spawnSync>;

  it("execAtIo listJobIds parses job ids from atq output", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({
        stdout: "42\tWed Sep  2 04:30:00 2026 a user\n43\tWed Sep  2 04:35:00 2026 a user\n",
      })
    );

    const io = execAtIo();
    expect(io.listJobIds?.()).toEqual(["42", "43"]);
  });

  it("execAtIo readJob returns script when job exists", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({ status: 0, stdout: "# test script\ncurl /wake\n" })
    );

    const io = execAtIo();
    expect(io.readJob?.("42")).toEqual({
      id: "42",
      script: "# test script\ncurl /wake\n",
    });
  });

  it("execAtIo readJob returns null when job is already gone", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({ status: 1, stderr: "at: cannot find jobid 42\n" })
    );

    const io = execAtIo();
    expect(io.readJob?.("42")).toBeNull();
  });

  it("execAtIo readJob throws on unexpected error", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({ status: 1, stderr: "unexpected permission denied\n" })
    );

    const io = execAtIo();
    expect(() => io.readJob?.("42")).toThrow(/at -c 42 failed/);
  });

  it("unavailableAtIo provides no-op readJob and listJobIds", () => {
    const unavailable = unavailableAtIo(["preflight failed"]);
    expect(unavailable.readJob?.("any")).toBeNull();
    expect(unavailable.listJobIds?.()).toEqual([]);
  });
});
