import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CrontabIo,
  CrontabMutator,
  CrontabWakeCron,
  cronExprEverFires,
  execCrontabIo,
  isValidActorId,
  isValidCronExpr,
  nextCronOccurrence,
  preflightCron,
  writeWakePort,
} from "./wake-cron.js";

/** In-memory crontab: serves a string, records each write. */
class FakeCrontab implements CrontabIo {
  writes: string[] = [];
  constructor(public content = "") {}
  read(): string {
    return this.content;
  }
  write(content: string): void {
    this.content = content;
    this.writes.push(content);
  }
}

const OPTS = {
  tokenFile: "/home/sf/.rusa/wake-token",
  portFile: "/home/sf/.rusa/wake-port",
};
const make = (content = "") => {
  const io = new FakeCrontab(content);
  return { io, cron: new CrontabWakeCron(new CrontabMutator(io), OPTS) };
};

describe("cron expression + actor-id validation", () => {
  it("accepts standard 5-field numeric/*,/- expressions", () => {
    expect(isValidCronExpr("0 3 * * *")).toBe(true);
    expect(isValidCronExpr("*/15 0-6 1,15 * 1-5")).toBe(true);
  });
  it("rejects wrong arity, named fields, and injection attempts", () => {
    expect(isValidCronExpr("0 3 * *")).toBe(false); // 4 fields
    expect(isValidCronExpr("0 3 * * mon")).toBe(false); // named day
    expect(isValidCronExpr("0 3 * * * curl evil")).toBe(false); // trailing command
    expect(isValidCronExpr("0 3 * * *\ncurl evil")).toBe(false); // newline injection
  });
  it("rejects field values outside each field's valid range", () => {
    expect(isValidCronExpr("99 99 99 99 99")).toBe(false); // every field out of range
    expect(isValidCronExpr("60 0 * * *")).toBe(false); // minute max is 59
    expect(isValidCronExpr("0 24 * * *")).toBe(false); // hour max is 23
    expect(isValidCronExpr("0 0 32 * *")).toBe(false); // day-of-month max is 31
    expect(isValidCronExpr("0 0 0 * *")).toBe(false); // day-of-month min is 1
    expect(isValidCronExpr("0 0 * 13 *")).toBe(false); // month max is 12
    expect(isValidCronExpr("0 0 * 0 *")).toBe(false); // month min is 1
    expect(isValidCronExpr("0 0 * * 7")).toBe(false); // day-of-week max is 6
    expect(isValidCronExpr("59 23 31 12 6")).toBe(true); // every field at its max
    expect(isValidCronExpr("0 0 1 1 0")).toBe(true); // every field at its min
  });
  it("rejects a zero-valued step stride", () => {
    expect(isValidCronExpr("*/0 * * * *")).toBe(false);
    expect(isValidCronExpr("0 0 1-10/0 * *")).toBe(false);
  });
  it("rejects an inverted range", () => {
    expect(isValidCronExpr("0 0 10-1 * *")).toBe(false);
  });
  it("rejects syntactically valid calendars that can never fire", () => {
    expect(cronExprEverFires("0 0 31 2 *")).toBe(false);
  });
  it("recognizes century-boundary leap dates across the complete Gregorian cycle", () => {
    // 2100 is not a leap year but 2000 and 2400 are; a short bounded scan
    // cannot establish this calendar-level fact.
    expect(cronExprEverFires("0 0 29 2 *")).toBe(true);
    expect(
      nextCronOccurrence("0 0 29 2 *", new Date("2099-03-01T00:00:00.000Z")).toISOString()
    ).toBe("2104-02-29T00:00:00.000Z");
  });
  it("validates actor ids to safe characters, including suffixed wake slots", () => {
    expect(isValidActorId("73e0b00f-8810-4315")).toBe(true);
    expect(isValidActorId("root:daily-bless-cut")).toBe(true);
    expect(isValidActorId("actor-123:slot_a.1")).toBe(true);
    expect(isValidActorId("bad id")).toBe(false);
    expect(isValidActorId("a;rm -rf")).toBe(false);
    expect(isValidActorId(":slot")).toBe(false);
    expect(isValidActorId("root:")).toBe(false);
    expect(isValidActorId("root::slot")).toBe(false);
  });
});

describe("execCrontabIo", () => {
  it("treats only crontab's documented absent-user message as an empty crontab", () => {
    const io = execCrontabIo((() => {
      const error = Object.assign(new Error("exit 1"), {
        stderr: Buffer.from("no crontab for user\n"),
      });
      throw error;
    }) as typeof import("node:child_process").execFileSync);
    expect(io.read()).toBe("");
  });

  it("fails closed when crontab -l fails for any other reason", () => {
    const io = execCrontabIo((() => {
      const error = Object.assign(new Error("permission denied"), {
        stderr: Buffer.from("permission denied\n"),
      });
      throw error;
    }) as typeof import("node:child_process").execFileSync);
    expect(() => io.read()).toThrow("permission denied");
  });
});

