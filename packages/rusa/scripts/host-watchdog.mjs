#!/usr/bin/env node
// Standalone host watchdog (#955). systemd runs this once a minute from the
// per-instance `<unit>-host-watchdog.timer` and it appends ONE compact JSON
// line to `$RUSA_HOME/logs/host-watchdog.log`, so a future host lockup can be
// attributed to a process instead of only to "the disk was saturated".
//
// Each run takes two /proc snapshots one window apart (default 1 s) and records:
//   - system PSI for cpu/io/memory (some + full, avg10/avg60/avg300);
//   - MemAvailable, SwapFree, and pswpin/pswpout deltas across the window;
//   - whole-disk read/write byte deltas from /proc/diskstats;
//   - the top N processes by interval CPU (delta of utime+stime in
//     /proc/[pid]/stat, not a lifetime %cpu average) and by interval I/O from
//     /proc/[pid]/io;
//   - three TCP-connect probes, each across a different isolation boundary:
//     the GCE metadata server (local vNIC), the MagicDNS resolver (local
//     tailscaled), and a public resolver (upstream);
//   - this run's own CPU time (kernel-accounted, Node startup included) and
//     its wall time from script start, so its overhead is measured in the
//     same log it writes.
//
// Per process it records only pid, ppid, comm (the kernel's ≤15-byte
// executable name), state, and rss_kb. It never reads /proc/[pid]/cmdline or
// environ, so argv, credentials and prompt fragments cannot reach the log.
// /proc/[pid]/io of another user's process is unreadable without privilege;
// the run counts those as `io_denied` rather than guessing.
//
// Deliberately STANDALONE + build-independent, like rotate-log.mjs: it must
// keep sampling while the rusa build or service is broken.
//
// Usage: node host-watchdog.mjs <log>
//   log: the argument, else $RUSA_HOME/logs/host-watchdog.log (RUSA_HOME
//        default ~/.rusa). The installed unit always passes the argument.
// Test/benchmark knobs (not set by the installed unit):
//   RUSA_HOST_WATCHDOG_WINDOW_MS  sampling window (default 1000, 50..5000)
//   RUSA_HOST_WATCHDOG_PROBES     "off" skips the network probes
//   RUSA_HOST_WATCHDOG_PROC       procfs root (default /proc)

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const startedAt = Date.now();

const TOP_N = 3;
// Linux exports utime/stime in USER_HZ, which is 100 on every supported ABI.
const USER_HZ = 100;
const SECTOR_BYTES = 512;
const PROBE_TIMEOUT_MS = 800;
const PROBES = [
  // [label, host, port]: the label names the isolation boundary crossed.
  ["metadata", "169.254.169.254", 80],
  ["magicdns", "100.100.100.100", 53],
  ["public", "1.1.1.1", 53],
];

