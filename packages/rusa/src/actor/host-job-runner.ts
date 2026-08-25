import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildToolchainPath,
  ensureTargetParentDirs,
  realpathIfExists,
} from "../providers/sandbox.js";
import type { HostJobManifest } from "./host-job-store.js";

/**
 * Host-plane job runner : pure argv builders + thin spawn wrappers for the
 * grantable `host-jobs` capability. A job runs as a transient
 * `systemd-run --user --collect` unit (cgroup-scoped, so a deploy restart can't
 * orphan it the way `setsid` did in ISSUE_NUM) wrapping a `bwrap` invocation that
 * enforces the deny-by-default read-scope manifest. Kept argv-pure and
 * side-effect-free apart from the explicit `submit`/`stop`/`status` wrappers, so
 * every invocation shape is unit-testable without spawning anything.
 */

/** Generous-but-finite default: nothing may run truly unbounded (the flip side
 * of the ISSUE_NUM fix — cgroup-scoped survival across teardown must still end). */
export const DEFAULT_RUNTIME_MAX_SEC = 48 * 60 * 60; // 48h
/** Hard ceiling a submitter's own override cannot exceed. */
export const HARD_RUNTIME_MAX_SEC = 7 * 24 * 60 * 60; // 7d
/** Per-actor cap on simultaneously active (not-yet-exited) jobs. */
export const MAX_CONCURRENT_ACTIVE_JOBS_PER_ACTOR = 5;

const DEFAULT_CURL = "/usr/bin/curl";
export const WAKE_ON_EXIT_SCRIPT_NAME = "wake-on-exit.sh";

function isSelfOrAncestor(ancestor: string, target: string): boolean {
  return target === ancestor || target.startsWith(`${ancestor}/`);
}

function overlaps(a: string, b: string): boolean {
  return isSelfOrAncestor(a, b) || isSelfOrAncestor(b, a);
}

/**
 * Expand a leading `~` against `hostHome` before resolving. Node's `resolve()`
 * treats `~` as a literal directory name, not a home-dir shorthand — left
 * unexpanded, a manifest path like `~/.ssh` resolves relative to the process's
 * cwd instead of the real credential store, so whether it's denied (and which
 * denylist entry gets blamed in the message) depends on incidental cwd
 * placement rather than the path the submitter actually meant .
 */
function expandHome(path: string, hostHome: string): string {
  if (path === "~") return hostHome;
  if (path.startsWith("~/")) return join(hostHome, path.slice(2));
  return path;
}

/**
 * Absolute host paths a submitted job may NEVER read, no matter what the
 * submitter allow-lists (ISSUE_NUM hard requirement; expanded per cloudy-porpoise's
 * build-ack beyond the five originally named dirs to the real credential stores
 * that grant host/GitHub/npm write access). `mcHome` is included explicitly (not
 * just its usual `~/.rusa` location) so a non-default `RUSA_HOME`
 * still denies the mesh's own state/secrets root.
 */
export function hostJobDenylistDirs(hostHome: string, mcHome: string): string[] {
  return [
    join(hostHome, ".rusa"),
    join(hostHome, ".codex"),
    join(hostHome, ".claude"),
    join(hostHome, ".ssh"),
    join(hostHome, ".gnupg"),
    join(hostHome, ".config", "gh"),
    join(hostHome, ".npmrc"),
    join(hostHome, ".git-credentials"),
    mcHome,
  ];
}

/**
 * Reject any manifest path that IS or is an ANCESTOR of a denylisted
 * credential store — resolved through symlinks first so a submitter can't route
 * around the check with one, and checked in both directions so allow-listing
 * either a parent of a secret dir or a path inside one is caught. Throws on the
 * first violation; never logs the offending secret's contents, only the path.
 */
export function validateHostJobManifest(
  manifest: HostJobManifest,
  hostHome: string,
  mcHome: string
): void {
  const denylist = hostJobDenylistDirs(hostHome, mcHome).map(realpathIfExists);
  for (const raw of manifest.readPaths) {
    const resolved = realpathIfExists(resolve(expandHome(raw, hostHome)));
    const denied = denylist.find((d) => overlaps(resolved, d));
    if (denied) {
      throw new Error(
        `host-jobs manifest: "${raw}" is denied (overlaps credential store ${denied}) — ` +
          "host-jobs never grants ambient credential access, even by explicit allow-list"
      );
    }
  }
}

/**
 * Clamp a submitter-requested `RuntimeMaxSec` to the hard ceiling; `undefined`
 * gets the generous 48h default. Rejects non-positive/non-finite input outright
 * rather than silently clamping it, so a caller bug (e.g. `0` or `NaN`) surfaces
 * immediately instead of quietly becoming "no timeout".
 */
export function resolveRuntimeMaxSec(requestedSec: number | undefined): number {
  if (requestedSec === undefined) return DEFAULT_RUNTIME_MAX_SEC;
  if (!Number.isFinite(requestedSec) || requestedSec <= 0) {
    throw new Error(`host-jobs: runtimeMaxSec must be a positive number, got ${requestedSec}`);
  }
  return Math.min(requestedSec, HARD_RUNTIME_MAX_SEC);
}

