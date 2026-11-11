// Reproduction and verification for MEK-Org/rusa#1274.
//
// Scheduling a wake re-reads the whole `at` queue with one synchronous process
// spawn per queued job, blocking the event loop.
//
// Scheduling, confirming, looking up or removing one wake must do a bounded
// amount of blocking work that does not grow with the number of unrelated jobs
// in the queue. After the one full read a process makes at start-up, a send
// spawns K+2 processes for K messages this instance knows it has pending, and
// a cancel spawns three.

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
  counts: { schedule: number; list: number; remove: number; readJob: number };
  /**
   * Host processes spawned so far, priced as {@link execAtIo} spends them: one
   * `at`, `atrm` or `at -c` per call, and `atq` plus one `at -c` per queued
   * job for a full list.
   */
  spawns: () => number;
  reset: () => void;
}

function createInstrumentedQueue(
  initialJobs: Array<{ id: string; script: string }> = []
): InstrumentedQueue {
  const jobs = new Map<string, string>();
  for (const job of initialJobs) {
    jobs.set(job.id, job.script);
  }
  const counts = { schedule: 0, list: 0, remove: 0, readJob: 0 };
  let listSpawns = 0;
  let nextId = 1000;

  const io: AtIo = {
    schedule: vi.fn((script: string) => {
      counts.schedule++;
      const id = String(nextId++);
      jobs.set(id, script);
      return id;
    }),
    list: vi.fn(() => {
      counts.list++;
      listSpawns += 1 + jobs.size;
      return Array.from(jobs.entries()).map(([id, script]) => ({ id, script }));
    }),
    readJob: vi.fn((id: string) => {
      counts.readJob++;
      const script = jobs.get(id);
      return script !== undefined ? { id, script } : null;
    }),
    remove: vi.fn((id: string) => {
      counts.remove++;
      jobs.delete(id);
    }),
  };

  return {
    io,
    jobs,
    counts,
    spawns: () => counts.schedule + counts.remove + counts.readJob + listSpawns,
    reset: () => {
      counts.schedule = 0;
      counts.list = 0;
      counts.remove = 0;
      counts.readJob = 0;
      listSpawns = 0;
    },
  };
}

const b64 = (value: string) => Buffer.from(value).toString("base64url");

