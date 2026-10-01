#!/usr/bin/env node
// Standalone service-log rotator (#580). systemd runs this from the per-instance
// `<unit>-logrotate.timer`, so the append-to-file `rusa.log` sink has a bound
// instead of growing until it is a disk-pressure source.
//
// Copy-then-truncate, never rename: the orchestrator unit opens the log with
// `StandardOutput=append:`, an O_APPEND descriptor the service holds for its
// whole life. Truncating keeps that descriptor on the active file, and O_APPEND
// puts the next write at the new end — no restart, no lost writable target.
// The cost is the usual copytruncate one: a line written in the instant between
// the copy and the truncate is lost.
//
// Deliberately STANDALONE + build-independent, like notify-failure.mjs: it must
// keep bounding the log when the rusa build is broken, which is when the log
// grows fastest.
//
// Only `<log>` and `<log>.<n>` are ever touched, so one instance's rotation
// cannot delete another instance's files.
//
// Usage: node rotate-log.mjs [log]
//   log:      the argument, else $RUSA_LOG_PATH, else $RUSA_HOME/logs/rusa.log
//             (RUSA_HOME default ~/.rusa). The installed unit always passes the
//             argument, so nothing in the instance .env can retarget it.
//   bound:    $RUSA_LOG_ROTATE_MAX_BYTES (default 52428800 = 50 MiB)
//   keep:     $RUSA_LOG_ROTATE_KEEP rotated generations (default 5; 0 = truncate only)
//   opt-out:  $RUSA_LOG_ROTATE=off

import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_KEEP = 5;

// A malformed override falls back to the default rather than disabling
// rotation: a typo in .env must not quietly reopen the unbounded-growth hole.
function nonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  console.error(`rotate-log: ignoring ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

if ((process.env.RUSA_LOG_ROTATE ?? "").trim().toLowerCase() === "off") {
  process.exit(0);
}

const home = process.env.RUSA_HOME || join(homedir(), ".rusa");
const logPath = process.argv[2] || process.env.RUSA_LOG_PATH || join(home, "logs", "rusa.log");
const maxBytes = nonNegativeInt("RUSA_LOG_ROTATE_MAX_BYTES", DEFAULT_MAX_BYTES);
const keep = nonNegativeInt("RUSA_LOG_ROTATE_KEEP", DEFAULT_KEEP);

if (!existsSync(logPath)) process.exit(0);
const size = statSync(logPath).size;
if (size === 0 || size < maxBytes) process.exit(0);

const generation = (n) => `${logPath}.${n}`;

// Drop every generation that would land past `keep` once the shift below runs,
// including any left behind by a previously larger retention count.
const dir = dirname(logPath);
const prefix = `${basename(logPath)}.`;
for (const entry of readdirSync(dir)) {
  if (!entry.startsWith(prefix)) continue;
  const suffix = entry.slice(prefix.length);
  if (/^\d+$/.test(suffix) && Number(suffix) >= keep && Number(suffix) >= 1) {
    rmSync(join(dir, entry), { force: true });
  }
}

for (let n = keep - 1; n >= 1; n--) {
  if (existsSync(generation(n))) renameSync(generation(n), generation(n + 1));
}
// copyFileSync carries the source's permission bits, so a rotated generation is
// never more readable than the live log.
if (keep >= 1) copyFileSync(logPath, generation(1));
truncateSync(logPath, 0);

console.log(`rotate-log: rotated ${logPath} at ${size} bytes (bound ${maxBytes}, keeping ${keep})`);