/** Write the job's inline script text to its scratch dir, mode 0700. */
export function writeHostJobScript(scratchDir: string, script: string): string {
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const scriptPath = join(scratchDir, "run.sh");
  writeFileSync(scriptPath, script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700); // enforce even if the file pre-existed with looser bits
  return scriptPath;
}

function getHostHomeDir(): string {
  return process.env.HOME ?? "/root";
}

export interface BuildHostJobBwrapArgsOptions {
  /** Real host `$HOME` — the tree shadowed to empty before any punch-through. */
  hostHome?: string;
  /** The mesh's own state/secrets root — shadowed even if outside `hostHome`. */
  mcHome: string;
  /** The job's own writable workspace (holds `run.sh` and any output). */
  scratchDir: string;
  manifest: HostJobManifest;
  /** PATH inside the unit — default resolves the same toolchain workers get. */
  toolchainPath?: string;
}

/**
 * Deny-by-default bwrap argv for one host job: shadow-then-punch-holes, the
 * same pattern the legacy `buildBwrapArgs` uses for `isolationRoot` (see
 * `providers/sandbox.ts`). Broad `--ro-bind / /` keeps the base OS/toolchain
 * visible so the script can actually execute; `--tmpfs` immediately wipes the
 * real `$HOME` (and `mcHome`, if it lives elsewhere) to empty; only the job's
 * own scratch dir and each validated manifest path are punched back through.
 * `--clearenv` + explicit `--setenv` means no ambient env (API keys/tokens)
 * leaks into the unit. Validates the manifest before building any argv — a
 * denied path never makes it into a bind flag.
 */
export function buildHostJobBwrapArgs(o: BuildHostJobBwrapArgsOptions): string[] {
  const hostHome = o.hostHome ?? getHostHomeDir();
  validateHostJobManifest(o.manifest, hostHome, o.mcHome);

  const args: string[] = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];

  // Shadow the real home to empty — the deny-by-default gate. Also shadow
  // mcHome explicitly in case it's configured outside hostHome (a non-default
  // RUSA_HOME), so the mesh's own secrets root is never merely "usually"
  // hidden. Mounting a tmpfs inside an already-shadowed tree is a harmless
  // no-op (still empty), so no ordering/overlap check is needed here.
  const realHostHome = realpathIfExists(hostHome);
  const realMcHome = realpathIfExists(o.mcHome);
  args.push("--tmpfs", hostHome);
  if (!overlaps(realHostHome, realMcHome)) args.push("--tmpfs", o.mcHome);
  args.push("--tmpfs", "/tmp");

  // The job's own writable scratch dir, punched back through the shadow.
  // bwrap does not auto-vivify a bind target's parents under a fresh tmpfs
  // (ISSUE_NUM-class failure), so ensureTargetParentDirs runs first — every time,
  // unconditionally, matching how sandbox.ts already does this for its own
  // shadowed binds (pnpmStore under isolationRoot).
  const realScratchDir = realpathIfExists(o.scratchDir);
  ensureTargetParentDirs(args, realScratchDir);
  args.push("--bind", realScratchDir, realScratchDir);

  // Each validated manifest path, read-only, punched back through the shadow.
  for (const raw of o.manifest.readPaths) {
    const path = realpathIfExists(resolve(expandHome(raw, hostHome)));
    ensureTargetParentDirs(args, path);
    args.push("--ro-bind", path, path);
  }

  args.push("--clearenv");
  args.push("--setenv", "HOME", realScratchDir);
  args.push("--setenv", "PATH", o.toolchainPath ?? buildToolchainPath());
  args.push("--setenv", "TMPDIR", "/tmp");
  args.push("--setenv", "TMP", "/tmp");
  args.push("--setenv", "TEMP", "/tmp");
  args.push("--chdir", realScratchDir);

  return args;
}

export interface BuildSystemdRunArgvOptions {
  /** Host-job store id minted with the unit; passed to ExecStopPost for attribution. */
  jobId: string;
  /** `job-<handle>-<shortid>` — server-generated, never client-supplied. */
  unitName: string;
  scratchDir: string;
  runtimeMaxSec: number;
  /** Absolute path to the installed `wake-on-exit.sh` (see below). */
  wakeOnExitScriptPath: string;
  /** The submitting actor's id — passed to ExecStopPost so it knows who to wake. */
  submitterActorId: string;
  bwrapArgs: string[];
  scriptPath: string;
  scriptArgs: string[];
}

/**
 * The exact `systemd-run --user --collect` invocation wrapping `bwrap`.
 * ExecStopPost receives the literal server-generated job id and unit name, so
 * attribution never depends on systemd specifier expansion inside --property.
 * `--collect` releases the unit's metadata once it's stopped+garbage-collected
 * instead of leaking a `failed` unit forever. `ExecStopPost` (not an in-script
 * trap) fires unconditionally on every stop — clean exit, non-zero exit,
 * OOM-kill, or a `stop_job`-triggered SIGTERM — matching the "monitoring parity
 * with launch" requirement; a trap cannot survive SIGKILL.
 */
