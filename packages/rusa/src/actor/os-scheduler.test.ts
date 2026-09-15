import { execFileSync, spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../observability/logger.js";
import {
  type AtIo,
  type AtProbe,
  AtUnavailableError,
  execAtIo,
  preflightAt,
  unavailableAtIo,
} from "./at-queue.js";
import { type CrontabIo, CrontabMutator } from "./crontab.js";
import {
  AtEnqueueUnconfirmedError,
  DefaultOsScheduler,
  decodeScheduledMessagePayload,
  encodeScheduledMessagePayload,
  TruncatedCronBlockError,
} from "./os-scheduler.js";

vi.mock("node:child_process", () => {
  const mocked = { spawnSync: vi.fn(), execFileSync: vi.fn() };
  return { ...mocked, default: mocked };
});

describe("DefaultOsScheduler", () => {
  let cron: CrontabIo;
  let at: AtIo;
  let scheduler: DefaultOsScheduler;
  let cronData: string;

  beforeEach(() => {
    cronData = "";
    cron = {
      read: () => cronData,
      write: (data) => {
        cronData = data;
      },
    };

    // A queue that holds what was scheduled: a message write is confirmed by
    // re-reading the queue, so a fake that always lists nothing cannot accept one.
    const jobs: { id: string; script: string }[] = [];
    at = {
      schedule: vi.fn((script: string) => {
        jobs.push({ id: "123", script });
        return "123";
      }),
      list: vi.fn(() => jobs.map((job) => ({ ...job }))),
      remove: vi.fn(),
    };

    scheduler = new DefaultOsScheduler(new CrontabMutator(cron), at, {
      tokenFile: "/token",
      portFile: "/port",
      instanceId: "test-instance",
    });
  });

  it("schedules a cron activation", () => {
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    expect(cronData).toContain("# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ");
    expect(cronData).toContain("*/5 * * * *");
    expect(cronData).toContain("/wake-obligation");

    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).not.toContain(
      "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
  });

  it("schedules an at activation", () => {
    scheduler.scheduleObligationActivation("ob-2", { kind: "at", date: new Date() });
    expect(at.schedule).toHaveBeenCalled();
  });

  it("round-trips a complete scheduled message through the at job", () => {
    const message = {
      id: "message-1",
      toId: "recipient",
      fromId: "sender",
      body: "quotes: ' & form=data\nsecond line",
      deliverAt: "2026-09-04T12:34:56.000Z",
      sessionId: "session-1",
    };

    scheduler.scheduleMessageDelivery(message);

    const [script, date] = vi.mocked(at.schedule).mock.calls[0];
    expect(date).toEqual(new Date(message.deliverAt));
    expect(script).toContain("# mc-message-delivery-instance:v1:dGVzdC1pbnN0YW5jZQ:");
    expect(script).toContain("/wake-message");
    expect(script).toContain('while [ "$rusa_attempt" -lt 120 ]');
    expect(script).toContain("rusa_callback_port=$(cat /port");
    expect(script).not.toContain(message.body);

    vi.mocked(at.list).mockReturnValue([{ id: "123", script }]);
    expect(scheduler.listMessageDeliveries()).toEqual([message]);
  });

  it("uses the versioned callback payload as the public encode/decode contract", () => {
    const message = {
      id: "message-2",
      toId: "recipient",
      fromId: "sender",
      body: "hello",
      deliverAt: "2026-09-04T12:34:56.000Z",
    };
    expect(decodeScheduledMessagePayload(encodeScheduledMessagePayload(message))).toEqual(message);
    expect(() =>
      decodeScheduledMessagePayload(
        Buffer.from(JSON.stringify({ schemaVersion: 2, ...message })).toString("base64url")
      )
    ).toThrow(/invalid scheduled-message payload/);
  });

  it("fails visibly when an owned host job has a missing or corrupt payload", () => {
    vi.mocked(at.list).mockReturnValue([
      {
        id: "broken",
        script:
          "# mc-message-delivery-instance:v1:dGVzdC1pbnN0YW5jZQ:YnJva2Vu\ncurl /wake-message -d 'id=old'\n",
      },
    ]);
    expect(() => scheduler.listMessageDeliveries()).toThrow(
      /Invalid scheduled-message host job broken/
    );
  });

  it("matches message tags by exact line when replacing jobs", () => {
    scheduler.scheduleMessageDelivery({
      id: "a",
      toId: "recipient",
      fromId: "sender",
      body: "first",
      deliverAt: "2026-09-04T12:34:56.000Z",
    });
    const [firstScript] = vi.mocked(at.schedule).mock.calls[0];
    scheduler.scheduleMessageDelivery({
      id: "aa",
      toId: "recipient",
      fromId: "sender",
      body: "second",
      deliverAt: "2026-09-04T12:35:56.000Z",
    });
    const [secondScript] = vi.mocked(at.schedule).mock.calls[1];
    vi.mocked(at.list).mockReturnValue([
      { id: "first", script: firstScript },
      { id: "second", script: secondScript },
    ]);

    scheduler.cancelMessageDelivery("a");

    expect(at.remove).toHaveBeenCalledWith("first");
    expect(at.remove).not.toHaveBeenCalledWith("second");
  });

  it("rejects invalid dates and message bodies too large for a host job", () => {
    expect(() =>
      scheduler.scheduleMessageDelivery({
        id: "bad-date",
        toId: "recipient",
        fromId: "sender",
        body: "hello",
        deliverAt: "not-a-date",
      })
    ).toThrow(/invalid scheduled-message payload/);
    expect(() =>
      scheduler.scheduleMessageDelivery({
        id: "too-large",
        toId: "recipient",
        fromId: "sender",
        body: "x".repeat(128 * 1024 + 1),
        deliverAt: "2026-09-04T12:34:56.000Z",
      })
    ).toThrow(/128 KiB/);
  });

  it("strips cron blocks without disturbing adjacent user jobs", () => {
    cronData =
      '1 * * * * user-job-1\n# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\nCRON_TZ=UTC\n*/5 * * * * curl wake-obligation\nCRON_TZ=""\n# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\n2 * * * * user-job-2\n';
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).toBe("1 * * * * user-job-1\n2 * * * * user-job-2\n");
  });

  it("does not delete an adjacent unmanaged job whose command merely mentions wake-obligation/wake-message", () => {
    cronData =
      '1 * * * * user-job-1\n# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\nCRON_TZ=UTC\n*/5 * * * * curl wake-obligation\nCRON_TZ=""\n# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\n3 * * * * /usr/bin/wake-message-backup --dry-run\n2 * * * * user-job-2\n';
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).toBe(
      "1 * * * * user-job-1\n3 * * * * /usr/bin/wake-message-backup --dry-run\n2 * * * * user-job-2\n"
    );
  });

  it("does not delete an adjacent unmanaged CRON_TZ= line beyond the block's own restore line", () => {
    cronData =
      "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\nCRON_TZ=UTC\n*/5 * * * * curl wake-obligation\nCRON_TZ=\n# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\nCRON_TZ=Europe/Paris\n4 * * * * user-job\n";
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).toBe("CRON_TZ=Europe/Paris\n4 * * * * user-job\n");
  });

  it('restores CRON_TZ="" (not bare CRON_TZ=) when no prior CRON_TZ was in effect', () => {
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    const lines = cronData.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(
      "# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
    expect(lines[lines.length - 2]).toBe('CRON_TZ=""');
  });

  it("restores the exact prior CRON_TZ line rather than blindly clearing it", () => {
    cronData = "CRON_TZ=America/New_York\n1 * * * * user-job\n";
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    const lines = cronData.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(
      "# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
    expect(lines[lines.length - 2]).toBe("CRON_TZ=America/New_York");
    expect(cronData).toContain("1 * * * * user-job");
  });

  it("re-scheduling replaces the block once and still restores the original prior CRON_TZ", () => {
    cronData = "CRON_TZ=America/New_York\n1 * * * * user-job\n";
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "0 6 * * *" });
    const lines = cronData.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(
      "# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
    expect(lines[lines.length - 2]).toBe("CRON_TZ=America/New_York");
    expect(cronData).toContain("1 * * * * user-job");
    expect(
      cronData.match(/# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ/g)
    ).toHaveLength(1);
    expect(
      cronData.match(/# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ/g)
    ).toHaveLength(1);
    expect(cronData).toContain("0 6 * * *");
    expect(cronData).not.toContain("*/5 * * * *");
  });

  it("cancelling a truncated/damaged block (no end marker) fails closed with no write, leaving every line untouched", () => {
    // A block with no end marker — hand-edited or truncated — cannot be
    // proven to still have the shape this class wrote, so this must never
    // guess which adjacent line belongs to it: fail with a named error and
    // perform no write at all, rather than dropping just the orphaned tag.
    const original =
      "1 * * * * user-job-1\n# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\n2 * * * * user-job-2\n";
    cronData = original;
    expect(() => scheduler.cancelObligationActivation("ob-1")).toThrow(TruncatedCronBlockError);
    expect(cronData).toBe(original);
  });

  it("scheduling over a truncated/damaged block fails closed with no write rather than guessing the boundary", () => {
    const original =
      "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\n5 * * * * user-job\n";
    cronData = original;
    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" })
    ).toThrow(TruncatedCronBlockError);
    expect(cronData).toBe(original);
  });

  it("switching a truncated cron block to an at-kind (interval) activation also fails closed with no write", () => {
    const original =
      "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\n5 * * * * user-job\n";
    cronData = original;
    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "at", date: new Date() })
    ).toThrow(TruncatedCronBlockError);
    expect(cronData).toBe(original);
    expect(at.schedule).not.toHaveBeenCalled();
  });

  it("keeps the existing cron block when installing its at replacement fails", () => {
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    const original = cronData;
    vi.mocked(at.schedule).mockImplementation(() => {
      throw new Error("at unavailable");
    });

    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "at", date: new Date() })
    ).toThrow("at unavailable");
    expect(cronData).toBe(original);
  });

  it("installs the replacement cron block before stale at cleanup, retaining it on cleanup failure", () => {
    vi.mocked(at.list).mockReturnValue([
      {
        id: "old-at",
        script: "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\nold",
      },
    ]);
    vi.mocked(at.remove).mockImplementation(() => {
      throw new Error("atrm failed");
    });

    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" })
    ).toThrow("atrm failed");
    expect(cronData).toContain("# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ");
  });

  it("installs a replacement at job before removing stale at jobs", () => {
    const calls: string[] = [];
    const jobs = [
      {
        id: "old-at",
        script: "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ\nold",
      },
    ];
    vi.mocked(at.list).mockReturnValue(jobs);
    vi.mocked(at.schedule).mockImplementation(() => {
      calls.push("schedule");
      return "new-at";
    });
    vi.mocked(at.remove).mockImplementation((id) => {
      calls.push(`remove:${id}`);
    });

    scheduler.scheduleObligationActivation("ob-1", { kind: "at", date: new Date() });
    expect(calls).toEqual(["schedule", "remove:old-at"]);
    expect(at.remove).toHaveBeenCalledWith("old-at");
  });
});

