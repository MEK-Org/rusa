import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2E_RUNS_DIR_NAME } from "../e2e/provision.js";
import { teardownFlutterOverlay } from "../providers/sandbox.js";
import { E2E_INSTANCE_UNIT_NAME, E2EInstanceManager } from "./e2e-instance-manager.js";

describe("E2EInstanceManager", () => {
  let root = "";
  let workersDir = "";
  let mcHome = "";
  let actorWorktree = "";
  let flutterRoot = "";
  let claudeExecutable = "";
  let active = false;
  let stopFails = false;
  let calls: Array<{ file: string; args: string[] }> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e2e-instance-manager-"));
    workersDir = join(root, "workers");
    mcHome = join(root, "mc-home");
    actorWorktree = join(workersDir, "actor-a", "rusa");
    flutterRoot = join(root, "flutter");
    claudeExecutable = join(root, "provider-tools", "claude");
    mkdirSync(join(actorWorktree, "packages", "rusa", "scripts"), { recursive: true });
    mkdirSync(mcHome, { recursive: true });
    mkdirSync(join(flutterRoot, "bin"), { recursive: true });
    mkdirSync(dirname(claudeExecutable), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(actorWorktree, "package.json"),
      `${JSON.stringify({ packageManager: "pnpm@10.29.3" })}\n`
    );
    writeFileSync(join(actorWorktree, "packages", "rusa", "scripts", "e2e.mjs"), "");
    writeFileSync(join(mcHome, "config.yaml"), "providers: {}\n");
    writeFileSync(claudeExecutable, "");
    active = false;
    stopFails = false;
    calls = [];
  });

  afterEach(() => {
    teardownFlutterOverlay(join(mcHome, "e2e-instance", "runtime"));
    rmSync(root, { recursive: true, force: true });
  });

  const manager = () =>
    new E2EInstanceManager({
      mcHome,
      workersDir,
      hostHome: root,
      toolchainPath: "/toolchain/bin",
      corepackPath: "/toolchain/bin/corepack",
      flutterRoot,
      providerExecutables: { claude: claudeExecutable },
      isPortReady: async () => true,
      delay: async () => {},
      handleForId: (id) => `handle-${id}`,
      now: () => "2026-08-08T00:00:00.000Z",
      exec: (file, args) => {
        calls.push({ file, args });
        if (file === "systemd-run") {
          active = true;
          return "";
        }
        if (file === "systemctl" && args.includes("stop")) {
          if (stopFails) throw new Error("systemctl unavailable");
          active = false;
          return "";
        }
        return [
          "LoadState=loaded",
          `ActiveState=${active ? "active" : "inactive"}`,
          `SubState=${active ? "running" : "dead"}`,
          "Result=success",
        ].join("\n");
      },
    });

  it("rejects a second up with the holder identity and three teardown paths", async () => {
    const subject = manager();
    const flutterToolState = join(
      actorWorktree,
      "packages",
      "rusa",
      "flutter_dashboard",
      ".dart_tool"
    );
    mkdirSync(flutterToolState, { recursive: true });
    writeFileSync(join(flutterToolState, "package_config.json"), "stale private cache path");
    await subject.up("actor-a", actorWorktree);

    await expect(subject.up("actor-b", join(workersDir, "actor-b"))).rejects.toThrow(
      /already held by handle-actor-a \(actor-a\).+down\/stop.+retired.+mesh shuts down/
    );

    const launch = calls.find((call) => call.file === "systemd-run");
    expect(calls.slice(1, 4)).toEqual([
      {
        file: "git",
        args: ["-C", actorWorktree, "submodule", "update", "--init", "--recursive"],
      },
      {
        file: "/toolchain/bin/corepack",
        args: ["pnpm@10.29.3", "--dir", actorWorktree, "install"],
      },
      {
        file: "/toolchain/bin/corepack",
        args: [
          "pnpm@10.29.3",
          "--dir",
          actorWorktree,
          "--filter",
          "./packages/rusa",
          "run",
          "build:dashboard-ui",
        ],
      },
    ]);
    expect(launch?.args).toContain(`--unit=${E2E_INSTANCE_UNIT_NAME}`);
    expect(launch?.args).toContain("--property=Restart=always");
    const usedShim = launch?.args.includes("/tmp/flutter-wrapper");
    if (!usedShim) {
      expect(launch?.args).toEqual(
        expect.arrayContaining([
          "--bind",
          join(mcHome, "e2e-instance", "runtime", ".flutter_mnt"),
          "/tmp/flutter-sdk",
        ])
      );
    } else {
      expect(launch?.args).toEqual(expect.arrayContaining(["--dir", "/tmp/flutter-wrapper"]));
      expect(launch?.args).toEqual(expect.arrayContaining(["--dir", "/tmp/flutter-wrapper/bin"]));
      expect(launch?.args).toEqual(
        expect.arrayContaining([
          "--ro-bind",
          join(mcHome, "e2e-instance", "runtime", ".flutter_fail"),
          "/tmp/flutter-wrapper/bin/flutter",
        ])
      );
    }
    const privatePubCache = join(mcHome, "e2e-instance", "runtime", "pub-cache");
    expect(
      launch?.args.some(
        (arg, index) => arg === "--ro-bind" && launch.args[index + 1] === privatePubCache
      )
    ).toBe(false);
    expect(launch?.args).toEqual(
      expect.arrayContaining(["--setenv", "PUB_CACHE", privatePubCache])
    );
    expect(launch?.args).toEqual(
      expect.arrayContaining([
        "--setenv",
        "PATH",
        `${join(mcHome, "e2e-instance", "runtime", "provider-bin")}:${!usedShim ? "/tmp/flutter-sdk/bin" : "/tmp/flutter-wrapper/bin"}:/toolchain/bin`,
      ])
    );
    const runtimeHome = join(mcHome, "e2e-instance", "runtime", "home");
    expect(launch?.args).toEqual(
      expect.arrayContaining(["--bind", join(root, ".claude"), join(runtimeHome, ".claude")])
    );
    expect(launch?.args).toEqual(
      expect.arrayContaining(["--ro-bind", join(root, ".codex"), join(runtimeHome, ".codex")])
    );
    expect(launch?.args).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        claudeExecutable,
        join(mcHome, "e2e-instance", "runtime", "provider-bin", "claude"),
      ])
    );
    expect(launch?.args).not.toEqual(
      expect.arrayContaining([expect.stringContaining("RuntimeMaxSec")])
    );
    expect(launch?.args.slice(-9)).toEqual([
      "pnpm",
      "run",
      "e2e",
      "am-up",
      "--root-driver",
      "external",
      "--base-config-home",
      join(mcHome, "e2e-instance", "runtime", "base-config"),
      "--watch",
    ]);
    expect(launch?.args.join(" ")).not.toMatch(/\.ssh|\.config\/gh|auth\.json|token\.json/);
    expect(existsSync(flutterToolState)).toBe(false);
    if (launch?.args.includes("/run/user")) {
      expect(launch.args).toEqual(expect.arrayContaining(["--tmpfs", "/run/user"]));
    }
  });

  it("fails before package installation when a plain clone cannot initialize submodules", async () => {
    const subject = new E2EInstanceManager({
      mcHome,
      workersDir,
      hostHome: root,
      toolchainPath: "/toolchain/bin",
      corepackPath: "/toolchain/bin/corepack",
      flutterRoot,
      providerExecutables: {},
      handleForId: (id) => `handle-${id}`,
      exec: (file, args) => {
        calls.push({ file, args });
        if (file === "git") throw new Error("submodule checkout exited 1");
        return "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=none";
      },
    });

    await expect(subject.up("actor-a", actorWorktree)).rejects.toThrow(
      /submodule setup failed.+submodule checkout exited 1/
    );
    expect(calls.some((call) => call.file === "/toolchain/bin/corepack")).toBe(false);
    expect(calls.some((call) => call.file === "systemd-run")).toBe(false);
  });

  it("loudly rejects a worktree outside the calling actor's own workdir", async () => {
    const foreign = join(root, "foreign", "rusa");
    mkdirSync(join(foreign, "packages", "rusa", "scripts"), { recursive: true });
    writeFileSync(join(foreign, "package.json"), "{}\n");
    writeFileSync(join(foreign, "packages", "rusa", "scripts", "e2e.mjs"), "");

    await expect(manager().up("actor-a", foreign)).rejects.toThrow(
      /REFUSED foreign path.+calling actor actor-a's own workdir/
    );
    expect(calls.some((call) => call.file === "systemd-run")).toBe(false);
  });

  it("fails loudly without starting the unit when the dashboard build fails", async () => {
    const subject = new E2EInstanceManager({
      mcHome,
      workersDir,
      hostHome: root,
      toolchainPath: "/toolchain/bin",
      corepackPath: "/toolchain/bin/corepack",
      flutterRoot,
      providerExecutables: {},
      handleForId: (id) => `handle-${id}`,
      exec: (file, args) => {
        calls.push({ file, args });
        if (file === "/toolchain/bin/corepack" && args.includes("build:dashboard-ui")) {
          throw new Error("flutter build exited 1");
        }
        return "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=none";
      },
    });

    await expect(subject.up("actor-a", actorWorktree)).rejects.toThrow(
      /dashboard build failed.+flutter build exited 1/
    );
    expect(calls.some((call) => call.file === "systemd-run")).toBe(false);
  });

  it("does not report success when the unit dies before opening port 8083", async () => {
    let launched = false;
    let statusReadsAfterLaunch = 0;
    const subject = new E2EInstanceManager({
      mcHome,
      workersDir,
      hostHome: root,
      toolchainPath: "/toolchain/bin",
      corepackPath: "/toolchain/bin/corepack",
      flutterRoot,
      providerExecutables: {},
      startupTimeoutMs: 1_000,
      startupPollMs: 0,
      isPortReady: async () => false,
      delay: async () => {},
      handleForId: (id) => `handle-${id}`,
      exec: (file, args) => {
        calls.push({ file, args });
        if (file === "systemd-run") {
          launched = true;
          return "";
        }
        if (file === "systemctl" && args.includes("stop")) return "";
        if (!launched) {
          return "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=none";
        }
        statusReadsAfterLaunch += 1;
        return statusReadsAfterLaunch === 1
          ? "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success"
          : "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code";
      },
    });

    await expect(subject.up("actor-a", actorWorktree)).rejects.toThrow(
      /failed before port 8083 became ready.+result=exit-code/
    );
    expect(existsSync(join(mcHome, "e2e-instance.json"))).toBe(false);
  });

  it("stops only when the retiring actor holds the singleton", async () => {
    const subject = manager();
    await subject.up("actor-a", actorWorktree);
    subject.stopForActorRetirement("actor-b");
    expect(active).toBe(true);

    subject.stopForActorRetirement("actor-a");
    expect(active).toBe(false);
    expect(calls.some((call) => call.file === "systemctl" && call.args.includes("stop"))).toBe(
      true
    );
  });

  it("preserves holder attribution when systemd refuses a stop", async () => {
    const subject = manager();
    await subject.up("actor-a", actorWorktree);
    stopFails = true;

    expect(() => subject.down("actor-a")).toThrow("systemctl unavailable");
    await expect(subject.up("actor-b", join(workersDir, "actor-b"))).rejects.toThrow(
      /already held by handle-actor-a \(actor-a\)/
    );
  });

  it("rejects re-up after an external stop leaves holder+runtime intact, then rebuilds Claude mount targets once the holder brings it down", async () => {
    writeFileSync(join(root, ".claude.json"), '{"marker":"file-v1"}\n');
    const subject = manager();
    const stateFile = join(mcHome, "e2e-instance.json");
    const runtimeDir = join(mcHome, "e2e-instance", "runtime");
    const claudeJsonTarget = join(runtimeDir, "home", ".claude.json");

    await subject.up("actor-a", actorWorktree);
    expect(statSync(claudeJsonTarget).isFile()).toBe(true);
    const recordBefore = readFileSync(stateFile, "utf8");

    // The incident: the transient unit is stopped outside down() (host
    // restart, an operator's `systemctl stop`, a crash) while the holder
    // record and runtime directory survive untouched.
    active = false;

    const callsBeforeReUp = calls.length;
    await expect(subject.up("actor-b", join(workersDir, "actor-b"))).rejects.toThrow(
      /already held by handle-actor-a \(actor-a\).+down\/stop.+retired.+mesh shuts down/
    );
    // Rejected before any worktree preparation or relaunch attempt.
    expect(calls.slice(callsBeforeReUp).some((call) => call.file === "git")).toBe(false);
    expect(calls.slice(callsBeforeReUp).some((call) => call.file === "systemd-run")).toBe(false);
    // The preserved holder record and runtime were not mutated by the refusal.
    expect(readFileSync(stateFile, "utf8")).toBe(recordBefore);
    expect(statSync(claudeJsonTarget).isFile()).toBe(true);

    // Only the holder can bring the dead unit state down.
    subject.down("actor-a");
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);

    // The host's Claude state is now a differently-shaped path (a directory
    // instead of a file). A fresh up() must build a mount target that
    // matches this current shape, not reuse anything from the prior run.
    rmSync(join(root, ".claude.json"), { force: true });
    mkdirSync(join(root, ".claude.json"), { recursive: true });

    await subject.up("actor-a", actorWorktree);
    expect(statSync(claudeJsonTarget).isDirectory()).toBe(true);
  });

  it("clears a recordless orphan runtime before rebuilding mount targets, instead of reusing a stale shape", async () => {
    writeFileSync(join(root, ".claude.json"), '{"marker":"file"}\n');
    const subject = manager();
    const runtimeDir = join(mcHome, "e2e-instance", "runtime");
    const claudeJsonTarget = join(runtimeDir, "home", ".claude.json");

    // No holder record and no live unit, but a leftover runtime tree whose
    // Claude mount target is a stale directory even though the current host
    // source is a plain file (e.g. state stranded by a crash before this
    // manager could persist its own holder record).
    mkdirSync(claudeJsonTarget, { recursive: true });
    expect(statSync(claudeJsonTarget).isDirectory()).toBe(true);

    await subject.up("actor-a", actorWorktree);

    expect(statSync(claudeJsonTarget).isFile()).toBe(true);
  describe("resume", () => {
    const writeResumableRoot = (): string => {
      const resumeRoot = join(root, E2E_RUNS_DIR_NAME, "run-preserved");
      mkdirSync(join(resumeRoot, "home", "data"), { recursive: true });
      writeFileSync(join(resumeRoot, "home", "config.yaml"), "providers: {}\n");
      writeFileSync(join(resumeRoot, "home", "data", "mesh.db"), "");
      mkdirSync(join(resumeRoot, "remote", "repo.git"), { recursive: true });
      writeFileSync(join(resumeRoot, "remote", "repo.git", "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(resumeRoot, "scratch", ".git"), { recursive: true });
      writeFileSync(join(resumeRoot, "gitconfig"), "[user]\n");
      return resumeRoot;
    };

    it("resumes a preserved holder's root with explicit --root/--resume and reuses its worktree unmodified", async () => {
      const subject = manager();
      await subject.up("actor-a", actorWorktree);
      active = false; // externally stopped: the holder record survives, unlike down()
      const resumeRoot = writeResumableRoot();
      const callsBeforeResume = calls.length;

      const status = await subject.resume("actor-a", resumeRoot);

      expect(status.state).toBe("up");
      expect(status.holder).toEqual({
        actorId: "actor-a",
        actorHandle: "handle-actor-a",
        worktree: actorWorktree,
        unitName: E2E_INSTANCE_UNIT_NAME,
        startedAt: "2026-08-08T00:00:00.000Z",
      });
      // Resume must not re-run submodule/install/build against the reused worktree.
      expect(
        calls
          .slice(callsBeforeResume)
          .some((call) => call.file === "git" || call.file === "/toolchain/bin/corepack")
      ).toBe(false);

      const launches = calls.filter((call) => call.file === "systemd-run");
      expect(launches).toHaveLength(2);
      const resumeLaunch = launches[1];
      expect(resumeLaunch.args).toEqual(expect.arrayContaining(["--bind", resumeRoot, resumeRoot]));
      const tail = resumeLaunch.args.slice(-12);
      expect(tail).toEqual([
        "pnpm",
        "run",
        "e2e",
        "am-up",
        "--root",
        resumeRoot,
        "--resume",
        "--root-driver",
        "external",
        "--base-config-home",
        join(mcHome, "e2e-instance", "runtime", "base-config"),
        "--watch",
      ]);
    });

    it("rejects resume from a caller who is not the recorded holder", async () => {
      const subject = manager();
      await subject.up("actor-a", actorWorktree);
      active = false;
      const resumeRoot = writeResumableRoot();

      await expect(subject.resume("actor-b", resumeRoot)).rejects.toThrow(
        /held by handle-actor-a \(actor-a\); only the holder may resume/
      );
      expect(calls.filter((call) => call.file === "systemd-run")).toHaveLength(1);
    });

    it("rejects a resume root outside the helper-owned e2e runs area", async () => {
      const subject = manager();
      await subject.up("actor-a", actorWorktree);
      active = false;
      writeResumableRoot(); // ensures the runs area itself exists on disk
      const foreignRoot = join(root, "elsewhere", "run-x");
      mkdirSync(join(foreignRoot, "home", "data"), { recursive: true });
      writeFileSync(join(foreignRoot, "home", "config.yaml"), "providers: {}\n");
      writeFileSync(join(foreignRoot, "home", "data", "mesh.db"), "");
      mkdirSync(join(foreignRoot, "remote", "repo.git"), { recursive: true });
      writeFileSync(join(foreignRoot, "remote", "repo.git", "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(foreignRoot, "scratch", ".git"), { recursive: true });
      writeFileSync(join(foreignRoot, "gitconfig"), "[user]\n");

      await expect(subject.resume("actor-a", foreignRoot)).rejects.toThrow(
        /REFUSED foreign resume root/
      );
      expect(calls.filter((call) => call.file === "systemd-run")).toHaveLength(1);
    });

    it("rejects a root that is not structurally a resumable e2e instance", async () => {
      const subject = manager();
      await subject.up("actor-a", actorWorktree);
      active = false;
      const incompleteRoot = join(root, E2E_RUNS_DIR_NAME, "run-incomplete");
      mkdirSync(incompleteRoot, { recursive: true });

      await expect(subject.resume("actor-a", incompleteRoot)).rejects.toThrow(
        /is not a resumable e2e root \(missing/
      );
      expect(calls.filter((call) => call.file === "systemd-run")).toHaveLength(1);
    });

    it("rejects resume while the singleton is currently live", async () => {
      const subject = manager();
      await subject.up("actor-a", actorWorktree);
      const resumeRoot = writeResumableRoot();

      await expect(subject.resume("actor-a", resumeRoot)).rejects.toThrow(
        /already held by handle-actor-a \(actor-a\).+down\/stop.+retired.+mesh shuts down/
      );
      expect(calls.filter((call) => call.file === "systemd-run")).toHaveLength(1);
    });

    it("rejects resume when no preserved holder record exists", async () => {
      const subject = manager();
      const resumeRoot = writeResumableRoot();

      await expect(subject.resume("actor-a", resumeRoot)).rejects.toThrow(
        /no preserved holder record to resume/
      );
    });

    it("restores the pre-resume holder record when the resumed unit fails to open the port", async () => {
      let nowValue = "2026-08-08T00:00:00.000Z";
      const subject = new E2EInstanceManager({
        mcHome,
        workersDir,
        hostHome: root,
        toolchainPath: "/toolchain/bin",
        corepackPath: "/toolchain/bin/corepack",
        flutterRoot,
        providerExecutables: { claude: claudeExecutable },
        startupTimeoutMs: 1_000,
        startupPollMs: 0,
        isPortReady: async () => true,
        delay: async () => {},
        handleForId: (id) => `handle-${id}`,
        now: () => nowValue,
        exec: (file, args) => {
          calls.push({ file, args });
          if (file === "systemd-run") {
            active = true;
            return "";
          }
          if (file === "systemctl" && args.includes("stop")) {
            active = false;
            return "";
          }
          if (calls.filter((call) => call.file === "systemd-run").length >= 2) {
            return "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code";
          }
          return [
            "LoadState=loaded",
            `ActiveState=${active ? "active" : "inactive"}`,
            `SubState=${active ? "running" : "dead"}`,
            "Result=success",
          ].join("\n");
        },
      });
      await subject.up("actor-a", actorWorktree);
      active = false;
      const resumeRoot = writeResumableRoot();
      nowValue = "2026-08-08T01:00:00.000Z";

      await expect(subject.resume("actor-a", resumeRoot)).rejects.toThrow(
        /failed before port 8083 became ready/
      );

      // The failed resume's own record (startedAt 01:00:00) must not stick;
      // the original up() record (00:00:00) is restored so the preserved
      // root's attribution survives to be retried.
      expect(subject.status().holder).toEqual({
        actorId: "actor-a",
        actorHandle: "handle-actor-a",
        worktree: actorWorktree,
        unitName: E2E_INSTANCE_UNIT_NAME,
        startedAt: "2026-08-08T00:00:00.000Z",
      });
    });
  });
});
