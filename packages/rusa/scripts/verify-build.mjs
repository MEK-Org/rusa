#!/usr/bin/env node
// Boot-time build gate (ISSUE_NUM, elder fix #4). Run as the service unit's
// ExecStartPre: it refuses to let the daemon start unless the freshly-built dist
// matches the checkout's current HEAD — so a partial dist left by a SIGTERM'd
// `update` build never boots (a loud, alerted refusal instead of a corrupt run).
//
// Deliberately STANDALONE + build-independent (pure Node + git, ZERO import of the
// built dist), because its whole job is to run when the build may be broken.
//
// Usage: node verify-build.mjs <checkoutRoot>
//   exit 0 → dist matches HEAD (boot allowed); exit 1 → refuse boot (reason on stderr).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const checkoutRoot = process.argv[2];
if (!checkoutRoot) {
  console.error("verify-build: usage: verify-build.mjs <checkoutRoot>");
  process.exit(2);
}

const sentinelPath = join(checkoutRoot, "packages", "rusa", "dist", ".build-ok");

function headSha() {
  return execFileSync("git", ["-C", checkoutRoot, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
}

try {
  const head = headSha();
  let built;
  try {
    built = readFileSync(sentinelPath, "utf-8").trim();
  } catch {
    console.error(
      `verify-build: REFUSING boot — no build-complete sentinel at ${sentinelPath} ` +
        "(build missing or interrupted). Run the update tool to rebuild."
    );
    process.exit(1);
  }
  if (built !== head) {
    console.error(
      `verify-build: REFUSING boot — built sha ${built.slice(0, 7)} != checkout HEAD ${head.slice(0, 7)}.`
    );
    process.exit(1);
  }
  console.error(`verify-build: OK — dist matches HEAD ${head.slice(0, 7)}.`);
  process.exit(0);
} catch (err) {
  // If we can't even compute HEAD, fail open WITH a loud signal rather than
  // bricking the box on an unrelated git hiccup — a missing sentinel still blocks
  // above; this only handles "git rev-parse failed" (e.g. transient FS issue).
  console.error(`verify-build: could not verify (${err.message}); allowing boot.`);
  process.exit(0);
}