describe("CrontabWakeCron.buildJobLine", () => {
  it("emits cron-expr + absolute curl + token/port via command substitution", () => {
    const { cron } = make();
    const line = cron.buildJobLine("act1", "0 3 * * *", "nightly distill");
    expect(line.startsWith("0 3 * * * /usr/bin/curl -fsS")).toBe(true);
    expect(line).toContain('-H "Authorization: Bearer $(cat /home/sf/.rusa/wake-token)"');
    expect(line).toContain('"http://127.0.0.1:$(cat /home/sf/.rusa/wake-port)/wake"');
    expect(line).toContain("-d 'actorId=act1'");
    expect(line).toContain("-d 'reason=nightly distill'");
  });
  it("escapes % (cron newline) and single quotes in the reason", () => {
    const { cron } = make();
    const line = cron.buildJobLine("act1", "0 3 * * *", "100% done; it's ready");
    expect(line).toContain("\\%"); // % escaped
    expect(line).not.toMatch(/[^\\]%/); // no unescaped %
    expect(line).toContain("it'\\''s"); // single quote escaped
  });
  it("emits priority parameter when priority is responsive", () => {
    const { cron } = make();
    const lineString = cron.buildJobLine("act1", "0 3 * * *", "bless cut", "responsive");
    expect(lineString).toContain("-d 'priority=responsive'");
    const lineBool = cron.buildJobLine("act1", "0 3 * * *", "bless cut", true);
    expect(lineBool).toContain("-d 'priority=responsive'");
    const lineNormal = cron.buildJobLine("act1", "0 3 * * *", "nightly", "normal");
    expect(lineNormal).not.toContain("priority=");
  });
});

describe("CrontabWakeCron schedule/cancel/list", () => {
  it("schedules into an empty crontab as a tag line above the job line", async () => {
    const { io, cron } = make();
    await cron.schedule("act1", "0 3 * * *", "nightly");
    const lines = io.content.trimEnd().split("\n");
    expect(lines[0]).toBe("# mc-wake:act1");
    expect(lines[1].startsWith("0 3 * * * /usr/bin/curl")).toBe(true);
  });

  it("preserves unrelated human lines and replaces (not duplicates) an existing block", async () => {
    const human = "# my own job\n0 9 * * 1 /usr/bin/backup.sh\n";
    const { io, cron } = make(human);
    await cron.schedule("act1", "0 3 * * *", "first");
    await cron.schedule("act1", "30 4 * * *", "second"); // re-schedule same actor
    expect(io.content).toContain("# my own job");
    expect(io.content).toContain("/usr/bin/backup.sh");
    expect(io.content.match(/# mc-wake:act1/g)).toHaveLength(1); // replaced, not duplicated
    const entries = await cron.list();
    expect(entries).toEqual([{ actorId: "act1", cronExpr: "30 4 * * *", reason: "second" }]);
  });

  it("manages multiple actors and suffixed slots independently", async () => {
    const { cron } = make();
    await cron.schedule("root", "0 3 * * *", "base root wake");
    await cron.schedule("root:daily-bless-cut", "45 8 * * *", "daily bless cut", "responsive");
    await cron.schedule("act2", "0 4 * * *", "two");

    const entries = await cron.list();
    expect(entries.map((e) => e.actorId).sort()).toEqual(["act2", "root", "root:daily-bless-cut"]);

    await cron.cancel("root:daily-bless-cut");
    const afterCancel = await cron.list();
    expect(afterCancel.map((e) => e.actorId).sort()).toEqual(["act2", "root"]);
    expect(afterCancel.find((e) => e.actorId === "root")?.reason).toBe("base root wake");
  });

  it("cancel preserves unrelated lines and no-ops when the actor is absent", async () => {
    const { io, cron } = make("# keep me\n0 1 * * * /bin/true\n");
    await cron.cancel("ghost"); // absent
    expect(io.writes).toHaveLength(0); // no write when nothing changed
    await cron.schedule("act1", "0 3 * * *", "x");
    await cron.cancel("act1");
    expect(io.content).toContain("# keep me");
    expect(io.content).not.toContain("mc-wake");
  });

  it("round-trips a reason containing % and quotes through schedule→list", async () => {
    const { cron } = make();
    await cron.schedule("act1", "0 3 * * *", "100% of it's done");
    expect((await cron.list())[0].reason).toBe("100% of it's done");
  });

  it("round-trips priority through schedule→list", async () => {
    const { cron } = make();
    await cron.schedule("act1", "0 3 * * *", "standing op", "responsive");
    await cron.schedule("act2", "0 4 * * *", "normal op");
    const entries = await cron.list();
    expect(entries).toEqual([
      { actorId: "act1", cronExpr: "0 3 * * *", reason: "standing op", priority: "responsive" },
      { actorId: "act2", cronExpr: "0 4 * * *", reason: "normal op" },
    ]);
  });

  it("rejects an invalid cron expression WITHOUT writing", async () => {
    const { io, cron } = make();
    await expect(cron.schedule("act1", "bad expr", "x")).rejects.toThrow(/invalid cron/);
    expect(io.writes).toHaveLength(0);
  });

  it("serializes concurrent edits so both land (no lost update)", async () => {
    const { cron } = make();
    await Promise.all([
      cron.schedule("act1", "0 3 * * *", "one"),
      cron.schedule("act2", "0 4 * * *", "two"),
    ]);
    expect((await cron.list()).map((e) => e.actorId).sort()).toEqual(["act1", "act2"]);
  });
});

describe("writeWakePort", () => {
  it("writes the port atomically, leaving no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-port-"));
    writeWakePort(dir, 54321);
    expect(readFileSync(join(dir, "wake-port"), "utf-8")).toBe("54321");
    expect(existsSync(join(dir, "wake-port.tmp"))).toBe(false); // renamed, not left as temp
  });
});

