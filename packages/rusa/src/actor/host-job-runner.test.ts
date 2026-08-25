import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostJobBwrapArgs,
  buildSystemdRunArgv,
  buildWakeOnExitScript,
  DEFAULT_RUNTIME_MAX_SEC,
  ensureWakeOnExitScript,
  HARD_RUNTIME_MAX_SEC,
  hostJobDenylistDirs,
  resolveRuntimeMaxSec,
  validateHostJobManifest,
  wakeOnExitScriptPath,
  writeHostJobScript,
} from "./host-job-runner.js";

/**
 * A runner can have the `bwrap` binary on PATH yet lack unprivileged user
 * namespace capability (some CI/container setups) — `which bwrap` alone would
 * pass and then flake red on every real invocation. Probe the actual
 * capability with a trivial sandboxed invocation so a namespace-less runner
 * skips this describe cleanly instead of red-flaking, while a capable one
 * (the normal case — GH-hosted ubuntu-latest included) still runs the real
 * assertions ack item 3 exists for.
 */
function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

describe("hostJobDenylistDirs (ISSUE_NUM, expanded credential stores)", () => {
  it("includes the real credential stores beyond the five originally named dirs", () => {
    const dirs = hostJobDenylistDirs("/home/familiar", "/home/familiar/.rusa");
    expect(dirs).toContain("/home/familiar/.rusa");
    expect(dirs).toContain("/home/familiar/.codex");
    expect(dirs).toContain("/home/familiar/.claude");
    expect(dirs).toContain("/home/familiar/.ssh");
    expect(dirs).toContain("/home/familiar/.gnupg");
    expect(dirs).toContain("/home/familiar/.config/gh");
    expect(dirs).toContain("/home/familiar/.npmrc");
    expect(dirs).toContain("/home/familiar/.git-credentials");
  });

  it("always includes mcHome itself, even when configured outside hostHome", () => {
    const dirs = hostJobDenylistDirs("/home/familiar", "/var/lib/rusa-home");
    expect(dirs).toContain("/var/lib/rusa-home");
  });
});

describe("validateHostJobManifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-job-manifest-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows a manifest path outside every denylisted store", () => {
    const allowed = join(dir, "workspace");
    mkdirSync(allowed);
    expect(() =>
      validateHostJobManifest({ readPaths: [allowed] }, join(dir, "home"), join(dir, "mc"))
    ).not.toThrow();
  });

  it("denies a manifest path that IS a credential store", () => {
    const hostHome = join(dir, "home");
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    expect(() =>
      validateHostJobManifest({ readPaths: [join(hostHome, ".ssh")] }, hostHome, join(dir, "mc"))
    ).toThrow(/denied/);
  });

  it("denies a manifest path INSIDE a credential store", () => {
    const hostHome = join(dir, "home");
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    writeFileSync(join(hostHome, ".ssh", "id_rsa"), "secret");
    expect(() =>
      validateHostJobManifest(
        { readPaths: [join(hostHome, ".ssh", "id_rsa")] },
        hostHome,
        join(dir, "mc")
      )
    ).toThrow(/denied/);
  });

  it("denies a manifest path that is an ANCESTOR of a credential store (bidirectional check)", () => {
    const hostHome = join(dir, "home");
    mkdirSync(hostHome, { recursive: true });
    expect(() =>
      validateHostJobManifest({ readPaths: [hostHome] }, hostHome, join(dir, "mc"))
    ).toThrow(/denied/);
  });

  it("denies mcHome itself and any path inside it (e.g. the wake token)", () => {
    const hostHome = join(dir, "home");
    const mcHome = join(dir, "mc");
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(mcHome, { recursive: true });
    writeFileSync(join(mcHome, "wake-token"), "topsecret");
    expect(() =>
      validateHostJobManifest({ readPaths: [join(mcHome, "wake-token")] }, hostHome, mcHome)
    ).toThrow(/denied/);
  });

  it("resolves symlinks before checking, so a symlink cannot route around the denylist", () => {
    const hostHome = join(dir, "home");
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    const linkPath = join(dir, "innocuous-looking-link");
    symlinkSync(join(hostHome, ".ssh"), linkPath);
    expect(() =>
      validateHostJobManifest({ readPaths: [linkPath] }, hostHome, join(dir, "mc"))
    ).toThrow(/denied/);
  });

  it("expands a leading ~ against hostHome so a ~/.ssh manifest path is denied and blamed on .ssh itself, not mcHome or cwd ", () => {
    const hostHome = join(dir, "home");
    const mcHome = join(dir, "mc");
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    mkdirSync(mcHome, { recursive: true });

    let thrown: Error | undefined;
    try {
      validateHostJobManifest({ readPaths: ["~/.ssh"] }, hostHome, mcHome);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain(join(hostHome, ".ssh"));
    expect(thrown?.message).not.toContain(mcHome);
  });
});