export function buildSystemdRunArgv(o: BuildSystemdRunArgvOptions): string[] {
  return [
    "systemd-run",
    "--user",
    "--collect",
    `--unit=${o.unitName}`,
    `--property=WorkingDirectory=${o.scratchDir}`,
    `--property=RuntimeMaxSec=${o.runtimeMaxSec}`,
    `--property=ExecStopPost=${o.wakeOnExitScriptPath} ${o.jobId} ${o.unitName} ${o.submitterActorId}`,
    "--",
    "bwrap",
    ...o.bwrapArgs,
    "--",
    "/bin/sh",
    o.scriptPath,
    ...o.scriptArgs,
  ];
}

/** Launch a job's `systemd-run` unit. Throws (never swallows) on a non-zero exit. */
export function spawnHostJob(argv: string[]): void {
  execFileSync(argv[0], argv.slice(1), { stdio: "ignore" });
}

/**
 * Stop a job's unit by its (already ownership-checked) unit name. `--no-block`
 * returns as soon as the stop job is enqueued (SIGTERM issued) instead of
 * waiting for the full stop transaction — which includes `ExecStopPost`'s HTTP
 * round trip to `/host-jobs/exit` — to finish; without it, a slow-but-successful
 * stop can outlast the RPC's own tool-call timeout and report as failed .
 * The unit still stops and `ExecStopPost` still fires, just asynchronously.
 */
export function stopHostJobUnit(unitName: string): void {
  execFileSync("systemctl", ["--user", "stop", "--no-block", unitName], { stdio: "ignore" });
}

/** One-line `ActiveState/SubState/Result` summary for `job_status`. */
export function queryHostJobUnitStatus(unitName: string): string {
  try {
    return execFileSync(
      "systemctl",
      ["--user", "show", unitName, "-p", "ActiveState", "-p", "SubState", "-p", "Result"],
      { encoding: "utf-8" }
    ).trim();
  } catch (err) {
    return `query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const wakeOnExitScriptPath = (mcHome: string): string =>
  join(mcHome, "host-jobs", WAKE_ON_EXIT_SCRIPT_NAME);

export interface WakeOnExitScriptOptions {
  tokenFile: string;
  portFile: string;
  curlPath?: string;
}

/**
 * The `ExecStopPost` script content: reads the unit's real exit info via
 * `systemctl --user show`, then POSTs it to the additive `/host-jobs/exit`
 * endpoint (same bearer token as `/wake` — one host-side secret file, see
 * `wake-cron.ts`). `--retry` absorbs the brief window where the orchestrator
 * itself is mid-deploy-restart. Never fails the unit's stop sequence — the
 * final curl is best-effort (`|| true`), since a lost wake is recoverable
 * (`job_status` still reflects the real systemd state) but a stuck ExecStopPost
 * would wedge unit teardown.
 */
export function buildWakeOnExitScript(o: WakeOnExitScriptOptions): string {
  const curl = o.curlPath ?? DEFAULT_CURL;
  return `#!/bin/sh
set -eu
# Arg-count guard: units submitted before this deploy carry the legacy 2-arg
# ExecStopPost (\`<script> %n <actorId>\` — %n never expands inside --property,
# see buildSystemdRunArgv). They survive the rusa restart and fire against
# this newer script, so a bare ACTOR_ID="$3" would trip \`set -u\` and abort the
# exit hook silently — no wake, no host_job_exited ledger event. Fall back to the
# 2-arg shape (empty jobId → server matches by unitName) so the exit is still
# attributed and recorded rather than dropped.
if [ "$#" -ge 3 ]; then
  JOB_ID="$1"
  UNIT="$2"
  ACTOR_ID="$3"
else
  JOB_ID=""
  UNIT="$1"
  ACTOR_ID="$2"
fi
RESULT=$(systemctl --user show "$UNIT" -p Result --value 2>/dev/null || echo unknown)
EXIT_STATUS=$(systemctl --user show "$UNIT" -p ExecMainStatus --value 2>/dev/null || echo unknown)
PORT=$(cat "${o.portFile}")
TOKEN=$(cat "${o.tokenFile}")
${curl} -fsS --retry 5 --retry-delay 2 \\
  -H "Authorization: Bearer $TOKEN" \\
  "http://127.0.0.1:$PORT/host-jobs/exit" \\
  -d "jobId=$JOB_ID" \\
  -d "unitName=$UNIT" \\
  -d "actorId=$ACTOR_ID" \\
  -d "result=$RESULT" \\
  -d "exitStatus=$EXIT_STATUS" \\
  >/dev/null 2>&1 || true
`;
}

/** Idempotently (re)install the wake-on-exit script at its fixed mcHome path. */
export function ensureWakeOnExitScript(mcHome: string, o: WakeOnExitScriptOptions): string {
  const path = wakeOnExitScriptPath(mcHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildWakeOnExitScript(o), { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
