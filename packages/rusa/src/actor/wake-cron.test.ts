import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CrontabIo,
  CrontabWakeCron,
  isValidActorId,
  isValidCronExpr,
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
  return { io, cron: new CrontabWakeCron(io, OPTS) };
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

describe("preflightCron", () => {
  it("reports a missing crontab CLI", () => {
    const r = preflightCron({ hasCrontab: () => false, isCrondRunning: () => true });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/crontab/);
  });
  it("reports a stopped cron daemon", () => {
    const r = preflightCron({ hasCrontab: () => true, isCrondRunning: () => false });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/daemon/);
  });
  it("is ok when both are present", () => {
    expect(preflightCron({ hasCrontab: () => true, isCrondRunning: () => true }).ok).toBe(true);
  });
});
