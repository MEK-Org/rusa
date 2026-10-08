import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// #955: the standalone per-minute host sampler the host-watchdog timer runs.

type Sample = {
  v: number;
  t: string;
  win_ms: number;
  psi: Record<"cpu" | "io" | "mem", (number | null)[] | null>;
  mem: Record<"avail_kb" | "swap_free_kb" | "pswpin" | "pswpout", number | null>;
  disk: { rd: number; wr: number };
  procs: number;
  io_denied: number;
  cpu: [number, number, string, string, number, number][];
  io: [number, number, string, string, number, number, number, number, number][];
  probe: Record<string, number | string>;
  self: { cpu_ms: number | null; wall_ms: number };
};

function sample(logPath: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [resolve("scripts/host-watchdog.mjs"), logPath], {
    cwd: resolve("."),
    env: { ...process.env, RUSA_HOST_WATCHDOG_PROBES: "off", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function samples(logPath: string): Sample[] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Sample);
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

describe("host-watchdog (#955)", () => {
  it.skipIf(process.platform !== "linux")(
    "names a synthetic CPU and read loop as the top process without logging its argv",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rusa-watchdog-"));
      const data = join(dir, "data.bin");
      writeFileSync(data, Buffer.alloc(1024 * 1024, 7));
      // Credential-shaped argv, assembled here so the literal never appears in source.
      const marker = ["ghp", "_", "Q".repeat(36)].join("");
      const loop = [
        "const { readFileSync } = require('node:fs');",
        "process.stdout.write('ready\\n');",
        "for (;;) readFileSync(process.argv[1]);",
      ].join("\n");
      const child = spawn(process.execPath, ["-e", loop, data, `--token=${marker}`], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      await new Promise<void>((done) => child.stdout?.once("data", () => done()));

      const logPath = join(dir, "logs", "host-watchdog.log");
      let seenCpu = false;
      let seenIo = false;
      const watchdogPids: number[] = [];
      // A loaded test host can push the loop out of one window's top N; two tries.
      for (let attempt = 0; attempt < 2 && !(seenCpu && seenIo); attempt++) {
        const result = sample(logPath, { RUSA_HOST_WATCHDOG_WINDOW_MS: "500" });
        expect(result.status).toBe(0);
        watchdogPids.push(result.pid as number);
        const last = samples(logPath).at(-1) as Sample;
        seenCpu ||= last.cpu.some(([pid]) => pid === child.pid);
        seenIo ||= last.io.some(([pid]) => pid === child.pid);
      }
      expect(seenCpu).toBe(true);
      expect(seenIo).toBe(true);

      const all = samples(logPath);
      for (const s of all) {
        expect(s.v).toBe(1);
        expect(s.win_ms).toBeGreaterThanOrEqual(500);
        expect(s.procs).toBeGreaterThan(1);
        expect(s.probe).toEqual({});
        expect(s.self.cpu_ms).toBeGreaterThan(0);
        expect(s.self.wall_ms).toBeGreaterThanOrEqual(s.win_ms);
        // The sampler reports its own cost under `self`, never as a top process.
        for (const [pid] of [...s.cpu, ...s.io]) expect(watchdogPids).not.toContain(pid);
        for (const row of s.cpu) expect(row).toHaveLength(6);
        for (const row of s.io) expect(row).toHaveLength(9);
      }
      const row = all.flatMap((s) => s.io).find(([pid]) => pid === child.pid);
      const comm = readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
      expect(row?.slice(1, 3)).toEqual([process.pid, comm]);
      // Reads served from the page cache still rank, through rchar.
      expect(row?.[5]).toBeGreaterThan(1024 * 1024);

      const text = readFileSync(logPath, "utf8");
      expect(text).not.toContain(marker);
      expect(text).not.toContain(data);
      expect(text).not.toMatch(/ghp_|github_pat_|sk-[A-Za-z0-9]|AIza|xox[abprs]-|--token/);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    },
    40_000
  );

  it("reads PSI from procfs and counts processes whose I/O it may not read", () => {
    const proc = mkdtempSync(join(tmpdir(), "rusa-watchdog-proc-"));
    mkdirSync(join(proc, "pressure"));
    writeFileSync(
      join(proc, "pressure", "io"),
      [
        "some avg10=12.50 avg60=3.25 avg300=0.75 total=123",
        "full avg10=10.00 avg60=2.00 avg300=0.50 total=99",
        "",
      ].join("\n")
    );
    writeFileSync(join(proc, "meminfo"), "MemTotal: 100 kB\nMemAvailable: 42 kB\nSwapFree: 7 kB\n");
    // One readable process with ")" and space in comm, one unreadable process,
    // and one process with a token-shaped comm name.
    for (const [pid, comm, io] of [
      [101, "worker (x) y", "rchar: 5\nwchar: 6\nread_bytes: 7\nwrite_bytes: 8\n"],
      [102, "other", undefined],
      [103, "ghp_credential", undefined],
    ] as const) {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(
        join(proc, String(pid), "stat"),
        `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 0 0 0\n`
      );
      if (io) writeFileSync(join(proc, String(pid), "io"), io);
    }
    const logPath = join(proc, "out", "host-watchdog.log");
    const stat101 = join(proc, "101", "stat");
    const stat103 = join(proc, "103", "stat");
    const io101 = join(proc, "101", "io");
    const updater = spawn(
      process.execPath,
      [
        "-e",
        `setTimeout(() => {
          const fs = require("node:fs");
          fs.writeFileSync(process.argv[1], "101 (worker (x) y) S 1 101 101 0 -1 0 0 0 0 0 25 15 0 0 20 0 1 0 0 0 0\\n");
          fs.writeFileSync(process.argv[2], "103 (ghp_credential) S 1 103 103 0 -1 0 0 0 0 0 20 10 0 0 20 0 1 0 0 0 0\\n");
          fs.writeFileSync(process.argv[3], "rchar: 105\\nwchar: 106\\nread_bytes: 107\\nwrite_bytes: 108\\n");
        }, 30);`,
        stat101,
        stat103,
        io101,
      ],
      { stdio: "ignore" }
    );
    children.push(updater);

    const result = sample(logPath, {
      RUSA_HOST_WATCHDOG_PROC: proc,
      RUSA_HOST_WATCHDOG_WINDOW_MS: "100",
    });
    expect(result.status).toBe(0);
    const [s] = samples(logPath);
    expect(s.psi.io).toEqual([12.5, 3.25, 0.75, 10, 2, 0.5]);
    expect(s.psi.cpu).toBeNull();
    expect(s.mem.avail_kb).toBe(42);
    expect(s.mem.swap_free_kb).toBe(7);
    expect(s.procs).toBe(3);
    expect(s.io_denied).toBe(2);

    // comm with ")" and spaces parsed accurately without field offset:
    const row101 = s.cpu.find(([pid]) => pid === 101);
    expect(row101?.slice(0, 4)).toEqual([101, 1, "worker (x) y", "S"]);
    const ioRow101 = s.io.find(([pid]) => pid === 101);
    expect(ioRow101?.slice(0, 4)).toEqual([101, 1, "worker (x) y", "S"]);
    expect(ioRow101?.slice(5)).toEqual([100, 100, 100, 100]);

    // token-shaped comm redacted:
    const row103 = s.cpu.find(([pid]) => pid === 103);
    expect(row103?.slice(0, 4)).toEqual([103, 1, "[redacted]", "S"]);

    const text = readFileSync(logPath, "utf8");
    expect(text).not.toContain("ghp_");
    expect(text).not.toMatch(/ghp_|github_pat_|sk-[A-Za-z0-9]|AIza|xox[abprs]-/);
  });

  it("self-rotates watchdog log when size exceeds 2 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-watchdog-rotate-"));
    const logPath = join(dir, "host-watchdog.log");
    mkdirSync(dir, { recursive: true });
    // Write 2.1 MB of existing log
    writeFileSync(logPath, "x".repeat(Math.round(2.1 * 1024 * 1024)));

    const result = sample(logPath, {
      RUSA_HOST_WATCHDOG_WINDOW_MS: "50",
    });
    expect(result.status).toBe(0);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    // Active log holds just the new JSON line
    const activeSize = statSync(logPath).size;
    expect(activeSize).toBeGreaterThan(0);
    expect(activeSize).toBeLessThan(1024 * 1024);
  });
});
