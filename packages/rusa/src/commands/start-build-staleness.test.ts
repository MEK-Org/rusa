import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error start.mjs is a pre-build Node script outside the TS source tree.
const startScript = await import("../../scripts/start.mjs");

const {
  buildIfStale,
  getBuildState,
  getInstallState,
  parseStartArgs,
}: {
  buildIfStale: (opts: {
    skipBuild?: boolean;
    getState?: () => { stale: boolean; stampMtimeMs: number | null };
    getInstallState?: () => {
      nodeModulesExists: boolean;
      submoduleChanged: boolean;
      stale: boolean;
    };
    install?: () => Promise<void>;
    writeInstallStamp?: () => void;
    runBuild?: () => Promise<void>;
    writeStamp?: () => void;
    log?: () => void;
  }) => Promise<{ built: boolean; skipped: boolean }>;
  getBuildState: (opts: { root: string; sourceRoots: string[]; stampPath: string }) => {
    stale: boolean;
    stampMtimeMs: number | null;
  };
  getInstallState: (opts: {
    root: string;
    installSources: string[];
    stampPath: string;
    getSubmoduleSha?: (root: string) => string;
  }) => {
    nodeModulesExists: boolean;
    submoduleChanged: boolean;
    stale: boolean;
  };
  parseStartArgs: (argv: string[]) => { skipBuild: boolean; forwardedArgs: string[] };
} = startScript;

const tmpRoots: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rusa-start-stale-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  return root;
}

