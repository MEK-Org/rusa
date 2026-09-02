import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AtIo,
  AtUnavailableError,
  DefaultOsScheduler,
  execAtIo,
  unavailableAtIo,
} from "./os-scheduler.js";
import type { CrontabIo } from "./wake-cron.js";

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

    at = {
      schedule: vi.fn().mockReturnValue("123"),
      list: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
    };

    scheduler = new DefaultOsScheduler(cron, at, {
      tokenFile: "/token",
      portFile: "/port",
    });
  });

  it("schedules a cron activation", () => {
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    expect(cronData).toContain("# mc-obligation-activation:ob-1");
    expect(cronData).toContain("*/5 * * * *");
    expect(cronData).toContain("/wake-obligation");

    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).not.toContain("# mc-obligation-activation:ob-1");
  });

  it("schedules an at activation", () => {
    scheduler.scheduleObligationActivation("ob-2", { kind: "at", date: new Date() });
    expect(at.schedule).toHaveBeenCalled();
  });

  it("strips cron blocks without disturbing adjacent user jobs", () => {
    cronData =
      '1 * * * * user-job-1\n# mc-obligation-activation:ob-1\nCRON_TZ=UTC\n*/5 * * * * curl wake-obligation\nCRON_TZ=""\n2 * * * * user-job-2\n';
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).toBe("1 * * * * user-job-1\n2 * * * * user-job-2\n");
  });

  it("does not delete an adjacent unmanaged job whose command merely mentions wake-obligation/wake-message", () => {
    cronData =
      '1 * * * * user-job-1\n# mc-obligation-activation:ob-1\nCRON_TZ=UTC\n*/5 * * * * curl wake-obligation\nCRON_TZ=""\n3 * * * * /usr/bin/wake-message-backup --dry-run\n2 * * * * user-job-2\n';
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).toBe(
      "1 * * * * user-job-1\n3 * * * * /usr/bin/wake-message-backup --dry-run\n2 * * * * user-job-2\n"
    );
  });

  it("does not delete an adjacent unmanaged CRON_TZ= line beyond the block's own restore line", () => {
    cronData =
      "# mc-obligation-activation:ob-1\nCRON_TZ=UTC\n*/5 * * * * curl wake-obligation\nCRON_TZ=\nCRON_TZ=Europe/Paris\n4 * * * * user-job\n";
    scheduler.cancelObligationActivation("ob-1");
    expect(cronData).toBe("CRON_TZ=Europe/Paris\n4 * * * * user-job\n");
  });

  it('restores CRON_TZ= (not CRON_TZ="") when no prior CRON_TZ was in effect', () => {
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    const lines = cronData.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("CRON_TZ=");
  });

  it("restores the exact prior CRON_TZ line rather than blindly clearing it", () => {
    cronData = "CRON_TZ=America/New_York\n1 * * * * user-job\n";
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    const lines = cronData.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("CRON_TZ=America/New_York");
    expect(cronData).toContain("1 * * * * user-job");
  });

  it("re-scheduling replaces the block once and still restores the original prior CRON_TZ", () => {
    cronData = "CRON_TZ=America/New_York\n1 * * * * user-job\n";
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" });
    scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "0 6 * * *" });
    const lines = cronData.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("CRON_TZ=America/New_York");
    expect(cronData).toContain("1 * * * * user-job");
    expect(cronData.match(/# mc-obligation-activation:ob-1/g)).toHaveLength(1);
    expect(cronData).toContain("0 6 * * *");
    expect(cronData).not.toContain("*/5 * * * *");
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
    const scheduler = new DefaultOsScheduler(cron, unavailableAtIo(["at missing"]), {
      tokenFile: "/token",
      portFile: "/port",
    });

    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "cron", cronExpr: "*/5 * * * *" })
    ).not.toThrow();
    expect(cronData).toContain("# mc-obligation-activation:ob-1");

    expect(() => scheduler.cancelObligationActivation("ob-1")).not.toThrow();
    expect(cronData).not.toContain("# mc-obligation-activation:ob-1");
  });

  it("fails a completion-interval (at-kind) activation with the named prerequisite error", () => {
    const cron: CrontabIo = { read: () => "", write: () => {} };
    const scheduler = new DefaultOsScheduler(cron, unavailableAtIo(["at missing"]), {
      tokenFile: "/token",
      portFile: "/port",
    });

    expect(() =>
      scheduler.scheduleObligationActivation("ob-1", { kind: "at", date: new Date() })
    ).toThrow(AtUnavailableError);
  });
});
