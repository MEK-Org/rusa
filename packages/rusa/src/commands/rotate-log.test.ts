import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #580: the standalone service-log rotator the per-instance logrotate timer runs.

function logDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "rusa-rotate-")), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rotate(logPath: string, env: Record<string, string> = {}, timeout?: number) {
  return spawnSync(process.execPath, [resolve("scripts/rotate-log.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, RUSA_LOG_PATH: logPath, ...env },
    encoding: "utf8",
    timeout,
  });
}

const small = { RUSA_LOG_ROTATE_MAX_BYTES: "10", RUSA_LOG_ROTATE_KEEP: "3" };

describe("rotate-log (#580)", () => {
  it("leaves a log under the size bound alone", () => {
    const log = join(logDir(), "rusa.log");
    writeFileSync(log, "short\n");
    const result = rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: "100" });
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("short\n");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("copies an over-bound log to .1 and truncates the active file in place", () => {
    const log = join(logDir(), "rusa.log");
    writeFileSync(log, "0123456789abcdef\n");
    chmodSync(log, 0o640);
    const inode = statSync(log).ino;
    const result = rotate(log, small);
    expect(result.status).toBe(0);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("0123456789abcdef\n");
    expect(readFileSync(log, "utf8")).toBe("");
    // Same file, same permissions: the service's `append:` descriptor still
    // points at the active log, and nothing new is more readable than the original.
    expect(statSync(log).ino).toBe(inode);
    expect(statSync(log).mode & 0o777).toBe(0o640);
    expect(statSync(`${log}.1`).mode & 0o777).toBe(0o640);
  });

  it("keeps a running writer's append descriptor writing into the active log", () => {
    const log = join(logDir(), "rusa.log");
    const fd = openSync(log, "a");
    try {
      writeSync(fd, "before rotation, long enough\n");
      expect(rotate(log, small).status).toBe(0);
      writeSync(fd, "after\n");
    } finally {
      closeSync(fd);
    }
    // O_APPEND lands the next write at the new end of file — no hole of NULs
    // where the rotated bytes used to be.
    expect(readFileSync(log, "utf8")).toBe("after\n");
    expect(readFileSync(`${log}.1`, "utf8")).toBe("before rotation, long enough\n");
  });

  it("shifts generations and drops the oldest past the retention count", () => {
    const log = join(logDir(), "rusa.log");
    for (const n of [1, 2, 3, 4, 5]) {
      writeFileSync(log, `generation ${n} padding\n`);
      expect(rotate(log, small).status).toBe(0);
    }
    expect(readFileSync(`${log}.1`, "utf8")).toBe("generation 5 padding\n");
    expect(readFileSync(`${log}.2`, "utf8")).toBe("generation 4 padding\n");
    expect(readFileSync(`${log}.3`, "utf8")).toBe("generation 3 padding\n");
    expect(existsSync(`${log}.4`)).toBe(false);
  });

  it("prunes generations beyond a lowered retention count", () => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    for (const n of [1, 2, 3, 4, 5, 6]) writeFileSync(`${log}.${n}`, `old ${n}\n`);
    writeFileSync(log, "over the bound now\n");
    expect(rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: "10", RUSA_LOG_ROTATE_KEEP: "2" }).status).toBe(
      0
    );
    expect(readdirSync(dir).sort()).toEqual(["rusa.log", "rusa.log.1", "rusa.log.2"]);
    expect(readFileSync(`${log}.2`, "utf8")).toBe("old 1\n");
  });

  it("with a retention count of zero, truncates without keeping a copy", () => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    writeFileSync(log, "over the bound now\n");
    expect(rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: "10", RUSA_LOG_ROTATE_KEEP: "0" }).status).toBe(
      0
    );
    expect(readdirSync(dir)).toEqual(["rusa.log"]);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("touches only its own log's generations, never a neighbour's", () => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    const otherInstance = logDir();
    writeFileSync(join(dir, "other.log.1"), "neighbour\n");
    writeFileSync(join(dir, "rusa.log.bak"), "operator copy\n");
    writeFileSync(join(otherInstance, "rusa.log"), "another instance, over the bound\n");
    writeFileSync(join(otherInstance, "rusa.log.9"), "another instance's old generation\n");
    writeFileSync(log, "over the bound now\n");
    expect(rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: "10", RUSA_LOG_ROTATE_KEEP: "1" }).status).toBe(
      0
    );
    expect(readdirSync(dir).sort()).toEqual([
      "other.log.1",
      "rusa.log",
      "rusa.log.1",
      "rusa.log.bak",
    ]);
    expect(readdirSync(otherInstance).sort()).toEqual(["rusa.log", "rusa.log.9"]);
    expect(readFileSync(join(otherInstance, "rusa.log"), "utf8")).toBe(
      "another instance, over the bound\n"
    );
  });

  it("is idempotent: a second run right after a rotation changes nothing", () => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    writeFileSync(log, "over the bound now\n");
    expect(rotate(log, small).status).toBe(0);
    expect(rotate(log, small).status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["rusa.log", "rusa.log.1"]);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("over the bound now\n");
  });

  it("does nothing when the operator opts out", () => {
    const log = join(logDir(), "rusa.log");
    writeFileSync(log, "over the bound now\n");
    const result = rotate(log, { ...small, RUSA_LOG_ROTATE: "off" });
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("over the bound now\n");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("succeeds without a log file yet", () => {
    const log = join(logDir(), "rusa.log");
    const result = rotate(log, small);
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  // A malformed or out-of-range override falls back to its default rather than
  // disabling rotation. Digit-only is not enough: 400 nines pass a digit check but
  // Number() makes them Infinity, which would never reach the bound (MAX_BYTES) or
  // never finish shifting generations (KEEP).
  const infinite = "9".repeat(400);
  const unsafe = "9007199254740993"; // past Number.MAX_SAFE_INTEGER

  const outOfRange = [
    { label: "past MAX_SAFE_INTEGER", value: unsafe },
    { label: "400 nines (Infinity)", value: infinite },
  ];

  it.each([
    { label: "50MB", value: "50MB" },
    { label: "-1", value: "-1" },
    { label: "0", value: "0" },
    ...outOfRange,
  ])("falls back to the default bound on RUSA_LOG_ROTATE_MAX_BYTES=$label", ({ value }) => {
    const log = join(logDir(), "rusa.log");
    writeFileSync(log, "short\n");
    const result = rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: value });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ignoring RUSA_LOG_ROTATE_MAX_BYTES");
    expect(result.stderr).toContain("using 52428800");
    expect(readFileSync(log, "utf8")).toBe("short\n");
  });

  it("still rotates at the default bound when the bound override is too large to represent", () => {
    const log = join(logDir(), "rusa.log");
    writeFileSync(log, "");
    truncateSync(log, 52428800); // sparse: the default bound, exactly
    const result = rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: infinite, RUSA_LOG_ROTATE_KEEP: "1" });
    expect(result.status).toBe(0);
    expect(statSync(`${log}.1`).size).toBe(52428800);
    expect(statSync(log).size).toBe(0);
  });

  it.each([
    { label: "-1", value: "-1" },
    { label: "five", value: "five" },
    { label: "101", value: "101" },
    ...outOfRange,
  ])("falls back to keeping 5 generations on RUSA_LOG_ROTATE_KEEP=$label", ({ value }) => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    for (const n of [1, 2, 3, 4, 5, 6]) writeFileSync(`${log}.${n}`, `old ${n}\n`);
    writeFileSync(log, "over the bound now\n");
    // The timeout turns a runaway shift loop into a failure instead of a hang.
    const result = rotate(
      log,
      { RUSA_LOG_ROTATE_MAX_BYTES: "10", RUSA_LOG_ROTATE_KEEP: value },
      10_000
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ignoring RUSA_LOG_ROTATE_KEEP");
    expect(readdirSync(dir).sort()).toEqual([
      "rusa.log",
      "rusa.log.1",
      "rusa.log.2",
      "rusa.log.3",
      "rusa.log.4",
      "rusa.log.5",
    ]);
  });

  it("accepts the largest supported retention count", () => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    writeFileSync(log, "over the bound now\n");
    const result = rotate(log, { RUSA_LOG_ROTATE_MAX_BYTES: "10", RUSA_LOG_ROTATE_KEEP: "100" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("keeping 100");
  });

  it("defaults the log path to $RUSA_HOME/logs/rusa.log", () => {
    const dir = logDir();
    const log = join(dir, "rusa.log");
    writeFileSync(log, "over the bound now\n");
    const { RUSA_LOG_PATH: _unused, ...env } = process.env;
    const result = spawnSync(process.execPath, [resolve("scripts/rotate-log.mjs")], {
      cwd: resolve("."),
      env: { ...env, RUSA_HOME: join(dir, ".."), ...small },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("over the bound now\n");
  });
});
