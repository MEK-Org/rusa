// Reproduction and verification for MEK-Org/rusa#1274.
//
// Scheduling a wake re-reads the whole `at` queue with one synchronous process
// spawn per queued job, blocking the event loop.
//
// Scheduling, confirming or removing one wake must do a bounded amount of
// blocking work that does not grow with the number of unrelated jobs in the queue.

import { describe, expect, it, vi } from "vitest";
import type { AtIo } from "./at-queue.js";
import { type CrontabIo, CrontabMutator } from "./crontab.js";
import { DefaultOsScheduler, type ScheduledMessage } from "./os-scheduler.js";

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
  initialJobs: Array<{ id: string; script: string }> = []
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

  const io: AtIo = {
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

  const createScheduler = (io: AtIo, instanceId = "test-instance") => {
    return new DefaultOsScheduler(new CrontabMutator(crontabIo), io, {
      tokenFile: "/tmp/token",
      portFile: "/tmp/port",
      instanceId,
      now: () => Date.parse("2026-09-15T12:00:00.000Z"),
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
});