function writeAt(path: string, mtimeSeconds: number): void {
  writeFileSync(path, path, "utf8");
  const time = new Date(mtimeSeconds * 1000);
  utimesSync(path, time, time);
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pnpm start build staleness", () => {
  it("rebuilds when a source is newer than the build stamp", async () => {
    const root = tempRepo();
    const source = join(root, "src", "cli.ts");
    const stamp = join(root, "dist", ".build-ok");
    writeAt(stamp, 100);
    writeAt(source, 200);

    const state = getBuildState({ root, sourceRoots: ["src"], stampPath: stamp });
    const install = vi.fn(async () => {});
    const writeInstallStamp = vi.fn();
    const runBuild = vi.fn(async () => {});
    const writeStamp = vi.fn();

    expect(state.stale).toBe(true);
    await expect(
      buildIfStale({
        getState: () => state,
        getInstallState: () => ({
          nodeModulesExists: true,
          submoduleChanged: false,
          stale: false,
          sourceFiles: [],
          newestSourceMtimeMs: 0,
          stampMtimeMs: 0,
        }),
        install,
        writeInstallStamp,
        runBuild,
        writeStamp,
        log: () => {},
      })
    ).resolves.toEqual({ built: true, skipped: false });
    expect(install).not.toHaveBeenCalled();
    expect(writeInstallStamp).not.toHaveBeenCalled();
    expect(runBuild).toHaveBeenCalledOnce();
    expect(writeStamp).toHaveBeenCalledOnce();
  });

  it("skips rebuild when the build stamp is newer than sources", async () => {
    const root = tempRepo();
    const source = join(root, "src", "cli.ts");
    const stamp = join(root, "dist", ".build-ok");
    writeAt(source, 100);
    writeAt(stamp, 200);

    const state = getBuildState({ root, sourceRoots: ["src"], stampPath: stamp });
    const runBuild = vi.fn(async () => {});
    const writeStamp = vi.fn();
    const writeInstallStamp = vi.fn();

    expect(state.stale).toBe(false);
    await expect(
      buildIfStale({
        getState: () => state,
        getInstallState: () => ({
          nodeModulesExists: true,
          submoduleChanged: false,
          stale: false,
          sourceFiles: [],
          newestSourceMtimeMs: 0,
          stampMtimeMs: 0,
        }),
        writeInstallStamp,
        runBuild,
        writeStamp,
        log: () => {},
      })
    ).resolves.toEqual({ built: false, skipped: false });
    expect(writeInstallStamp).not.toHaveBeenCalled();
    expect(runBuild).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  it("bypasses the staleness check and rebuild when --skip-build is set", async () => {
    const getState = vi.fn(() => ({ stale: true, stampMtimeMs: null }));
    const runBuild = vi.fn(async () => {});

    await expect(
      buildIfStale({
        skipBuild: true,
        getState,
        runBuild,
        writeStamp: () => {},
        log: () => {},
      })
    ).resolves.toEqual({ built: false, skipped: true });

    expect(getState).not.toHaveBeenCalled();
    expect(runBuild).not.toHaveBeenCalled();
    expect(parseStartArgs(["quickstart", "--", "--skip-build", "--image", "local"])).toEqual({
      skipBuild: true,
      forwardedArgs: ["quickstart", "--image", "local"],
    });
  });

  it("runs install and build when node_modules is missing (fresh clone)", async () => {
    const install = vi.fn(async () => {});
    const writeInstallStamp = vi.fn();
    const runBuild = vi.fn(async () => {});
    const writeStamp = vi.fn();

    const getInstallStateMock = vi.fn(() => ({
      nodeModulesExists: false,
      submoduleChanged: false,
      stale: true,
    }));
    const getStateMock = vi.fn(() => ({
      stale: true,
      stampMtimeMs: null,
    }));

    await expect(
      buildIfStale({
        getInstallState: getInstallStateMock,
        getState: getStateMock,
        install,
        writeInstallStamp,
        runBuild,
        writeStamp,
        log: () => {},
      })
    ).resolves.toEqual({ built: true, skipped: false });

    expect(getInstallStateMock).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(writeInstallStamp).toHaveBeenCalledOnce();
    expect(getStateMock).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledOnce();
    expect(writeStamp).toHaveBeenCalledOnce();
  });

  it("runs install and build when dependencies have changed since the install stamp", async () => {
    const install = vi.fn(async () => {});
    const writeInstallStamp = vi.fn();
    const runBuild = vi.fn(async () => {});
    const writeStamp = vi.fn();

    const getInstallStateMock = vi.fn(() => ({
      nodeModulesExists: true,
      submoduleChanged: false,
      stale: true,
    }));
    const getStateMock = vi.fn(() => ({
      stale: true,
      stampMtimeMs: 12345,
    }));

    await expect(
      buildIfStale({
        getInstallState: getInstallStateMock,
        getState: getStateMock,
        install,
        writeInstallStamp,
        runBuild,
        writeStamp,
        log: () => {},
      })
    ).resolves.toEqual({ built: true, skipped: false });

    expect(getInstallStateMock).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(writeInstallStamp).toHaveBeenCalledOnce();
    expect(getStateMock).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledOnce();
    expect(writeStamp).toHaveBeenCalledOnce();
  });

  it("skips install but runs build when only a source file changed", async () => {
    const install = vi.fn(async () => {});
    const writeInstallStamp = vi.fn();
    const runBuild = vi.fn(async () => {});
    const writeStamp = vi.fn();

    const getInstallStateMock = vi.fn(() => ({
      nodeModulesExists: true,
      submoduleChanged: false,
      stale: false,
    }));
    const getStateMock = vi.fn(() => ({
      stale: true,
      stampMtimeMs: 12345,
    }));

    await expect(
      buildIfStale({
        getInstallState: getInstallStateMock,
        getState: getStateMock,
        install,
        writeInstallStamp,
        runBuild,
        writeStamp,
        log: () => {},
      })
    ).resolves.toEqual({ built: true, skipped: false });

    expect(getInstallStateMock).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(writeInstallStamp).not.toHaveBeenCalled();
    expect(getStateMock).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledOnce();
    expect(writeStamp).toHaveBeenCalledOnce();
  });

  it("skips both install and build when nothing has changed", async () => {
    const install = vi.fn(async () => {});
    const writeInstallStamp = vi.fn();
    const runBuild = vi.fn(async () => {});
    const writeStamp = vi.fn();

    const getInstallStateMock = vi.fn(() => ({
      nodeModulesExists: true,
      submoduleChanged: false,
      stale: false,
    }));
    const getStateMock = vi.fn(() => ({
      stale: false,
      stampMtimeMs: 12345,
    }));

    await expect(
      buildIfStale({
        getInstallState: getInstallStateMock,
        getState: getStateMock,
        install,
        writeInstallStamp,
        runBuild,
        writeStamp,
        log: () => {},
      })
    ).resolves.toEqual({ built: false, skipped: false });

    expect(getInstallStateMock).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(writeInstallStamp).not.toHaveBeenCalled();
    expect(getStateMock).toHaveBeenCalledOnce();
    expect(runBuild).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  it("getInstallState detects missing node_modules", () => {
    const root = tempRepo();
    const stampPath = join(root, "dist", ".install-ok");
    const state = getInstallState({ root, installSources: ["package.json"], stampPath });
    expect(state.nodeModulesExists).toBe(false);
    expect(state.stale).toBe(true);
  });

  it("getInstallState detects package.json changed since install stamp", () => {
    const root = tempRepo();
    const stampPath = join(root, "dist", ".install-ok");
    mkdirSync(join(root, "node_modules"), { recursive: true });

    writeAt(stampPath, 100);
    writeAt(join(root, "package.json"), 200);

    const state = getInstallState({ root, installSources: ["package.json"], stampPath });
    expect(state.nodeModulesExists).toBe(true);
    expect(state.stale).toBe(true);
  });

  it("getInstallState detects submodule state changed since install stamp", () => {
    const root = tempRepo();
    const stampPath = join(root, "dist", ".install-ok");
    mkdirSync(join(root, "node_modules"), { recursive: true });

    writeFileSync(stampPath, "old-submodule-sha\n", "utf8");
    writeAt(join(root, "package.json"), 50);

    const getSubmoduleSha = () => "new-submodule-sha";

    const state = getInstallState({
      root,
      installSources: ["package.json"],
      stampPath,
      getSubmoduleSha,
    });
    expect(state.submoduleChanged).toBe(true);
    expect(state.stale).toBe(true);
  });
});