describe("resolveRuntimeMaxSec", () => {
  it("defaults to the generous-but-finite 48h backstop when unset", () => {
    expect(resolveRuntimeMaxSec(undefined)).toBe(DEFAULT_RUNTIME_MAX_SEC);
  });

  it("passes a requested value through under the hard ceiling", () => {
    expect(resolveRuntimeMaxSec(3600)).toBe(3600);
  });

  it("clamps a requested value above the hard ceiling", () => {
    expect(resolveRuntimeMaxSec(HARD_RUNTIME_MAX_SEC * 10)).toBe(HARD_RUNTIME_MAX_SEC);
  });

  it("rejects non-positive or non-finite requests instead of silently clamping", () => {
    expect(() => resolveRuntimeMaxSec(0)).toThrow();
    expect(() => resolveRuntimeMaxSec(-1)).toThrow();
    expect(() => resolveRuntimeMaxSec(Number.NaN)).toThrow();
    expect(() => resolveRuntimeMaxSec(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("buildHostJobBwrapArgs (pure argv)", () => {
  let dir: string;
  let hostHome: string;
  let mcHome: string;
  let scratchDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-job-bwrap-argv-test-"));
    hostHome = join(dir, "home");
    mcHome = join(dir, "mc");
    scratchDir = join(dir, "scratch");
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(mcHome, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws instead of building any argv for a denied manifest path", () => {
    expect(() =>
      buildHostJobBwrapArgs({
        hostHome,
        mcHome,
        scratchDir,
        manifest: { readPaths: [join(hostHome, ".ssh")] },
      })
    ).toThrow(/denied/);
  });

  it("shadows both hostHome and a non-nested mcHome, clears the ambient env, and pins HOME/PATH", () => {
    const args = buildHostJobBwrapArgs({
      hostHome,
      mcHome,
      scratchDir,
      manifest: { readPaths: [] },
    });
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--clearenv");

    const tmpfsIndexes = args.reduce<number[]>((acc, arg, i) => {
      if (arg === "--tmpfs") acc.push(i);
      return acc;
    }, []);
    const tmpfsTargets = tmpfsIndexes.map((i) => args[i + 1]);
    expect(tmpfsTargets).toContain(hostHome);
    expect(tmpfsTargets).toContain(mcHome);

    const homeIndex = args.indexOf("HOME");
    expect(args[homeIndex - 1]).toBe("--setenv");
    expect(args[homeIndex + 1]).toBe(scratchDir);
  });

  it("does not double-shadow mcHome when it is nested inside hostHome", () => {
    const nestedMcHome = join(hostHome, ".rusa");
    mkdirSync(nestedMcHome, { recursive: true });
    const args = buildHostJobBwrapArgs({
      hostHome,
      mcHome: nestedMcHome,
      scratchDir,
      manifest: { readPaths: [] },
    });
    const tmpfsTargets = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--tmpfs") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(tmpfsTargets).toContain(hostHome);
    expect(tmpfsTargets).not.toContain(nestedMcHome);
  });

  it("ensures parent dirs before every bind onto the shadowed tree (the ISSUE_NUM-class fix)", () => {
    const allowed = join(dir, "allowed", "nested", "data");
    mkdirSync(allowed, { recursive: true });
    const args = buildHostJobBwrapArgs({
      hostHome,
      mcHome,
      scratchDir,
      manifest: { readPaths: [allowed] },
    });
    const roBindIndex = args.lastIndexOf("--ro-bind");
    expect(args[roBindIndex + 1]).toBe(allowed);
    expect(args[roBindIndex + 2]).toBe(allowed);
    // Every ancestor of `allowed` must have a --dir push before the --ro-bind.
    const dirTargets = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--dir") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(dirTargets).toContain(join(dir, "allowed"));
    expect(dirTargets).toContain(join(dir, "allowed", "nested"));
  });
});

describe("buildSystemdRunArgv (pure argv)", () => {
  it("wraps bwrap with --collect, RuntimeMaxSec, and an ExecStopPost carrying literal job/unit ids", () => {
    const argv = buildSystemdRunArgv({
      jobId: "job-id-1",
      unitName: "job-handle-a-12345678",
      scratchDir: "/tmp/scratch",
      runtimeMaxSec: 3600,
      wakeOnExitScriptPath: "/home/familiar/.rusa/host-jobs/wake-on-exit.sh",
      submitterActorId: "actor-a",
      bwrapArgs: ["--unshare-all"],
      scriptPath: "/tmp/scratch/run.sh",
      scriptArgs: ["foo", "bar"],
    });

    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--user");
    expect(argv).toContain("--collect");
    expect(argv).toContain("--unit=job-handle-a-12345678");
    expect(argv).toContain("--property=WorkingDirectory=/tmp/scratch");
    expect(argv).toContain("--property=RuntimeMaxSec=3600");
    expect(argv).toContain(
      "--property=ExecStopPost=/home/familiar/.rusa/host-jobs/wake-on-exit.sh job-id-1 job-handle-a-12345678 actor-a"
    );
    expect(argv.join("\n")).not.toContain("%n");

    const bwrapIndex = argv.indexOf("bwrap");
    expect(bwrapIndex).toBeGreaterThan(-1);
    expect(argv[bwrapIndex + 1]).toBe("--unshare-all");

    const tail = argv.slice(-4);
    expect(tail).toEqual(["/bin/sh", "/tmp/scratch/run.sh", "foo", "bar"]);
  });
});

describe("writeHostJobScript", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-job-script-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the script mode 0700 under the scratch dir", () => {
    const scratchDir = join(dir, "scratch");
    const path = writeHostJobScript(scratchDir, "#!/bin/sh\necho hi\n");
    expect(path).toBe(join(scratchDir, "run.sh"));
    const mode = execFileSync("stat", ["-c", "%a", path], { encoding: "utf-8" }).trim();
    expect(mode).toBe("700");
  });
});

describe("wake-on-exit script", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-job-wake-exit-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds a script that posts jobId/unitName/actorId/result/exitStatus to /host-jobs/exit", () => {
    const script = buildWakeOnExitScript({
      tokenFile: "/home/familiar/.rusa/wake-token",
      portFile: "/home/familiar/.rusa/wake-port",
    });
    expect(script).toContain("#!/bin/sh");
    expect(script).toContain('JOB_ID="$1"');
    expect(script).toContain('UNIT="$2"');
    expect(script).toContain('ACTOR_ID="$3"');
    expect(script).toContain("http://127.0.0.1:$PORT/host-jobs/exit");
    expect(script).toContain("--retry 5");
    expect(script).toContain('-d "jobId=$JOB_ID"');
    expect(script).toContain('-d "unitName=$UNIT"');
    expect(script).toContain('-d "actorId=$ACTOR_ID"');
    expect(script).toContain("|| true");
    expect(script).toContain('cat "/home/familiar/.rusa/wake-token"');
    expect(script).toContain('cat "/home/familiar/.rusa/wake-port"');
  });

  // Behavioral regression for the ISSUE_NUM fix-forward: run the generated script
  // under /bin/sh with a stubbed curl and assert the exit is POSTed, not dropped.
  function runWakeScript(args: string[]): { curlArgs: string } {
    const curlLog = join(dir, "curl-args.txt");
    const fakeCurl = join(dir, "fake-curl.sh");
    // Record every arg on its own line so `-d "k=v"` pairs are asserted verbatim.
    writeFileSync(
      fakeCurl,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${curlLog}"\n`,
      {
        mode: 0o700,
      }
    );
    const tokenFile = join(dir, "wake-token");
    const portFile = join(dir, "wake-port");
    writeFileSync(tokenFile, "bearer-secret");
    writeFileSync(portFile, "8080");
    const scriptPath = join(dir, "wake-on-exit.sh");
    writeFileSync(scriptPath, buildWakeOnExitScript({ tokenFile, portFile, curlPath: fakeCurl }), {
      mode: 0o700,
    });
    // execFileSync throws on a non-zero exit — i.e. this line failing IS the
    // "script aborted under set -u" assertion.
    execFileSync("/bin/sh", [scriptPath, ...args], { stdio: "ignore" });
    return { curlArgs: readFileSync(curlLog, "utf-8") };
  }

  it("legacy 2-arg ExecStopPost (pre-deploy unit) still posts the exit instead of aborting under set -u", () => {
    // A unit submitted before this deploy carries the old 2-arg ExecStopPost
    // `<script> %n <actorId>` (%n never expands inside --property). It survives
    // the rusa restart and fires against this newer fixed-path script, so
    // `$3` is unset. A bare ACTOR_ID="$3" would trip `set -u` and drop the exit
    // silently — no wake, no host_job_exited ledger event (worse than the old
    // unattributed event). The arg-count guard must fall back to the 2-arg shape.
    const { curlArgs } = runWakeScript(["%n", "actor-a"]);
    expect(curlArgs).toContain("actorId=actor-a");
    expect(curlArgs).toContain("unitName=%n"); // literal %n → server matches by unit name
    expect(curlArgs).toContain("jobId="); // empty jobId → server treats as absent, no bad match
  });

  it("modern 3-arg ExecStopPost maps jobId/unit/actorId positionally", () => {
    const { curlArgs } = runWakeScript(["job-abc-123", "job-handle-abc", "actor-b"]);
    expect(curlArgs).toContain("jobId=job-abc-123");
    expect(curlArgs).toContain("unitName=job-handle-abc");
    expect(curlArgs).toContain("actorId=actor-b");
  });

  it("installs the script idempotently at its fixed mcHome path, mode 0700", () => {
    const path = ensureWakeOnExitScript(dir, {
      tokenFile: join(dir, "wake-token"),
      portFile: join(dir, "wake-port"),
    });
    expect(path).toBe(wakeOnExitScriptPath(dir));
    const mode = execFileSync("stat", ["-c", "%a", path], { encoding: "utf-8" }).trim();
    expect(mode).toBe("700");
    // Re-install must not fail on an already-existing file/dir.
    expect(() =>
      ensureWakeOnExitScript(dir, {
        tokenFile: join(dir, "wake-token"),
        portFile: join(dir, "wake-port"),
      })
    ).not.toThrow();
  });
});

