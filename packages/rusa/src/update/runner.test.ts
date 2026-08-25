import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSentinelPath, readBuildSentinel, verifyBuildSentinel } from "./build-sentinel.js";
import {
  assertSubmodulesMaterialized,
  BuildRunner,
  runTimedStep,
  submodulePathsFromGitmodules,
} from "./runner.js";

const SHA = "1111111111111111111111111111111111111111";
const OLD_SHA = "0000000000000000000000000000000000000000";

/** A fake ChildProcess. `behavior` decides how/whether it ends. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = undefined; // undefined → runTimedStep skips real process.kill on timeout
  kill() {
    return true;
  }
}

type SpawnOpts = { env?: NodeJS.ProcessEnv };

/**
 * Build a fake `spawn` that, per call, either closes with a code or hangs forever.
 * `codes`: exit code for each successive call; `hang: true` → never closes.
 * `onStep` fires for each SUCCESSFUL step (lets a test simulate the build writing
 * its output into the staging dir from `opts.env.RUSA_DIST_DIR`).
 */
function fakeSpawn(opts: {
  codes?: number[];
  hang?: boolean;
  stderr?: string;
  onStep?: (args: string[], spawnOpts: SpawnOpts) => void;
}) {
  let call = 0;
  const children: FakeChild[] = [];
  const fn = ((_cmd: string, args: string[], spawnOpts: SpawnOpts) => {
    const child = new FakeChild();
    children.push(child);
    const i = call++;
    const code = opts.codes?.[i] ?? 0;
    if (!opts.hang) {
      if (code === 0) opts.onStep?.(args, spawnOpts);
      queueMicrotask(() => {
        if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
        child.emit("close", code);
      });
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { fn, children };
}

describe("runTimedStep — hard timeout (elder fix #2: a hung build can't wedge root)", () => {
  it("rejects with timedOut after the deadline when the step hangs", async () => {
    const { fn } = fakeSpawn({ hang: true });
    await expect(
      runTimedStep("build", "pnpm", ["run", "build"], {
        cwd: "/x",
        timeoutMs: 20,
        spawnImpl: fn,
      })
    ).rejects.toMatchObject({ name: "StepError", step: "build", timedOut: true });
  });

  it("resolves on a clean exit(0)", async () => {
    const { fn } = fakeSpawn({ codes: [0] });
    await expect(
      runTimedStep("install", "pnpm", ["install"], { cwd: "/x", timeoutMs: 5000, spawnImpl: fn })
    ).resolves.toBeUndefined();
  });

  it("rejects (not timedOut) on a non-zero exit, with the stderr tail", async () => {
    const { fn } = fakeSpawn({ codes: [1], stderr: "boom: it broke\n" });
    await expect(
      runTimedStep("build", "pnpm", ["run", "build"], { cwd: "/x", timeoutMs: 5000, spawnImpl: fn })
    ).rejects.toMatchObject({ name: "StepError", timedOut: false });
  });
});

describe("GitRunner submodule materialization checks", () => {
  it("enumerates submodule paths from .gitmodules", () => {
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(
      join(repo, ".gitmodules"),
      [
        '[submodule "third_party/glass_goals"]',
        "\tpath = third_party/glass_goals",
        "\turl = https://github.com/dummy-org/glass_goals.git",
        "",
      ].join("\n")
    );

    expect(submodulePathsFromGitmodules(join(repo, ".gitmodules"))).toEqual([
      "third_party/glass_goals",
    ]);
  });

  it("fails loudly at pull when a registered submodule dir is empty after init", () => {
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    const submodulePath = "third_party/glass_goals";
    writeFileSync(
      join(repo, ".gitmodules"),
      `[submodule "glass_goals"]\n\tpath = ${submodulePath}\n`
    );
    mkdirSync(join(repo, submodulePath), { recursive: true });

    expect(() => assertSubmodulesMaterialized(repo)).toThrowError(
      expect.objectContaining({
        name: "StepError",
        step: "pull",
      })
    );
    expect(() => assertSubmodulesMaterialized(repo)).toThrow(
      /git submodule update --init --recursive/
    );
  });
});

describe("BuildRunner — staging + atomic swap (elder require #1: failed build = no-op on live)", () => {
  const timeouts = { installMs: 5000, buildMs: 5000 };

  /** A package dir with a populated live `dist/` (the current good build + sentinel). */
  function pkgWithLiveDist(liveSha: string): { pkgDir: string; dist: string } {
    const pkgDir = mkdtempSync(join(tmpdir(), "pkg-"));
    const dist = join(pkgDir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "cli.js"), `built@${liveSha}`);
    writeFileSync(buildSentinelPath(dist), `${liveSha}\n`);
    return { pkgDir, dist };
  }

  it("GREEN: builds into staging and atomically cuts over (dist + sentinel reflect new sha)", async () => {
    const { pkgDir, dist } = pkgWithLiveDist(OLD_SHA);
    // The build step writes its output into the staging dir (RUSA_DIST_DIR).
    const { fn } = fakeSpawn({
      codes: [0, 0, 0],
      onStep: (args, spawnOpts) => {
        if (args.includes("build")) {
          const staging = spawnOpts.env?.RUSA_DIST_DIR as string;
          mkdirSync(staging, { recursive: true });
          writeFileSync(join(staging, "cli.js"), `built@${SHA}`);
        }
      },
    });
    await new BuildRunner(pkgDir, timeouts, () => {}, "pnpm", fn).build(SHA);

    // Live dist now holds the NEW build + a matching sentinel — atomically.
    expect(readFileSync(join(dist, "cli.js"), "utf8")).toBe(`built@${SHA}`);
    expect(readBuildSentinel(dist)).toBe(SHA);
    expect(verifyBuildSentinel(dist, SHA).ok).toBe(true);
    // Previous build retained at dist.old.
    expect(readFileSync(join(`${dist}.old`, "cli.js"), "utf8")).toBe(`built@${OLD_SHA}`);
  });

  it("FAILED build: live dist + sentinel are BYTE-IDENTICAL (never touched), staging discarded", async () => {
    const { pkgDir, dist } = pkgWithLiveDist(OLD_SHA);
    const before = {
      cli: readFileSync(join(dist, "cli.js"), "utf8"),
      sentinel: readFileSync(buildSentinelPath(dist), "utf8"),
    };
    // install ok, typecheck ok, build FAILS.
    const { fn } = fakeSpawn({ codes: [0, 0, 1] });
    await expect(
      new BuildRunner(pkgDir, timeouts, () => {}, "pnpm", fn).build(SHA)
    ).rejects.toMatchObject({ name: "StepError", step: "build" });

    // The whole point: live state is untouched — still the OLD good build, boot-safe.
    expect(readFileSync(join(dist, "cli.js"), "utf8")).toBe(before.cli);
    expect(readFileSync(buildSentinelPath(dist), "utf8")).toBe(before.sentinel);
    expect(verifyBuildSentinel(dist, OLD_SHA).ok).toBe(true); // still passes the boot gate
    expect(readBuildSentinel(dist)).toBe(OLD_SHA); // NOT cleared (no decoupling window)
  });

  it("HUNG build: live dist + sentinel untouched (no-op on live state)", async () => {
    const { pkgDir, dist } = pkgWithLiveDist(OLD_SHA);
    // install ok, typecheck ok, build HANGS → timeout → abort.
    let call = 0;
    const { fn } = (() => {
      const inner = fakeSpawn({ codes: [0, 0], hang: false });
      // Wrap: first two steps close(0), third hangs.
      const wrapped = ((cmd: string, args: string[], o: SpawnOpts) => {
        if (call++ === 2) return fakeSpawn({ hang: true }).fn(cmd, args, o);
        return inner.fn(cmd, args, o);
      }) as unknown as typeof import("node:child_process").spawn;
      return { fn: wrapped };
    })();
    await expect(
      new BuildRunner(pkgDir, { installMs: 5000, buildMs: 20 }, () => {}, "pnpm", fn).build(SHA)
    ).rejects.toMatchObject({ name: "StepError", timedOut: true });
    expect(readBuildSentinel(dist)).toBe(OLD_SHA); // live untouched
    expect(verifyBuildSentinel(dist, OLD_SHA).ok).toBe(true);
  });
});