describe("one OS scheduler for actor wakes and obligations", () => {
  it("consolidates both writers behind one instance so an interleaved wake-schedule mutation and a recurrence mutation cannot lose either entry, and every foreign byte survives", async () => {
    // Seed a crontab with a foreign (unrelated feature) `# mc-wake:` block
    // and arbitrary untagged user lines, exactly as the addendum requires.
    let cronData =
      "0 2 * * * /usr/bin/backup.sh\n" +
      "# mc-wake:other-actor\n" +
      "0 3 * * * curl -fsS http://127.0.0.1:1/wake -d actorId=other-actor -d reason=nightly\n" +
      "* * * * * /usr/bin/heartbeat\n";
    const foreignLines = cronData.trim().split("\n");
    const cron: CrontabIo = {
      read: () => cronData,
      write: (data) => {
        cronData = data;
      },
    };
    const at: AtIo = {
      schedule: vi.fn().mockReturnValue("1"),
      list: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
    };

    // One scheduler owns the sole mutator and both public scheduling slices.
    const mutator = new CrontabMutator(cron);
    const scheduler = new DefaultOsScheduler(mutator, at, {
      tokenFile: "/token",
      portFile: "/port",
      instanceId: "test-instance",
    });

    // Order A: the recurrence (obligation) mutation lands first, then the
    // unrelated wake-schedule mutation. Both are synchronous end-to-end (the
    // underlying crontab IO blocks the event loop), so this is the only
    // interleaving order this single-threaded process can actually produce —
    // proving it doesn't lose either entry is the real regression coverage.
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    await scheduler.schedule("actor-a", "0 4 * * *", "daily digest");

    expect(cronData).toContain("# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ");
    expect(cronData).toContain(
      "# mc-obligation-activation-instance-end:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
    expect(cronData).toContain("# mc-wake-instance:v1:dGVzdC1pbnN0YW5jZQ:YWN0b3ItYQ");
    // Every foreign line — the unrelated backup job, the foreign mc-wake
    // block, and the heartbeat job — is preserved byte-for-byte.
    for (const line of foreignLines) {
      expect(cronData).toContain(line);
    }

    // Order B: cancel the recurrence, then cancel the unrelated wake — each
    // removes only its own block, leaving the other writer's entry and all
    // foreign content intact until it too is cancelled.
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).not.toContain(
      "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
    expect(cronData).toContain("# mc-wake-instance:v1:dGVzdC1pbnN0YW5jZQ:YWN0b3ItYQ");

    await scheduler.cancel("actor-a");
    expect(cronData).not.toContain("# mc-wake-instance:v1:dGVzdC1pbnN0YW5jZQ:YWN0b3ItYQ");
    for (const line of foreignLines) {
      expect(cronData).toContain(line);
    }
  });
});

describe("execAtIo", () => {
  const mockedSpawnSync = vi.mocked(spawnSync);

  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  const result = (overrides: Partial<ReturnType<typeof spawnSync>>) =>
    ({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
      ...overrides,
    }) as ReturnType<typeof spawnSync>;

  it("schedules with a seconds-precision -t timestamp", () => {
    mockedSpawnSync.mockReturnValue(result({ stderr: "job 42 at Wed Sep  2 04:30:45 2026\n" }));
    const id = execAtIo().schedule("script", new Date("2026-09-02T04:30:45.000Z"));
    expect(id).toBe("42");
    const [cmd, args] = mockedSpawnSync.mock.calls[0];
    expect(cmd).toBe("at");
    expect(args).toEqual(["-t", "202609020430.45"]);
  });

  it("schedule() throws when `at` fails", () => {
    mockedSpawnSync.mockReturnValue(result({ status: 1, stderr: "boom" }));
    expect(() => execAtIo().schedule("script", new Date())).toThrow(/at failed/);
  });

  it("list() throws when the `at` CLI is missing entirely, rather than reading as an empty queue", () => {
    mockedSpawnSync.mockReturnValue(
      result({
        status: null,
        error: Object.assign(new Error("spawn atq ENOENT"), { code: "ENOENT" }),
      })
    );
    // A missing `atq` binary is a deployment problem, not "nothing scheduled" —
    // reading it as empty would let boot reconciliation treat every still-pending
    // OS job as an orphan and cancel it out from under live obligations/messages.
    expect(() => execAtIo().list()).toThrow(/ENOENT/);
  });

  it("list() throws when atq itself fails, rather than reading as an empty queue", () => {
    mockedSpawnSync.mockReturnValue(result({ status: 1, stderr: "atd not running" }));
    expect(() => execAtIo().list()).toThrow(/atq failed/);
  });

  it("list() drops a job that fired between atq and `at -c` as gone, not an error", () => {
    mockedSpawnSync
      .mockReturnValueOnce(result({ stdout: "5\tWed Sep  2 04:30:00 2026 a user\n" }))
      .mockReturnValueOnce(result({ status: 1, stderr: "at: cannot find jobid 5\n" }));
    expect(execAtIo().list()).toEqual([]);
  });

  it("list() surfaces a real `at -c` IO failure instead of swallowing it", () => {
    mockedSpawnSync
      .mockReturnValueOnce(result({ stdout: "5\tWed Sep  2 04:30:00 2026 a user\n" }))
      .mockReturnValueOnce(result({ status: 1, stderr: "permission denied\n" }));
    expect(() => execAtIo().list()).toThrow(/at -c 5 failed/);
  });

  it("remove() is idempotent when the job already fired or was already removed", () => {
    mockedSpawnSync.mockReturnValue(result({ status: 1, stderr: "atrm: cannot find jobid 5\n" }));
    expect(() => execAtIo().remove("5")).not.toThrow();
  });

  it("remove() surfaces a real atrm IO failure", () => {
    mockedSpawnSync.mockReturnValue(result({ status: 1, stderr: "permission denied\n" }));
    expect(() => execAtIo().remove("5")).toThrow(/atrm 5 failed/);
  });
});

describe("unavailableAtIo", () => {
  it("list() reports no jobs instead of ever calling a confirmed-missing binary", () => {
    expect(unavailableAtIo(["`at` CLI not found — install at"]).list()).toEqual([]);
  });

  it("schedule() raises the named prerequisite error instead of a raw spawnSync ENOENT", () => {
    const io = unavailableAtIo(["`at` CLI not found — install at"]);
    expect(() => io.schedule("script", new Date())).toThrow(AtUnavailableError);
    expect(() => io.schedule("script", new Date())).toThrow(/at` CLI not found/);
  });

  it("remove() also raises the named prerequisite error", () => {
    const io = unavailableAtIo(["atd daemon not detected"]);
    expect(() => io.remove("5")).toThrow(AtUnavailableError);
  });
});

describe("DefaultOsScheduler with an unavailable `at` facility", () => {
  it("keeps cron scheduling working — a pure cron activation never touches `at`", () => {
    let cronData = "";
    const cron: CrontabIo = {
      read: () => cronData,
      write: (data) => {
        cronData = data;
      },
    };
    const scheduler = new DefaultOsScheduler(
      new CrontabMutator(cron),
      unavailableAtIo(["at missing"]),
      {
        tokenFile: "/token",
        portFile: "/port",
        instanceId: "test-instance",
      }
    );

    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" })
    ).not.toThrow();
    expect(cronData).toContain("# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ");

    expect(() => scheduler.cancelObligationActivation("ob-1")).not.toThrow();
    expect(cronData).not.toContain(
      "# mc-obligation-activation-instance:v1:dGVzdC1pbnN0YW5jZQ:b2ItMQ"
    );
  });

  it("fails a completion-interval (at-kind) activation with the named prerequisite error", () => {
    const cron: CrontabIo = { read: () => "", write: () => {} };
    const scheduler = new DefaultOsScheduler(
      new CrontabMutator(cron),
      unavailableAtIo(["at missing"]),
      {
        tokenFile: "/token",
        portFile: "/port",
        instanceId: "test-instance",
      }
    );

    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "at", date: new Date() })
    ).toThrow(AtUnavailableError);
  });
});

describe("preflightAt", () => {
  const okProbe: AtProbe = {
    hasAt: () => true,
    hasAtrm: () => true,
    isAtdRunning: () => true,
    canQueryAtq: () => true,
  };

  it("passes when at/atrm/atd/atq are all present and queryable", () => {
    expect(preflightAt(okProbe)).toEqual({ ok: true, issues: [] });
  });

  it("fails when `at` itself is missing", () => {
    const result = preflightAt({ ...okProbe, hasAt: () => false, canQueryAtq: () => false });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/`at` CLI not found/);
  });

  it("fails when `atrm` is missing even though `at`/atq/atd are fine", () => {
    const result = preflightAt({ ...okProbe, hasAtrm: () => false });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/`atrm` CLI not found/);
  });

  it("fails when atd isn't running", () => {
    const result = preflightAt({ ...okProbe, isAtdRunning: () => false });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/atd daemon not detected/);
  });

  it("fails when `at` is present but `atq` can't actually be queried — the exact host shape that reached raw spawnSync ENOENT in production", () => {
    const result = preflightAt({ ...okProbe, canQueryAtq: () => false });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/`atq` cannot be queried/);
  });

  describe("with the default (host-probing) probe", () => {
    const mockedExecFileSync = vi.mocked(execFileSync);
    const mockedSpawnSync = vi.mocked(spawnSync);

    beforeEach(() => {
      mockedExecFileSync.mockReset();
      mockedSpawnSync.mockReset();
    });

    const spawnResult = (overrides: Partial<ReturnType<typeof spawnSync>>) =>
      ({
        pid: 1,
        output: [],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
        ...overrides,
      }) as ReturnType<typeof spawnSync>;

    it("reports ok when which/pgrep succeed and a live atq call succeeds", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      mockedSpawnSync.mockReturnValue(spawnResult({ stdout: "" }));
      expect(preflightAt()).toEqual({ ok: true, issues: [] });
    });

    it("surfaces a missing `atq` binary (ENOENT from a live query) as unusable, not ok", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      mockedSpawnSync.mockReturnValue(
        spawnResult({
          status: null,
          error: Object.assign(new Error("spawn atq ENOENT"), { code: "ENOENT" }),
        })
      );
      const result = preflightAt();
      expect(result.ok).toBe(false);
      expect(result.issues.join(" ")).toMatch(/`atq` cannot be queried/);
    });

    it("surfaces `atrm` missing from PATH even when `at`/atq/atd are otherwise fine", () => {
      mockedExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "atrm") throw new Error("not found");
        return Buffer.from("");
      });
      mockedSpawnSync.mockReturnValue(spawnResult({ stdout: "" }));
      const result = preflightAt();
      expect(result.ok).toBe(false);
      expect(result.issues.join(" ")).toMatch(/`atrm` CLI not found/);
    });
  });
});

describe("DefaultOsScheduler instance-scoped obligation activations (#304)", () => {
  it("parses instanceId and id from crontab and at jobs, recognizing legacy unscoped tags as having no instance", () => {
    let cronData =
      "0 1 * * * /usr/bin/user-job\n" +
      "# mc-wake:act-1\n" +
      "0 2 * * * curl /wake\n" +
      "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:b2ItcHJvZC0x\n" +
      "CRON_TZ=UTC\n" +
      "45 8 * * * curl /wake-obligation -d 'id=ob-prod-1'\n" +
      'CRON_TZ=""\n' +
      "# mc-obligation-activation-instance-end:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:b2ItcHJvZC0x\n" +
      "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2Etc3RhZ2luZw:b2Itc3RhZ2luZy0x\n" +
      "CRON_TZ=UTC\n" +
      "0 12 * * * curl /wake-obligation -d 'id=ob-staging-1'\n" +
      'CRON_TZ=""\n' +
      "# mc-obligation-activation-instance-end:v1:L2hvbWUvc2YvLnJ1c2Etc3RhZ2luZw:b2Itc3RhZ2luZy0x\n" +
      "# mc-obligation-activation:legacy-ob-1\n" +
      "CRON_TZ=UTC\n" +
      "30 3 * * * curl /wake-obligation -d 'id=legacy-ob-1'\n" +
      'CRON_TZ=""\n' +
      "# mc-obligation-activation-end:legacy-ob-1\n";

    const cron: CrontabIo = {
      read: () => cronData,
      write: (data) => {
        cronData = data;
      },
    };

    const atJobs = [
      {
        id: "1",
        script:
          "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:YXQtcHJvZC0x\ncurl /wake-obligation\n",
      },
      { id: "2", script: "# mc-obligation-activation:legacy-at-1\ncurl /wake-obligation\n" },
      { id: "3", script: "# mc-message-delivery:msg-1\ncurl /wake-message\n" },
    ];

    const at: AtIo = {
      schedule: vi.fn(),
      list: vi.fn().mockReturnValue(atJobs),
      remove: vi.fn(),
    };

    const scheduler = new DefaultOsScheduler(new CrontabMutator(cron), at, {
      tokenFile: "/token",
      portFile: "/port",
      instanceId: "/home/sf/.rusa-prod",
    });

    const activations = scheduler.listObligationActivations();
    expect(activations).toEqual(
      expect.arrayContaining([
        { id: "ob-prod-1", instanceId: "/home/sf/.rusa-prod" },
        { id: "ob-staging-1", instanceId: "/home/sf/.rusa-staging" },
        { id: "legacy-ob-1" },
        { id: "at-prod-1", instanceId: "/home/sf/.rusa-prod" },
        { id: "legacy-at-1" },
      ])
    );
    expect(activations).toHaveLength(5);
  });

  it("round-trips delimiter-bearing ids without adopting legacy tags", () => {
    const instanceId = "/srv/rusa-prod";
    const id = "a:b";
    const atId = "at:a:b";
    const legacyTag = "# mc-obligation-activation:a:b";
    let cronData = `${legacyTag}\n0 1 * * * legacy-command\n`;
    const cron: CrontabIo = {
      read: () => cronData,
      write: (data) => {
        cronData = data;
      },
    };
    const at: AtIo = {
      schedule: vi.fn(),
      // The host-facing list can contain a wrapper/preamble before our exact
      // tag. Listing scans every line but accepts only the versioned format.
      list: vi.fn(() => [
        {
          id: "wrapped-at",
          script:
            "# at wrapper\n# mc-obligation-activation-instance:v1:L3Nydi9ydXNhLXByb2Q:YXQ6YTpi\ncurl /wake-obligation\n",
        },
      ]),
      remove: vi.fn(),
    };
    const scheduler = new DefaultOsScheduler(new CrontabMutator(cron), at, {
      tokenFile: "/token",
      portFile: "/port",
      instanceId,
    });

    scheduler.scheduleObligationActivation(id, { kind: "cron", cronExpr: "0 2 * * *" });

    expect(scheduler.listObligationActivations()).toEqual(
      expect.arrayContaining([{ id, instanceId }, { id: atId, instanceId }, { id }])
    );
    expect(cronData).toContain("# mc-obligation-activation-instance:v1:L3Nydi9ydXNhLXByb2Q:YTpi");

    scheduler.cancelObligationActivation(id);
    expect(cronData).toContain(legacyTag);
    expect(cronData).not.toContain(
      "# mc-obligation-activation-instance:v1:L3Nydi9ydXNhLXByb2Q:YTpi"
    );
  });

  it("cancelObligationActivation leaves foreign-instance blocks and legacy blocks byte-for-byte untouched", () => {
    const foreignProdBlock =
      "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:c2hhcmVkLW9iLWlk\n" +
      "CRON_TZ=UTC\n" +
      "45 8 * * * curl /wake-obligation -d 'id=shared-ob-id'\n" +
      'CRON_TZ=""\n' +
      "# mc-obligation-activation-instance-end:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:c2hhcmVkLW9iLWlk\n";

    const foreignStagingBlock =
      "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2Etc3RhZ2luZw:c2hhcmVkLW9iLWlk\n" +
      "CRON_TZ=UTC\n" +
      "0 12 * * * curl /wake-obligation -d 'id=shared-ob-id'\n" +
      'CRON_TZ=""\n' +
      "# mc-obligation-activation-instance-end:v1:L2hvbWUvc2YvLnJ1c2Etc3RhZ2luZw:c2hhcmVkLW9iLWlk\n";

    const legacyBlock =
      "# mc-obligation-activation:legacy-ob-1\n" +
      "CRON_TZ=UTC\n" +
      "30 3 * * * curl /wake-obligation -d 'id=legacy-ob-1'\n" +
      'CRON_TZ=""\n' +
      "# mc-obligation-activation-end:legacy-ob-1\n";

    const userLine = "0 1 * * * /usr/bin/user-job\n";

    let cronData = userLine + foreignProdBlock + foreignStagingBlock + legacyBlock;
    const cron: CrontabIo = {
      read: () => cronData,
      write: (data) => {
        cronData = data;
      },
    };

    const at: AtIo = {
      schedule: vi.fn(),
      list: vi.fn().mockReturnValue([
        {
          id: "at-prod",
          script:
            "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:c2hhcmVkLW9iLWlk\ncurl /wake\n",
        },
        {
          id: "at-staging",
          script:
            "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2Etc3RhZ2luZw:c2hhcmVkLW9iLWlk\ncurl /wake\n",
        },
        { id: "at-legacy", script: "# mc-obligation-activation:legacy-ob-1\ncurl /wake\n" },
      ]),
      remove: vi.fn(),
    };

    // Staging scheduler cancels its own shared-ob-id
    const stagingScheduler = new DefaultOsScheduler(new CrontabMutator(cron), at, {
      tokenFile: "/token",
      portFile: "/port",
      instanceId: "/home/sf/.rusa-staging",
    });

    stagingScheduler.cancelObligationActivation("shared-ob-id");

    // Staging block removed
    expect(cronData).not.toContain(foreignStagingBlock);
    // Prod block, legacy block, and user line remain byte-for-byte identical
    expect(cronData).toContain(foreignProdBlock);
    expect(cronData).toContain(legacyBlock);
    expect(cronData).toContain(userLine);
    expect(cronData).toBe(userLine + foreignProdBlock + legacyBlock);

    // Staging at job removed, prod and legacy at jobs untouched
    expect(at.remove).toHaveBeenCalledWith("at-staging");
    expect(at.remove).not.toHaveBeenCalledWith("at-prod");
    expect(at.remove).not.toHaveBeenCalledWith("at-legacy");
  });
});

describe("DefaultOsScheduler instance-scoped OS jobs (#466)", () => {
  /** One shared per-user `at` queue, as seen by every co-hosted instance. */
  function sharedAtQueue(seed: { id: string; script: string }[] = []) {
    const jobs = [...seed];
    let next = 100;
    const at: AtIo = {
      schedule: (script) => {
        const id = String(next++);
        jobs.push({ id, script });
        return id;
      },
      list: () => jobs.map((job) => ({ ...job })),
      remove: (id) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index >= 0) jobs.splice(index, 1);
      },
    };
    return { at, jobs };
  }

  /** Structured records as an operator's `jq` would see them, without level/time noise. */
  function recordingLogger() {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      destination: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });
    const records = () =>
      lines
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const { level: _level, time: _time, ...record } = JSON.parse(line);
          return record as Record<string, unknown>;
        });
    return { log, records };
  }

  /** The clock every message in these tests is scheduled against: well before `deliverAt`. */
  const NOW = Date.parse("2026-09-15T12:00:00.000Z");

  function instance(
    instanceId: string,
    at: AtIo,
    cron: { data: string },
    extra: { log?: ReturnType<typeof recordingLogger>["log"]; now?: () => number } = {}
  ) {
    const io: CrontabIo = {
      read: () => cron.data,
      write: (data) => {
        cron.data = data;
      },
    };
    return new DefaultOsScheduler(new CrontabMutator(io), at, {
      tokenFile: `${instanceId}/wake-token`,
      portFile: `${instanceId}/wake-port`,
      instanceId,
      now: () => NOW,
      ...extra,
    });
  }

  const message = (id: string, toId: string) => ({
    id,
    toId,
    fromId: "sender",
    body: `body of ${id}`,
    deliverAt: "2026-09-16T12:00:00.000Z",
  });

  /**
   * ActorMesh.reconcilePendingDeliveries at boot: every listed message whose
   * recipient this instance does not know is cancelled. Before scoping, the
   * listing spanned the whole per-user queue, so this cancelled every
   * co-hosted instance's messages.
   */
  function bootReconcile(scheduler: DefaultOsScheduler, knownActors: string[]) {
    for (const pending of scheduler.listMessageDeliveries()) {
      if (!knownActors.includes(pending.toId)) scheduler.cancelMessageDelivery(pending.id);
    }
  }

  it("writes every tag family (cron block and at job) with this instance's identity through the one shared constructor", async () => {
    const { at, jobs } = sharedAtQueue();
    const cron = { data: "" };
    const prod = instance("/home/sf/.rusa-prod", at, cron);

    await prod.schedule("act1", "0 3 * * *", "nightly");
    prod.scheduleObligationActivation("ob-cron", { kind: "cron", cronExpr: "0 4 * * *" });
    prod.scheduleObligationActivation("ob-at", { kind: "at", date: new Date("2026-09-16") });
    prod.scheduleMessageDelivery(message("msg-a", "recipient"));

    const tagLines = [cron.data, ...jobs.map((job) => job.script)]
      .flatMap((text) => text.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("# mc-"));
    expect(tagLines).toEqual([
      "# mc-wake-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:YWN0MQ",
      "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:b2ItY3Jvbg",
      "# mc-obligation-activation-instance-end:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:b2ItY3Jvbg",
      "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:b2ItYXQ",
      "# mc-message-delivery-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:bXNnLWE",
    ]);
    for (const line of tagLines) {
      expect(line).toMatch(
        /^# mc-[a-z-]+-instance(-end)?:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:[A-Za-z0-9_-]+$/
      );
    }
  });

  describe("two co-hosted instances over one shared at queue", () => {
    const legacyJob = {
      id: "legacy",
      script: `# mc-message-delivery:bGVnYWN5\ncurl /wake-message -d 'payload=${encodeScheduledMessagePayload(message("legacy", "legacy-recipient"))}'\n`,
    };

    function seeded() {
      const { at, jobs } = sharedAtQueue([legacyJob]);
      const prod = instance("/home/sf/.rusa-prod", at, { data: "" });
      const staging = instance("/home/sf/.rusa-staging", at, { data: "" });
      prod.scheduleMessageDelivery(message("msg-a", "prod-only-actor"));
      staging.scheduleMessageDelivery(message("msg-b", "staging-only-actor"));
      return { jobs, prod, staging };
    }

    it("each instance lists only its own messages; the legacy unscoped job is never listed", () => {
      const { prod, staging } = seeded();
      expect(prod.listMessageDeliveries()).toEqual([message("msg-a", "prod-only-actor")]);
      expect(staging.listMessageDeliveries()).toEqual([message("msg-b", "staging-only-actor")]);
    });

    it.each([
      ["prod then staging", ["prod", "staging"] as const],
      ["staging then prod", ["staging", "prod"] as const],
    ])("boot reconciliation in order %s leaves the other instance's and legacy jobs untouched", (_, order) => {
      const { jobs, prod, staging } = seeded();
      const before = jobs.map((job) => ({ ...job }));
      const known = { prod: ["prod-only-actor"], staging: ["staging-only-actor"] };
      const schedulers = { prod, staging };

      for (const name of order) bootReconcile(schedulers[name], known[name]);

      expect(jobs).toEqual(before);
      expect(prod.listMessageDeliveries()).toEqual([message("msg-a", "prod-only-actor")]);
      expect(staging.listMessageDeliveries()).toEqual([message("msg-b", "staging-only-actor")]);
    });

    it.each([
      ["prod then staging", ["prod", "staging"] as const],
      ["staging then prod", ["staging", "prod"] as const],
    ])("in order %s an instance cancels only its own truly-inactive recipient's message", (_, order) => {
      const { jobs, prod, staging } = seeded();
      const schedulers = { prod, staging };

      // Prod's recipient really is gone; staging's is still live.
      for (const name of order) {
        bootReconcile(schedulers[name], name === "prod" ? [] : ["staging-only-actor"]);
      }

      expect(jobs.map((job) => job.id)).toEqual(["legacy", "101"]);
      expect(prod.listMessageDeliveries()).toEqual([]);
      expect(staging.listMessageDeliveries()).toEqual([message("msg-b", "staging-only-actor")]);
    });

    it("cancelMessageDelivery and stale cleanup never match a foreign or legacy job with the same message id", () => {
      const { jobs, prod, staging } = seeded();
      staging.scheduleMessageDelivery(message("msg-a", "staging-only-actor"));
      const stagingCopy = jobs.find((job) => job.id === "102");
      expect(stagingCopy?.script).toContain(
        "# mc-message-delivery-instance:v1:L2hvbWUvc2YvLnJ1c2Etc3RhZ2luZw:bXNnLWE"
      );

      prod.cancelMessageDelivery("msg-a");
      prod.cancelMessageDelivery("legacy");
      expect(jobs.map((job) => job.id)).toEqual(["legacy", "101", "102"]);

      // Re-scheduling replaces only this instance's stale copy of the id.
      staging.scheduleMessageDelivery(message("msg-a", "staging-only-actor"));
      expect(jobs.map((job) => job.id)).toEqual(["legacy", "101", "103"]);
    });
  });

  describe("at queue diagnostics", () => {
    const PROD = "/home/sf/.rusa-prod";
    const MSG_TAG = "# mc-message-delivery-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:bXNnLWE";

    it("records every at write, confirmation and removal with the tag and this instance's id", () => {
      const { at } = sharedAtQueue();
      const { log, records } = recordingLogger();
      const prod = instance(PROD, at, { data: "" }, { log });

      prod.scheduleMessageDelivery(message("msg-a", "recipient"));
      prod.scheduleObligationActivation("ob-at", { kind: "at", date: new Date("2026-09-16") });
      prod.cancelMessageDelivery("msg-a");
      prod.cancelObligationActivation("ob-at");

      const OB_TAG = "# mc-obligation-activation-instance:v1:L2hvbWUvc2YvLnJ1c2EtcHJvZA:b2ItYXQ";
      expect(records()).toEqual([
        {
          component: "os-scheduler",
          instanceId: PROD,
          msg: "at_job_scheduled",
          family: "message-delivery",
          id: "msg-a",
          tag: MSG_TAG,
          atJobId: "100",
          runAt: "2026-09-16T12:00:00.000Z",
        },
        {
          component: "os-scheduler",
          instanceId: PROD,
          msg: "at_enqueue_confirmed",
          family: "message-delivery",
          id: "msg-a",
          tag: MSG_TAG,
          atJobId: "100",
          queueSize: 1,
        },
        {
          component: "os-scheduler",
          instanceId: PROD,
          msg: "at_job_scheduled",
          family: "obligation-activation",
          id: "ob-at",
          tag: OB_TAG,
          atJobId: "101",
          runAt: "2026-09-16T00:00:00.000Z",
        },
        {
          component: "os-scheduler",
          instanceId: PROD,
          msg: "at_job_removed",
          family: "message-delivery",
          id: "msg-a",
          tag: MSG_TAG,
          atJobId: "100",
        },
        {
          component: "os-scheduler",
          instanceId: PROD,
          msg: "at_job_removed",
          family: "obligation-activation",
          id: "ob-at",
          tag: OB_TAG,
          atJobId: "101",
        },
      ]);
    });

    it("attributes a boot-reconciliation cancel to the instance that performed it", () => {
      const { at } = sharedAtQueue();
      const { log, records } = recordingLogger();
      const prod = instance(PROD, at, { data: "" }, { log });
      prod.scheduleMessageDelivery(message("msg-a", "gone"));

      bootReconcile(prod, []);

      expect(records().filter((record) => record.msg === "at_job_removed")).toEqual([
        expect.objectContaining({ instanceId: PROD, tag: MSG_TAG, atJobId: "100" }),
      ]);
    });

    it("refuses to report a message as scheduled when `at` returned an id the queue re-read does not show, keeping the prior copy armed", () => {
      const { at, jobs } = sharedAtQueue();
      const { log, records } = recordingLogger();
      const prod = instance(PROD, at, { data: "" }, { log });
      prod.scheduleMessageDelivery(message("msg-a", "recipient"));
      expect(jobs.map((job) => job.id)).toEqual(["100"]);

      // `at` prints a job id, but the job never reaches the spool.
      const lossy: AtIo = { ...at, schedule: () => "101" };
      const retry = instance(PROD, lossy, { data: "" }, { log });

      expect(() => retry.scheduleMessageDelivery(message("msg-a", "recipient"))).toThrow(
        AtEnqueueUnconfirmedError
      );
      expect(jobs.map((job) => job.id)).toEqual(["100"]);
      expect(records().slice(2)).toEqual([
        expect.objectContaining({ msg: "at_job_scheduled", tag: MSG_TAG, atJobId: "101" }),
        {
          component: "os-scheduler",
          instanceId: PROD,
          msg: "at_enqueue_unconfirmed",
          family: "message-delivery",
          id: "msg-a",
          tag: MSG_TAG,
          atJobId: "101",
          queueSize: 1,
          reason: "job missing from queue",
        },
      ]);
    });

    it("tolerates, but records, a missing job only when its `at` run minute has already begun", () => {
      const { at } = sharedAtQueue();
      const lossy: AtIo = { ...at, schedule: () => "100" };
      const { log, records } = recordingLogger();
      const due = (iso: string) => ({ ...message("msg-a", "recipient"), deliverAt: iso });

      // `at` truncates a job's time to the minute, so a job for 12:00:30
      // submitted at 12:00:10 runs at once and may be gone before the re-read.
      const midMinute = instance(PROD, lossy, { data: "" }, { log, now: () => NOW + 10_000 });
      expect(() =>
        midMinute.scheduleMessageDelivery(due("2026-09-15T12:00:30.000Z"))
      ).not.toThrow();
      expect(records().map((record) => [record.msg, record.reason])).toEqual([
        ["at_job_scheduled", undefined],
        ["at_enqueue_unconfirmed", "job run minute has begun; may already have run"],
      ]);

      // Thirty seconds ahead but across the minute boundary: the run minute
      // has not begun, so the job cannot have run and must still be queued.
      const nearBoundary = instance(PROD, lossy, { data: "" }, { log, now: () => NOW + 59_000 });
      expect(() => nearBoundary.scheduleMessageDelivery(due("2026-09-15T12:01:29.000Z"))).toThrow(
        AtEnqueueUnconfirmedError
      );
      // A full minute ahead on the boundary is likewise still ahead.
      const onMinute = instance(PROD, lossy, { data: "" }, { log, now: () => NOW });
      expect(() => onMinute.scheduleMessageDelivery(due("2026-09-15T12:01:00.000Z"))).toThrow(
        AtEnqueueUnconfirmedError
      );
      expect(records().filter((record) => record.reason === "job missing from queue")).toHaveLength(
        2
      );
    });
  });
});