/**
 * ack item 3 (cloudy-porpoise's build-ack on ISSUE_NUM): one REAL bwrap integration
 * test, not just argv assertions. A `--ro-bind` dest that can't be created under
 * the `--tmpfs` home hard-fails at RUNTIME and argv-only tests miss it entirely
 * (ISSUE_NUM repeat) — so this spawns the actual built invocation and reads real
 * bwrap's real answer for each path, rather than trusting the argv shape.
 *
 * Also covers ack item 4: the wake bearer token file lives under mcHome, which
 * this sandbox shadows — a job can never read its own wake credential.
 *
 * Gated on `BWRAP_CAPABLE` (a real trivial-sandbox probe, not `which bwrap`)
 * so a runner with the binary but no unprivileged-userns capability skips
 * cleanly instead of red-flaking — never an unconditional skip, or item 3's
 * whole guarantee goes silently unverified.
 */
describe.skipIf(!BWRAP_CAPABLE)("buildHostJobBwrapArgs + real bwrap (ack item 3 + 4)", () => {
  let dir: string;
  let hostHome: string;
  let mcHome: string;
  let scratchDir: string;
  let allowedDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-job-real-bwrap-test-"));
    hostHome = join(dir, "home");
    mcHome = join(dir, "mc");
    scratchDir = join(dir, "scratch");
    allowedDir = join(dir, "allowed");

    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    writeFileSync(join(hostHome, ".ssh", "id_rsa"), "ssh-secret");
    writeFileSync(join(hostHome, "plain.txt"), "unlisted-but-not-secret");

    mkdirSync(mcHome, { recursive: true });
    writeFileSync(join(mcHome, "wake-token"), "wake-bearer-secret");

    mkdirSync(scratchDir, { recursive: true });

    mkdirSync(allowedDir, { recursive: true });
    writeFileSync(join(allowedDir, "data.txt"), "ALLOWED_CONTENT");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("can read an allow-listed path but not the shadowed $HOME nor the denylisted wake token", () => {
    const args = buildHostJobBwrapArgs({
      hostHome,
      mcHome,
      scratchDir,
      manifest: { readPaths: [allowedDir] },
    });

    const probe = [
      `test -r "${join(allowedDir, "data.txt")}" && echo ALLOWED_READABLE || echo ALLOWED_DENIED`,
      `test -r "${join(hostHome, "plain.txt")}" && echo HOME_READABLE || echo HOME_DENIED`,
      `test -r "${join(hostHome, ".ssh", "id_rsa")}" && echo SSH_READABLE || echo SSH_DENIED`,
      `test -r "${join(mcHome, "wake-token")}" && echo WAKE_TOKEN_READABLE || echo WAKE_TOKEN_DENIED`,
    ].join("\n");

    const output = execFileSync("bwrap", [...args, "--", "/bin/sh", "-c", probe], {
      encoding: "utf-8",
    });

    expect(output).toContain("ALLOWED_READABLE");
    expect(output).toContain("HOME_DENIED");
    expect(output).toContain("SSH_DENIED");
    expect(output).toContain("WAKE_TOKEN_DENIED");
    expect(output).not.toContain("ALLOWED_DENIED");
    expect(output).not.toContain("HOME_READABLE");
    expect(output).not.toContain("SSH_READABLE");
    expect(output).not.toContain("WAKE_TOKEN_READABLE");
  });

  it("can actually cat the content of an allow-listed manifest path", () => {
    const args = buildHostJobBwrapArgs({
      hostHome,
      mcHome,
      scratchDir,
      manifest: { readPaths: [allowedDir] },
    });
    const output = execFileSync(
      "bwrap",
      [...args, "--", "/bin/sh", "-c", `cat "${join(allowedDir, "data.txt")}"`],
      { encoding: "utf-8" }
    );
    expect(output.trim()).toBe("ALLOWED_CONTENT");
  });

  it("can write into its own scratch dir (the job's real workspace)", () => {
    const args = buildHostJobBwrapArgs({
      hostHome,
      mcHome,
      scratchDir,
      manifest: { readPaths: [] },
    });
    execFileSync(
      "bwrap",
      [...args, "--", "/bin/sh", "-c", 'echo scratch-write-ok > "$HOME/out.txt"'],
      { encoding: "utf-8" }
    );
    const written = execFileSync("cat", [join(scratchDir, "out.txt")], { encoding: "utf-8" });
    expect(written.trim()).toBe("scratch-write-ok");
  });
});