function intEnv(name, fallback, min, max) {
  const raw = (process.env[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return value >= min && value <= max ? value : fallback;
}

const home = process.env.RUSA_HOME || join(homedir(), ".rusa");
const logPath = process.argv[2] || join(home, "logs", "host-watchdog.log");
const proc = process.env.RUSA_HOST_WATCHDOG_PROC || "/proc";
const windowMs = intEnv("RUSA_HOST_WATCHDOG_WINDOW_MS", 1000, 50, 5000);
const probesOn = (process.env.RUSA_HOST_WATCHDOG_PROBES ?? "").trim().toLowerCase() !== "off";

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `/proc/pressure/<r>` → [some10, some60, some300, full10, full60, full300]; absent kernels → null. */
function pressure(resource) {
  const text = read(join(proc, "pressure", resource));
  if (text === undefined) return null;
  const out = [];
  for (const kind of ["some", "full"]) {
    const line = text.split("\n").find((l) => l.startsWith(`${kind} `));
    for (const key of ["avg10", "avg60", "avg300"]) {
      const match = line?.match(new RegExp(`${key}=([\\d.]+)`));
      out.push(match ? Number(match[1]) : null);
    }
  }
  return out;
}

function keyedNumbers(text, separator) {
  const values = new Map();
  for (const line of (text ?? "").split("\n")) {
    const [key, rest] = line.split(separator);
    if (key && rest !== undefined) values.set(key.trim(), Number.parseInt(rest.trim(), 10));
  }
  return values;
}

/** Whole disks only (no partitions, loop, or ram devices), so bytes are not double-counted. */
function diskBytes() {
  let rd = 0;
  let wr = 0;
  for (const line of (read(join(proc, "diskstats")) ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    const name = f[2];
    if (!name || !/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(name)) continue;
    rd += Number(f[5]) * SECTOR_BYTES;
    wr += Number(f[9]) * SECTOR_BYTES;
  }
  return { rd, wr };
}

/** comm is chosen by the process itself; keep it printable and within the kernel's 15 bytes. */
function cleanComm(comm) {
  return comm.replace(/[^\x20-\x7e]/g, "?").slice(0, 15);
}

function processSnapshot() {
  const procs = new Map();
  let entries = [];
  try {
    entries = readdirSync(proc);
  } catch {
    return procs;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = read(join(proc, entry, "stat"));
    if (stat === undefined) continue;
    // comm is parenthesised and may itself contain ")" or spaces.
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) continue;
    const rest = stat.slice(close + 2).split(" ");
    const io = read(join(proc, entry, "io"));
    const ioValues = io === undefined ? undefined : keyedNumbers(io, ":");
    procs.set(Number(entry), {
      comm: cleanComm(stat.slice(open + 1, close)),
      state: rest[0],
      ppid: Number(rest[1]),
      ticks: Number(rest[11]) + Number(rest[12]),
      io: ioValues && {
        rchar: ioValues.get("rchar") ?? 0,
        wchar: ioValues.get("wchar") ?? 0,
        rb: ioValues.get("read_bytes") ?? 0,
        wb: ioValues.get("write_bytes") ?? 0,
      },
    });
  }
  return procs;
}

function rssKb(pid) {
  const match = read(join(proc, String(pid), "status"))?.match(/^VmRSS:\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

function probe([label, host, port]) {
  return new Promise((resolve) => {
    const begun = Date.now();
    const socket = connect({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve([label, value]);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish("timeout"));
    socket.once("connect", () => finish(Date.now() - begun));
    socket.once("error", (err) => finish(err.code ?? "error"));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const vmBefore = keyedNumbers(read(join(proc, "vmstat")), " ");
const diskBefore = diskBytes();
const before = processSnapshot();
const windowStart = Date.now();
// The probes run inside the sampling window, so they add no wall time.
const [probeResults] = await Promise.all([
  probesOn ? Promise.all(PROBES.map(probe)) : Promise.resolve([]),
  sleep(windowMs),
]);
const after = processSnapshot();
const diskAfter = diskBytes();
const vmAfter = keyedNumbers(read(join(proc, "vmstat")), " ");
const elapsedMs = Date.now() - windowStart;
const meminfo = keyedNumbers(read(join(proc, "meminfo")), ":");

const deltas = [];
let ioDenied = 0;
for (const [pid, now] of after) {
  const then = before.get(pid);
  // The watchdog reports its own cost under `self`, not as a top process.
  if (!then || pid === process.pid) continue;
  const io =
    now.io && then.io
      ? {
          rchar: Math.max(0, now.io.rchar - then.io.rchar),
          rb: Math.max(0, now.io.rb - then.io.rb),
          wchar: Math.max(0, now.io.wchar - then.io.wchar),
          wb: Math.max(0, now.io.wb - then.io.wb),
        }
      : undefined;
  if (!io) ioDenied++;
  deltas.push({ pid, ...now, cpu: Math.max(0, now.ticks - then.ticks), io });
}

// Ranked by whichever path moved more: rchar sees page-cache and pipe reads,
// read_bytes sees block reads that rchar misses (mmap faults, readahead).
const ioScore = (d) => Math.max(d.io.rchar, d.io.rb) + Math.max(d.io.wchar, d.io.wb);
const topCpu = deltas
  .filter((d) => d.cpu > 0)
  .sort((a, b) => b.cpu - a.cpu)
  .slice(0, TOP_N);
const topIo = deltas
  .filter((d) => d.io && ioScore(d) > 0)
  .sort((a, b) => ioScore(b) - ioScore(a))
  .slice(0, TOP_N);

const rssCache = new Map();
const rss = (pid) => {
  if (!rssCache.has(pid)) rssCache.set(pid, rssKb(pid));
  return rssCache.get(pid);
};
const pct = (ticks) => Math.round((ticks / USER_HZ / (elapsedMs / 1000)) * 1000) / 10;

const record = {
  v: 1,
  t: new Date().toISOString(),
  win_ms: elapsedMs,
  psi: { cpu: pressure("cpu"), io: pressure("io"), mem: pressure("memory") },
  mem: {
    avail_kb: meminfo.get("MemAvailable") ?? null,
    swap_free_kb: meminfo.get("SwapFree") ?? null,
    pswpin: (vmAfter.get("pswpin") ?? 0) - (vmBefore.get("pswpin") ?? 0),
    pswpout: (vmAfter.get("pswpout") ?? 0) - (vmBefore.get("pswpout") ?? 0),
  },
  disk: { rd: diskAfter.rd - diskBefore.rd, wr: diskAfter.wr - diskBefore.wr },
  procs: after.size,
  io_denied: ioDenied,
  // [pid, ppid, comm, state, rss_kb, cpu_pct_of_one_core]
  cpu: topCpu.map((d) => [d.pid, d.ppid, d.comm, d.state, rss(d.pid), pct(d.cpu)]),
  // [pid, ppid, comm, state, rss_kb, rchar, read_bytes, wchar, write_bytes] (window deltas)
  io: topIo.map((d) => [
    d.pid,
    d.ppid,
    d.comm,
    d.state,
    rss(d.pid),
    d.io.rchar,
    d.io.rb,
    d.io.wchar,
    d.io.wb,
  ]),
  // ms to connect, or the failure ("timeout", "ECONNREFUSED", ...)
  probe: Object.fromEntries(probeResults),
};
// From the kernel's own accounting, so Node's startup cost is included.
const self = after.get(process.pid);
const selfStat = read(join(proc, "self", "stat"));
const selfTicks = selfStat
  ? selfStat
      .slice(selfStat.lastIndexOf(")") + 2)
      .split(" ")
      .slice(11, 13)
      .reduce((sum, value) => sum + Number(value), 0)
  : self?.ticks;
record.self = {
  cpu_ms: selfTicks === undefined ? null : Math.round((selfTicks * 1000) / USER_HZ),
  wall_ms: Date.now() - startedAt,
};

mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
