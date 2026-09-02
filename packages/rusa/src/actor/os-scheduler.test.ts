import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AtIo, DefaultOsScheduler } from "./os-scheduler.js";
import type { CrontabIo } from "./wake-cron.js";

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
});