/** Message jobs another instance on the host queued: never read, never touched. */
const foreignJobs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `foreign-${i}`,
    script: `# mc-message-delivery-instance:v1:${b64("other-instance")}:${b64(`foreign-${i}`)}\ncurl /wake-message\n`,
  }));

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

  const makeMessage = (
    id: string,
    deliverAt = "2026-09-16T12:00:00.000Z",
    toId = "recipient"
  ): ScheduledMessage => ({
    id,
    toId,
    fromId: "sender",
    body: `body-${id}`,
    deliverAt,
  });

  const activationAt = { kind: "at" as const, date: new Date("2026-09-16T12:00:00.000Z") };

  /**
   * A booted scheduler over 50 foreign jobs plus `activations` of its own
   * activations and `messages` of its own messages. Boot's full reads have
   * run, so the counts start at zero with the known-job record seeded.
   */
  const booted = (activations: number, messages: number) => {
    const queue = createInstrumentedQueue(foreignJobs(50));
    const scheduler = createScheduler(queue.io);
    for (let i = 0; i < activations; i++) {
      scheduler.scheduleObligationActivation(`ob-${i}`, activationAt);
    }
    for (let i = 0; i < messages; i++) {
      scheduler.scheduleMessageDelivery(makeMessage(`own-${i}`, undefined, `recipient-${i}`));
    }
    // Start-up's reconciliations each make one full read.
    scheduler.listMessageDeliveries();
    scheduler.listObligationActivations();
    queue.reset();
    return { queue, scheduler };
  };

  it("a send's cap read and write spawn K+2 processes for K known own messages, whatever the queue holds", () => {
    for (const activations of [0, 40]) {
      const { queue, scheduler } = booted(activations, 3);

      // The mesh's send: its cap read, then the write.
      expect(scheduler.listKnownMessageDeliveries().map((message) => message.id)).toEqual([
        "own-0",
        "own-1",
        "own-2",
      ]);
      scheduler.scheduleMessageDelivery(makeMessage("msg-new"));

      // 3 cap reads + 0 stale reads for a fresh id + 1 `at` + 1 confirming `at -c`.
      expect(queue.counts.list).toBe(0);
      expect(queue.spawns()).toBe(3 + 2);
    }
  });

  it("a cancel's lookup and removal spawn three processes, whatever the queue holds", () => {
    const { queue, scheduler } = booted(40, 3);

    expect(scheduler.readMessageDelivery("own-1")).toMatchObject({ id: "own-1" });
    scheduler.cancelMessageDelivery("own-1");

    // One `at -c` to look it up, one to re-verify before removal, one `atrm`.
    expect(queue.counts.list).toBe(0);
    expect(queue.spawns()).toBe(3);
    expect(queue.counts.remove).toBe(1);
    expect(scheduler.readMessageDelivery("own-1")).toBeNull();
  });

  it("an unknown message id is looked up with no host process at all", () => {
    const { queue, scheduler } = booted(10, 3);

    expect(scheduler.readMessageDelivery("never-sent")).toBeNull();
    expect(queue.spawns()).toBe(0);
  });

  it("scheduling and cancelling an at activation spawns only its own processes", () => {
    const { queue, scheduler } = booted(40, 3);

    scheduler.scheduleObligationActivation("ob-new", activationAt);
    expect(queue.counts.list).toBe(0);
    expect(queue.spawns()).toBe(1);

    scheduler.cancelObligationActivation("ob-new");
    expect(queue.counts.list).toBe(0);
    // One `at -c` to verify the job still carries its tag, one `atrm`.
    expect(queue.spawns()).toBe(1 + 2);
    expect(queue.counts.remove).toBe(1);
  });

  it("a restarted process replaces and cancels the jobs its previous process queued", () => {
    // Before this fix, a new process knew only jobs it wrote itself, and boot
    // replays activations before reading them, so each restart duplicated
    // every at activation and orphaned the old job.
    const queue = createInstrumentedQueue(foreignJobs(5));
    const before = createScheduler(queue.io);
    before.scheduleObligationActivation("ob-1", activationAt);
    before.scheduleMessageDelivery(makeMessage("msg-1"));
    const ownJobs = () =>
      [...queue.jobs.entries()].filter(([id]) => !id.startsWith("foreign-")).map(([id]) => id);
    expect(ownJobs()).toHaveLength(2);

    const after = createScheduler(queue.io);
    after.scheduleObligationActivation("ob-1", activationAt);
    expect(ownJobs()).toHaveLength(2);

    after.cancelObligationActivation("ob-1");
    after.cancelMessageDelivery("msg-1");
    expect(ownJobs()).toEqual([]);
    expect(queue.jobs.size).toBe(5);
  });

  it("forgets, and never removes, a known id that now holds another job", () => {
    const { queue, scheduler } = booted(0, 1);
    const [ownId] = [...queue.jobs.keys()].filter((id) => !id.startsWith("foreign-"));
    // The job ran, and `at` handed its id to an unrelated job.
    queue.jobs.set(ownId, "# someone else's job\ncurl /elsewhere\n");

    scheduler.cancelMessageDelivery("own-0");
    expect(scheduler.listKnownMessageDeliveries()).toEqual([]);

    expect(queue.counts.remove).toBe(0);
    expect(queue.jobs.get(ownId)).toBe("# someone else's job\ncurl /elsewhere\n");
    // Forgotten after one read: the second lookup spawns nothing.
    expect(queue.counts.readJob).toBe(1);
  });

  it("drops a job that has fired from the known record after one read", () => {
    const { queue, scheduler } = booted(0, 2);
    const [firstId] = [...queue.jobs.keys()].filter((id) => !id.startsWith("foreign-"));
    queue.jobs.delete(firstId);

    expect(scheduler.listKnownMessageDeliveries().map((message) => message.id)).toEqual(["own-1"]);
    queue.reset();
    scheduler.listKnownMessageDeliveries();
    expect(queue.spawns()).toBe(1);
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
    expect(scheduler.readMessageDelivery("msg-fail")).toBeNull();
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
    // Nothing is left under that id, so it is not carried as known.
    queue.reset();
    expect(scheduler.listKnownMessageDeliveries()).toEqual([]);
    expect(queue.spawns()).toBe(0);
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

  it("execAtIo readJob returns script when job exists", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({ status: 0, stdout: "# test script\ncurl /wake\n" })
    );

    const io = execAtIo();
    expect(io.readJob("42")).toEqual({
      id: "42",
      script: "# test script\ncurl /wake\n",
    });
  });

  it("execAtIo readJob returns null when job is already gone", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({ status: 1, stderr: "at: cannot find jobid 42\n" })
    );

    const io = execAtIo();
    expect(io.readJob("42")).toBeNull();
  });

  it("execAtIo readJob throws on unexpected error", () => {
    mockedSpawnSync.mockReturnValueOnce(
      makeResult({ status: 1, stderr: "unexpected permission denied\n" })
    );

    const io = execAtIo();
    expect(() => io.readJob("42")).toThrow(/at -c 42 failed/);
  });

  it("unavailableAtIo reads no job", () => {
    const unavailable = unavailableAtIo(["preflight failed"]);
    expect(unavailable.readJob("any")).toBeNull();
  });
});