describe("nextCronOccurrence", () => {
  const at = (iso: string) => new Date(iso);

  it("finds the next minute match, strictly after the given time", () => {
    const next = nextCronOccurrence("30 4 * * *", at("2026-09-02T04:30:00.000Z"));
    // Exactly on the mark still advances a full day — "next" excludes "now".
    expect(next.toISOString()).toBe("2026-09-03T04:30:00.000Z");
  });

  it("finds the same-day occurrence when still ahead", () => {
    const next = nextCronOccurrence("30 4 * * *", at("2026-09-02T00:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-02T04:30:00.000Z");
  });

  it("expands comma lists", () => {
    const next = nextCronOccurrence("0 6,18 * * *", at("2026-09-02T07:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-02T18:00:00.000Z");
  });

  it("expands a-b ranges", () => {
    const next = nextCronOccurrence("0 9-17 * * *", at("2026-09-02T08:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-02T09:00:00.000Z");
  });

  it("expands */step strides", () => {
    const next = nextCronOccurrence("*/15 * * * *", at("2026-09-02T00:01:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-02T00:15:00.000Z");
  });

  it("expands a ranged step (a-b/n)", () => {
    const next = nextCronOccurrence("0 9-17/4 * * *", at("2026-09-02T09:30:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-02T13:00:00.000Z");
  });

  it("treats day-of-month and day-of-week as OR when both are restricted", () => {
    // The 1st of the month OR any Friday — standard cron semantics.
    const next = nextCronOccurrence("0 0 1 * 5", at("2026-09-02T00:00:00.000Z"));
    // 2026-09-04 is a Friday, before the 1st of October.
    expect(next.toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });

  it("treats day-of-month alone as AND with month when day-of-week is unrestricted", () => {
    const next = nextCronOccurrence("0 0 15 * *", at("2026-09-02T00:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("crosses a leap-year February 29th", () => {
    const next = nextCronOccurrence("0 0 29 2 *", at("2027-01-01T00:00:00.000Z"));
    expect(next.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("throws for an invalid cron expression", () => {
    expect(() => nextCronOccurrence("bad expr", at("2026-09-02T00:00:00.000Z"))).toThrow(
      /invalid cron/
    );
  });
});

describe("preflightCron", () => {
  const okPermission = () => ({ ok: true });

  it("reports a missing crontab CLI", () => {
    const r = preflightCron({
      hasCrontab: () => false,
      isCrondRunning: () => true,
      checkPermission: okPermission,
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/crontab/);
  });
  it("reports a stopped cron daemon", () => {
    const r = preflightCron({
      hasCrontab: () => true,
      isCrondRunning: () => false,
      checkPermission: okPermission,
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/daemon/);
  });
  it("reports a user locked out by cron.allow/cron.deny", () => {
    const r = preflightCron({
      hasCrontab: () => true,
      isCrondRunning: () => true,
      checkPermission: () => ({ ok: false, detail: "crontab denied for this user: not allowed" }),
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/not allowed/);
  });
  it("falls back to a generic permission message when the probe gives no detail", () => {
    const r = preflightCron({
      hasCrontab: () => true,
      isCrondRunning: () => true,
      checkPermission: () => ({ ok: false }),
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/cron\.allow/);
  });
  it("is ok when the CLI, daemon, and permission are all fine", () => {
    expect(
      preflightCron({
        hasCrontab: () => true,
        isCrondRunning: () => true,
        checkPermission: okPermission,
      }).ok
    ).toBe(true);
  });
});
