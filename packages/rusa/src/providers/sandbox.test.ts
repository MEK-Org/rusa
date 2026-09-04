import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();

function expectSetenv(args: string[], name: string, value: string) {
  const index = args.indexOf(name);
  expect(index).toBeGreaterThan(-1);
  expect(args[index - 1]).toBe("--setenv");
  expect(args[index + 1]).toBe(value);
}

function defaultExecSyncResponse(command: string): string | null {
  if (command === "which node") return "/usr/local/fnm/node\n";
  if (command === "which corepack") return "/usr/local/fnm/corepack\n";
  if (command === "which pnpm") return "/usr/local/fnm/pnpm\n";
  return null;
}

const mockLoadConfig = vi.fn().mockReturnValue({
  github: { account: "test" },
  providers: {},
  webhook: { port: 9742, secret: "secret" },
  gitBridge: false,
});

vi.mock("../config/loader.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
  default: {
    execSync: execSyncMock,
    execFileSync: execFileSyncMock,
  },
}));

vi.mock("node:fs", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const actualFs = require("node:fs");
  const mockExistsSync = (path: import("node:fs").PathLike) => {
    const p = String(path);
    if (p === "/usr/bin/fuse-overlayfs" || p === "/dev/fuse") {
      return process.env.MOCK_FUSE === "1";
    }
    if (p.endsWith(".flutter_mnt/bin/flutter") && process.env.MOCK_FUSE === "1") {
      return true;
    }
    return actualFs.existsSync(path);
  };
  return {
    ...actualFs,
    default: {
      ...actualFs,
      existsSync: mockExistsSync,
    },
    existsSync: mockExistsSync,
  };
});

describe("sandbox bwrap args", () => {
  const originalExecPath = process.execPath;
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalNodeAuthToken = process.env.NODE_AUTH_TOKEN;
  const originalStampSecret = process.env.STAMP_SECRET;
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReset();
    execSyncMock.mockReset();
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalNodeAuthToken === undefined) {
      delete process.env.NODE_AUTH_TOKEN;
    } else {
      process.env.NODE_AUTH_TOKEN = originalNodeAuthToken;
    }
    if (originalStampSecret === undefined) {
      delete process.env.STAMP_SECRET;
    } else {
      process.env.STAMP_SECRET = originalStampSecret;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when bwrap is required but unavailable", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const { assertBwrapAvailable } = await import("./sandbox.js");

    expect(() => assertBwrapAvailable()).toThrow(
      /bubblewrap \(bwrap\) is required but not installed/
    );
    expect(execFileSyncMock).toHaveBeenCalledWith("bwrap", ["--version"], { stdio: "pipe" });
  });

  it("fails loudly when bwrap is present but login shell check fails", async () => {
    execFileSyncMock.mockImplementation((file: string, args: string[]) => {
      if (file === "bwrap" && args[0] === "--version") {
        return "bubblewrap 0.8.0\n";
      }
      throw new Error("login shell failed to resolve node");
    });

    const { assertBwrapAvailable } = await import("./sandbox.js");

    expect(() => assertBwrapAvailable()).toThrow(
      /Bubblewrap sandbox health check failed: node or pnpm is not available inside a login shell/
    );
  });

  it("sets KIMI_CODE_HOME=/tmp/kimi-home, ro-binds config, and binds the real host credentials/ + oauth/ dirs writable for kimi (buildActorBwrapArgs)", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-kimi-mesh-home-"));
    tempDirs.push(home);
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    mkdirSync(join(home, ".kimi-code", "oauth"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "config.toml"), "default_model = 'kimi-for-coding'\n");
    writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), "{}");
    writeFileSync(join(home, ".kimi-code", "oauth", "kimi-code"), "");
    process.env.HOME = home;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args, tempPaths } = buildActorBwrapArgs("/tmp/worktree", "kimi");

    // KIMI_CODE_HOME redirects session writes to sandbox /tmp
    expectSetenv(args, "KIMI_CODE_HOME", "/tmp/kimi-home");

    // config.toml is ro-bound from host into the temp home
    const configIdx = args.indexOf("/tmp/kimi-home/config.toml");
    expect(configIdx).toBeGreaterThan(-1);
    expect(args[configIdx - 1]).toBe(join(home, ".kimi-code", "config.toml"));
    expect(args[configIdx - 2]).toBe("--ro-bind");

    // credentials/: kimi rewrites kimi-code.json on every run (tmp-write + rename), which a
    // ro-bind would EROFS on. The REAL host directory is bound writable directly — no per-actor
    // copy — so the rewrite's rename lands in the real host store and survives run teardown.
    const credsIdx = args.indexOf("/tmp/kimi-home/credentials");
    expect(credsIdx).toBeGreaterThan(-1);
    expect(args[credsIdx - 2]).toBe("--bind"); // writable, not ro-bind
    expect(args[credsIdx - 1]).toBe(join(home, ".kimi-code", "credentials"));

    // oauth/: the CLI's own refresh lock lives here (a sibling lockfile next to the token file),
    // which needs a writable directory, not a writable single file. Bound directly from the
    // real host dir for the same reason as credentials/ above.
    const oauthIdx = args.indexOf("/tmp/kimi-home/oauth");
    expect(oauthIdx).toBeGreaterThan(-1);
    expect(args[oauthIdx - 2]).toBe("--bind"); // writable, not ro-bind
    expect(args[oauthIdx - 1]).toBe(join(home, ".kimi-code", "oauth"));

    // No per-run temp copies of either credentials or oauth remain.
    expect(tempPaths.some((p) => p.includes("rusa-kimicreds-"))).toBe(false);
    expect(tempPaths.some((p) => p.includes("rusa-auth-kimi-"))).toBe(false);

    // No synthetic HOME remapping (mesh actor keeps real home)
    expect(args).not.toContain("/tmp/rusa-home");
  });

  it("skips the credentials/oauth binds for kimi when the host dir is absent or a plain file (least privilege)", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-kimi-mesh-home-missing-"));
    tempDirs.push(home);
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    // credentials/ absent entirely.
    // oauth/ exists but as a plain file, not a directory.
    writeFileSync(join(home, ".kimi-code", "oauth"), "not-a-directory");

    process.env.HOME = home;
    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs("/tmp/worktree", "kimi");

    expect(args).not.toContain("/tmp/kimi-home/credentials");
    expect(args).not.toContain("/tmp/kimi-home/oauth");
  });

  it("skips the credentials/oauth binds for kimi when the host path is a symlink, even one pointing at a real directory (least privilege)", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-kimi-mesh-home-symlink-"));
    tempDirs.push(home);
    mkdirSync(join(home, ".kimi-code"), { recursive: true });

    // A decoy real directory elsewhere, outside the expected ~/.kimi-code tree, that
    // credentials/ and oauth/ are symlinked to. If the bind helper used `statSync`
    // (which follows symlinks) instead of `lstatSync`, it would treat these as real
    // directories and bind the decoy writable into the sandbox — this proves it doesn't.
    const decoy = mkdtempSync(join(tmpdir(), "mc-kimi-symlink-decoy-"));
    tempDirs.push(decoy);
    symlinkSync(decoy, join(home, ".kimi-code", "credentials"));
    symlinkSync(decoy, join(home, ".kimi-code", "oauth"));

    process.env.HOME = home;
    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs("/tmp/worktree", "kimi");

    expect(args).not.toContain("/tmp/kimi-home/credentials");
    expect(args).not.toContain("/tmp/kimi-home/oauth");
    expect(args).not.toContain(decoy);
  });

  it("ro-binds the per-invocation mcp config to KIMI_CODE_HOME/mcp.json for kimi", async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs, SANDBOX_KIMI_MCP_CONFIG_PATH } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs("/tmp/worktree", "kimi", "/tmp/kimi-mcp-temp.json");

    expectSetenv(args, "KIMI_CODE_HOME", "/tmp/kimi-home");
    const targetIndex = args.indexOf(SANDBOX_KIMI_MCP_CONFIG_PATH);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(args[targetIndex - 1]).toBe("/tmp/kimi-mcp-temp.json");
    expect(args[targetIndex - 2]).toBe("--ro-bind");
    expect(args).not.toContain("/tmp/worktree/.kimi-code/mcp.json");
  });

  it("persists kimi sessions: binds a per-actor host-/tmp store's sessions/ AND session_index.jsonl over /tmp/kimi-home, after the tmpfs (ISSUE_NUM + follow-up)", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-kimi-sess-home-"));
    tempDirs.push(home);
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    mkdirSync(join(home, ".kimi-code", "oauth"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "config.toml"), "default_model = 'kimi-for-coding'\n");
    writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), "{}");
    writeFileSync(join(home, ".kimi-code", "oauth", "kimi-code"), "mock-oauth-token");
    process.env.HOME = home;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs, kimiSessionStoreDir } = await import("./sandbox.js");
    const { args, tempPaths } = buildActorBwrapArgs("/tmp/worktree", "kimi");
    const store = kimiSessionStoreDir("/tmp/worktree");
    tempDirs.push(store);

    // Stable, per-actor, host-/tmp path keyed by the actor id (dir basename).
    expect(store).toBe("/tmp/rusa-kimi-sessions-worktree");
    // Both persistent slices are laid out under the store so their bind sources exist:
    // a sessions/ subdir and the sibling session_index.jsonl (empty, kimi's fresh state).
    const storeSessions = join(store, "sessions");
    const storeIndex = join(store, "session_index.jsonl");
    expect(existsSync(storeSessions)).toBe(true);
    expect(existsSync(storeIndex)).toBe(true);

    // sessions/ bound WRITABLE over KIMI_CODE_HOME/sessions.
    const sessIndex = args.indexOf("/tmp/kimi-home/sessions");
    expect(sessIndex).toBeGreaterThan(-1);
    expect(args[sessIndex - 1]).toBe(storeSessions);
    expect(args[sessIndex - 2]).toBe("--bind");

    // session_index.jsonl bound WRITABLE over its sibling path — the `-r <id>` id->bucket
    // lookup reads it, so ISSUE_NUM (sessions/ only) left resume broken until this landed.
    const idxIndex = args.indexOf("/tmp/kimi-home/session_index.jsonl");
    expect(idxIndex).toBeGreaterThan(-1);
    expect(args[idxIndex - 1]).toBe(storeIndex);
    expect(args[idxIndex - 2]).toBe("--bind");

    // Ordering is load-bearing: the `--tmpfs /tmp` MUST precede both binds, or the
    // tmpfs would shadow the persistent store.
    const tmpfsTmp = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === "/tmp");
    expect(tmpfsTmp).toBeGreaterThan(-1);
    expect(tmpfsTmp).toBeLessThan(sessIndex - 2);
    expect(tmpfsTmp).toBeLessThan(idxIndex - 2);

    // The session store is the actor's MEMORY, not a per-run secret: neither the store
    // dir nor the index is swept as a tempPath (that discipline is auth-only — creds/oauth).
    expect(tempPaths).not.toContain(store);
    expect(tempPaths).not.toContain(storeSessions);
    expect(tempPaths).not.toContain(storeIndex);
  });

  it("pins the per-invocation mcp config over the real ~/.gemini paths for antigravity", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-gemini-home-"));
    tempDirs.push(home);
    process.env.HOME = home;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs(
      "/tmp/worktree",
      "antigravity",
      "/tmp/mcp-temp-config.json"
    );

    // The config is bound over the REAL home's agy paths (no synthetic HOME).
    const configTarget = join(home, ".gemini", "config", "mcp_config.json");
    const legacyTarget = join(home, ".gemini", "antigravity", "mcp_config.json");
    expect(args).toContain(configTarget);
    expect(args).toContain(legacyTarget);
    const configIndex = args.indexOf(configTarget);
    expect(args[configIndex - 1]).toBe("/tmp/mcp-temp-config.json");
    expect(args[configIndex - 2]).toBe("--ro-bind");
    // No synthetic HOME remapping any more.
    expect(args).not.toContain("/tmp/rusa-home");
    expect(args).not.toContain("HOME");
  });

  it("ro-binds the per-invocation mcp config to the fixed in-sandbox path for claude ", async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs, SANDBOX_MCP_CONFIG_PATH } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs("/tmp/worktree", "claude", "/tmp/mcp-temp-config.json");

    // The host-/tmp source is ro-bound to the fixed in-sandbox path claude reads.
    const target = SANDBOX_MCP_CONFIG_PATH;
    const targetIndex = args.indexOf(target);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(args[targetIndex - 1]).toBe("/tmp/mcp-temp-config.json");
    expect(args[targetIndex - 2]).toBe("--ro-bind");
  });

  describe("e2e writable remote dir (harness's disposable bare remote)", () => {
    function stubPnpmStore() {
      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });
    }

    it("is absent from ordinary production sandbox args (no e2eWritableRemoteDir passed)", async () => {
      stubPnpmStore();
      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs("/tmp/worktree", "claude");

      const sentinel = "/home/e2e-operator/.rusa-e2e/run-abc/remote/repo.git";
      expect(args).not.toContain(sentinel);
    });

    it("binds the e2e remote dir writable in place for an ordinary sandboxed worker (not just the E2E root)", async () => {
      stubPnpmStore();
      const remoteDir = mkdtempSync(join(tmpdir(), "mc-e2e-remote-"));
      tempDirs.push(remoteDir);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      // isE2eRoot=false: this is an ordinary sandboxed worker, not the root double.
      const { args } = buildActorBwrapArgs(
        "/tmp/worktree",
        "claude",
        undefined,
        false,
        undefined,
        remoteDir
      );

      const bindIndex = args.findIndex(
        (a, i) => a === "--bind" && args[i + 1] === remoteDir && args[i + 2] === remoteDir
      );
      expect(bindIndex).toBeGreaterThan(-1);
    });

    it("binds the e2e remote dir writable in place for the sandboxed E2E root too", async () => {
      stubPnpmStore();
      const remoteDir = mkdtempSync(join(tmpdir(), "mc-e2e-remote-root-"));
      tempDirs.push(remoteDir);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(
        "/tmp/root-agent",
        "claude",
        undefined,
        true,
        undefined,
        remoteDir
      );

      const bindIndex = args.findIndex(
        (a, i) => a === "--bind" && args[i + 1] === remoteDir && args[i + 2] === remoteDir
      );
      expect(bindIndex).toBeGreaterThan(-1);
    });

    it("skips the bind when the e2e remote dir is set but does not exist on disk", async () => {
      stubPnpmStore();
      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const missingDir = join(tmpdir(), "mc-e2e-remote-does-not-exist");

      const { args } = buildActorBwrapArgs(
        "/tmp/worktree",
        "claude",
        undefined,
        false,
        undefined,
        missingDir
      );

      expect(args).not.toContain(missingDir);
    });
  });

  describe("claude E2E root-agent cred layout ", () => {
    function makeE2eRootHome(withHostCreds: boolean) {
      const home = mkdtempSync(join(tmpdir(), "mc-claude-e2e-home-"));
      tempDirs.push(home);
      if (withHostCreds) {
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(join(home, ".claude", ".credentials.json"), "{}", { mode: 0o600 });
      }
      process.env.HOME = home;
      return home;
    }

    it("sets CLAUDE_CONFIG_DIR=/tmp/claude-auth and binds the workspace state dir for the E2E root", async () => {
      const home = makeE2eRootHome(false);
      const mcHome = join(home, ".rusa");
      const rootAgentDir = join(mcHome, "root-agent");
      mkdirSync(rootAgentDir, { recursive: true });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(rootAgentDir, "claude", undefined, true);

      expectSetenv(args, "CLAUDE_CONFIG_DIR", "/tmp/claude-auth");
      expect(args).toContain("/tmp/claude-auth");
      const stateDir = join(rootAgentDir, ".claude-state");
      const bindIndex = args.findIndex(
        (a, i) => a === "--bind" && args[i + 1] === stateDir && args[i + 2] === "/tmp/claude-auth"
      );
      expect(bindIndex).toBeGreaterThan(-1);
      const unsetConfigDirIndex = args.findIndex(
        (a, i) => a === "--unsetenv" && args[i + 1] === "CLAUDE_CONFIG_DIR"
      );
      expect(unsetConfigDirIndex).toBe(-1);
    });

    it("ro-binds host .credentials.json into /tmp/claude-auth when present", async () => {
      const home = makeE2eRootHome(true);
      const mcHome = join(home, ".rusa");
      const rootAgentDir = join(mcHome, "root-agent");
      mkdirSync(rootAgentDir, { recursive: true });
      const hostCreds = join(home, ".claude", ".credentials.json");

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(rootAgentDir, "claude", undefined, true);

      const credsIndex = args.findIndex(
        (a, i) =>
          a === "--ro-bind" &&
          args[i + 1] === hostCreds &&
          args[i + 2] === "/tmp/claude-auth/.credentials.json"
      );
      expect(credsIndex).toBeGreaterThan(-1);
    });

    it("does NOT apply the root cred layout to a normal worker dir", async () => {
      const home = makeE2eRootHome(false);
      const mcHome = join(home, ".rusa");
      const workerDir = join(mcHome, "workers", "abc123");
      mkdirSync(workerDir, { recursive: true });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(workerDir, "claude");

      expect(args).not.toContain("/tmp/claude-auth");
      const setConfigDirIndex = args.findIndex(
        (a, i) => a === "--setenv" && args[i + 1] === "CLAUDE_CONFIG_DIR"
      );
      expect(setConfigDirIndex).toBe(-1);
      const unsetIndex = args.findIndex(
        (a, i) => a === "--unsetenv" && args[i + 1] === "CLAUDE_CONFIG_DIR"
      );
      expect(unsetIndex).toBeGreaterThan(-1);
    });
  });

  it("buildActorBwrapArgs leaves siblings readable (open read) and scopes writes to its own dir + /tmp", async () => {
    // The mesh worker layout: <home>/.rusa/workers/<id>. Visibility is open —
    // an actor may read any other actor's repo — so the workers tree is NOT tmpfs'd.
    // Write isolation comes from only re-binding this actor's own dir rw (plus /tmp).
    const home = mkdtempSync(join(tmpdir(), "mc-home-"));
    tempDirs.push(home);
    const workersDir = join(home, ".rusa", "workers");
    const actorDir = join(workersDir, "abc123");
    const siblingDir = join(workersDir, "sibling456");
    mkdirSync(actorDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    process.env.HOME = home;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs(actorDir, "antigravity");

    // Nothing in the workers tree is shadowed — a sibling actor's dir stays visible.
    const tmpfsTargets = args.filter((_, i) => args[i - 1] === "--tmpfs");
    expect(tmpfsTargets).not.toContain(workersDir);
    expect(tmpfsTargets).not.toContain(home);
    // Only /tmp is tmpfs'd (writable scratch); the host root is ro-bound (read-all).
    expect(tmpfsTargets).toContain("/tmp");
    expect(args).toContain("--ro-bind");
    // The real home is kept (read-only via ro-bind /); no synthetic HOME remapping.
    expect(args).not.toContain("/tmp/rusa-home");
    expect(args).not.toContain("HOME");
    expect(args).not.toContain("/tmp/sandbox-bin/git");
    expect(args).not.toContain("/tmp/sandbox-bin/gh");
    // Temp + cache env point at the writable tmpfs, not the read-only host home.
    const tmpdirIdx = args.indexOf("TMPDIR");
    expect(tmpdirIdx).toBeGreaterThan(-1);
    expect(args[tmpdirIdx + 1]).toBe("/tmp");
    const cacheIdx = args.indexOf("XDG_CACHE_HOME");
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(args[cacheIdx + 1]).toBe("/tmp/cache");
    expectSetenv(args, "npm_config_cache", "/tmp/cache/npm");
    // The actor's own dir is a writable bind, re-bound in place + chdir'd.
    expect(args.join(" ")).toContain(`--bind ${actorDir} ${actorDir}`);
    const chdirIndex = args.indexOf("--chdir");
    expect(args[chdirIndex + 1]).toBe(actorDir);
    // The provider's state dir is the only home subtree bound read-write.
    expect(args.join(" ")).toContain(`--bind ${join(home, ".gemini")} ${join(home, ".gemini")}`);
  });

  it("shadows host-job audit artifacts out of mesh actor read/write scope", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-home-"));
    tempDirs.push(home);
    const mcHome = join(home, ".rusa");
    const actorDir = join(mcHome, "workers", "abc123");
    const auditDir = join(mcHome, "host-jobs", "audit");
    mkdirSync(actorDir, { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    process.env.HOME = home;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args } = buildActorBwrapArgs(actorDir, "antigravity");

    expect(args.filter((_, i) => args[i - 1] === "--tmpfs")).toContain(auditDir);
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") {
        expect(args[i + 1]).not.toBe(auditDir);
        expect(args[i + 2]).not.toBe(auditDir);
      }
    }
  });

  describe("understanding read-only mount (/tmp/understanding)", () => {
    it("emits --dir /tmp/understanding and --ro-bind <host_dir> /tmp/understanding after --tmpfs /tmp when understandingMount is provided", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const actorDir = join(home, ".rusa", "workers", "abc123");
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const hostSnapshotDir = "/tmp/host-understanding-snapshot-123";
      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(
        actorDir,
        "antigravity",
        undefined,
        false,
        hostSnapshotDir
      );

      const tmpfsIdx = args.indexOf("/tmp");
      expect(tmpfsIdx).toBeGreaterThan(-1);
      expect(args[tmpfsIdx - 1]).toBe("--tmpfs");

      const dirIdx = args.indexOf("/tmp/understanding");
      expect(dirIdx).toBeGreaterThan(tmpfsIdx);
      expect(args[dirIdx - 1]).toBe("--dir");

      const roBindIndices: number[] = [];
      for (let i = 0; i < args.length; i++) {
        if (
          args[i] === "--ro-bind" &&
          args[i + 1] === hostSnapshotDir &&
          args[i + 2] === "/tmp/understanding"
        ) {
          roBindIndices.push(i);
        }
      }
      expect(roBindIndices.length).toBe(1);
      expect(roBindIndices[0]).toBeGreaterThan(tmpfsIdx);
    });

    it("omits /tmp/understanding when understandingMount is not provided", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const actorDir = join(home, ".rusa", "workers", "abc123");
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir, "antigravity");

      expect(args).not.toContain("/tmp/understanding");
    });
  });

  describe("worker GitHub credential split (github.workerTokenPath, ISSUE_NUM/ISSUE_NUM-adjacent)", () => {
    it("is inert (workers keep the host gh config) and logs once when github.workerTokenPath is unset", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const actorDir = join(mcHome, "workers", "abc123");
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir, "antigravity");

      const ghConfigTarget = join(home, ".config", "gh");
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--ro-bind") {
          expect(args[i + 2]).not.toBe(ghConfigTarget);
        }
      }
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--unsetenv") {
          expect(args[i + 1]).not.toBe("GH_TOKEN");
          expect(args[i + 1]).not.toBe("GITHUB_TOKEN");
        }
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/workerTokenPath is not set/);

      warnSpy.mockRestore();
    });

    it("binds a synthesized read-only gh config, scrubs GH_TOKEN/GITHUB_TOKEN, and shadows the host write-token file when github.workerTokenPath is set", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const actorDir = join(mcHome, "workers", "abc123");
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;

      const patDir = mkdtempSync(join(tmpdir(), "mc-pat-"));
      tempDirs.push(patDir);
      const tokenPath = join(patDir, "worker-github-token");
      const secretToken = "github_pat_SECRET_VALUE_DO_NOT_LEAK";
      writeFileSync(tokenPath, `${secretToken}\n`, { mode: 0o600 });

      const hostWriteTokenPath = join(mcHome, "github-token");
      mkdirSync(mcHome, { recursive: true });
      writeFileSync(hostWriteTokenPath, "ghp_HOST_WRITE_TOKEN\n", { mode: 0o600 });

      mockLoadConfig.mockReturnValue({
        github: { account: "test", workerTokenPath: tokenPath },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir, "antigravity");

      const ghConfigTarget = join(home, ".config", "gh");
      const ghBindIndex = args.findIndex(
        (a, i) => a === "--ro-bind" && args[i + 2] === ghConfigTarget
      );
      expect(ghBindIndex).toBeGreaterThan(-1);
      const workerGhConfigDir = args[ghBindIndex + 1];
      expect(workerGhConfigDir).toBe(join(mcHome, "worker-gh"));

      // hosts.yml: correct shape, 0600 perms, carries the PAT.
      const hostsYmlPath = join(workerGhConfigDir, "hosts.yml");
      expect(statSync(hostsYmlPath).mode & 0o777).toBe(0o600);
      const hostsYmlContent = readFileSync(hostsYmlPath, "utf8");
      expect(hostsYmlContent).toContain(secretToken);
      expect(hostsYmlContent).toContain("git_protocol: https");
      expect(hostsYmlContent).toContain("github.com");

      // config.yml: written alongside, also locked down.
      const configYmlPath = join(workerGhConfigDir, "config.yml");
      expect(statSync(configYmlPath).mode & 0o777).toBe(0o600);

      // GH_TOKEN / GITHUB_TOKEN scrubbed so hosts.yml is authoritative.
      let unsetGhToken = false;
      let unsetGithubToken = false;
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--unsetenv" && args[i + 1] === "GH_TOKEN") unsetGhToken = true;
        if (args[i] === "--unsetenv" && args[i + 1] === "GITHUB_TOKEN") unsetGithubToken = true;
      }
      expect(unsetGhToken).toBe(true);
      expect(unsetGithubToken).toBe(true);

      // Host's write-capable token file is shadowed with /dev/null.
      const writeTokenShadowIndex = args.findIndex(
        (a, i) =>
          a === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2] === hostWriteTokenPath
      );
      expect(writeTokenShadowIndex).toBeGreaterThan(-1);

      // GH wrapper : wrapper script copied, 0755 perms, bound to /tmp/gh-wrapper/bin/gh and prepended to PATH.
      const ghWrapperPath = join(workerGhConfigDir, "bin", "gh");
      expect(existsSync(ghWrapperPath)).toBe(true);
      expect(statSync(ghWrapperPath).mode & 0o777).toBe(0o755);

      const wrapperBindIndex = args.findIndex(
        (a, i) =>
          a === "--ro-bind" &&
          args[i + 1] === ghWrapperPath &&
          args[i + 2] === "/tmp/gh-wrapper/bin/gh"
      );
      expect(wrapperBindIndex).toBeGreaterThan(-1);
      expect(args).toContain("/tmp/gh-wrapper");
      expect(args).toContain("/tmp/gh-wrapper/bin");

      const pathIndex = args.indexOf("PATH");
      expect(args[pathIndex + 1]).toMatch(/^\/tmp\/gh-wrapper\/bin:/);

      // The PAT never leaks into argv, and setting the key suppresses the
      // unset-key warning.
      expect(args).not.toContain(secretToken);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("throws (refuses to spawn) when github.workerTokenPath is set but the file is missing — fail-closed, ISSUE_NUM precedent", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const actorDir = join(mcHome, "workers", "abc123");
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;

      mockLoadConfig.mockReturnValue({
        github: { account: "test", workerTokenPath: join(home, "does-not-exist-pat") },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      expect(() => buildActorBwrapArgs(actorDir, "antigravity")).toThrow(
        /workerTokenPath is set.*does not exist/s
      );
    });

    it("never applies the split to the root actor (unsandboxed root, or the sandboxed E2E root-agent double)", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const rootAgentDir = join(mcHome, "root-agent");
      mkdirSync(rootAgentDir, { recursive: true });
      process.env.HOME = home;

      const patDir = mkdtempSync(join(tmpdir(), "mc-pat-"));
      tempDirs.push(patDir);
      const tokenPath = join(patDir, "worker-github-token");
      writeFileSync(tokenPath, "github_pat_SECRET\n", { mode: 0o600 });

      mockLoadConfig.mockReturnValue({
        github: { account: "test", workerTokenPath: tokenPath },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      // The E2E sandboxed root test double (ISSUE_NUM-adjacent convention already used
      // by the audit-artifact shadow above) — it must stay on the host gh config
      // exactly like production root, even with the config key set and the PAT file
      // present. isE2eRoot is passed explicitly so sandbox.ts no longer has to sniff
      // the directory basename.
      const { args } = buildActorBwrapArgs(rootAgentDir, "antigravity", undefined, true);

      const ghConfigTarget = join(home, ".config", "gh");
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--ro-bind") {
          expect(args[i + 2]).not.toBe(ghConfigTarget);
        }
      }
      expect(args.join(" ")).not.toContain("worker-gh");
      expect(args).not.toContain("/tmp/gh-wrapper");
      expect(args).not.toContain("/tmp/gh-wrapper/bin");
    });

    it("resolves the gh failure-hint wrapper script from source or bundled paths", async () => {
      const { resolveGhWrapperScriptPath } = await import("./sandbox.js");
      const wrapperPath = resolveGhWrapperScriptPath();
      expect(wrapperPath).not.toBeNull();
      expect(typeof wrapperPath).toBe("string");
      expect(existsSync(wrapperPath ?? "")).toBe(true);
      expect(wrapperPath).toMatch(/gh-hint-wrapper\.sh$/);
    });
  });

  describe("worker Google API token shadow (~/.config/gchat, ISSUE_NUM)", () => {
    function makeWorkerHome() {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const actorDir = join(mcHome, "workers", "abc123");
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;
      // getHostConfigDir() prefers XDG_CONFIG_HOME over HOME; pin it so the
      // test is hermetic on hosts/CI runners that set XDG_CONFIG_HOME.
      process.env.XDG_CONFIG_HOME = join(home, ".config");

      // Keep the gh-credential split inert for these tests.
      mockLoadConfig.mockReturnValue({
        github: { account: "test" },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      return { home, mcHome, actorDir, gchatDir: join(home, ".config", "gchat") };
    }

    it("tmpfs-shadows the host's real ~/.config/gchat dir for real workers", async () => {
      const { actorDir, gchatDir } = makeWorkerHome();
      mkdirSync(gchatDir, { recursive: true, mode: 0o700 });
      // Placeholder token files — fake values, never read by the test.
      writeFileSync(join(gchatDir, "token.json"), '{"user_id":"x"}', { mode: 0o600 });
      writeFileSync(join(gchatDir, "gmail-token.json"), '{"refresh_token":"x"}', { mode: 0o600 });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir, "antigravity");

      const tmpfsTargets = args.filter((_, i) => args[i - 1] === "--tmpfs");
      expect(tmpfsTargets).toContain(gchatDir);

      // The shadow must be a tmpfs (empty, hiding real token files), not a bind
      // that leaks the host directory back in.
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--bind" || args[i] === "--ro-bind") {
          expect(args[i + 1]).not.toBe(gchatDir);
          expect(args[i + 2]).not.toBe(gchatDir);
        }
      }

      warnSpy.mockRestore();
    });

    it("does NOT shadow ~/.config/gchat for the E2E root-agent double", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const rootAgentDir = join(mcHome, "root-agent");
      mkdirSync(rootAgentDir, { recursive: true });
      const gchatDir = join(home, ".config", "gchat");
      mkdirSync(gchatDir, { recursive: true, mode: 0o700 });
      process.env.HOME = home;
      // getHostConfigDir() prefers XDG_CONFIG_HOME over HOME; pin it so the
      // test is hermetic on hosts/CI runners that set XDG_CONFIG_HOME.
      process.env.XDG_CONFIG_HOME = join(home, ".config");

      mockLoadConfig.mockReturnValue({
        github: { account: "test" },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(rootAgentDir, "antigravity", undefined, true);

      const tmpfsTargets = args.filter((_, i) => args[i - 1] === "--tmpfs");
      expect(tmpfsTargets).not.toContain(gchatDir);
    });

    it("is inert when the host has no ~/.config/gchat dir", async () => {
      const { actorDir, gchatDir } = makeWorkerHome();
      // Intentionally do not create gchatDir.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir, "antigravity");

      const tmpfsTargets = args.filter((_, i) => args[i - 1] === "--tmpfs");
      expect(tmpfsTargets).not.toContain(gchatDir);
      warnSpy.mockRestore();
    });
  });

  describe("worker host-secrets masking ($RUSA_HOME/secrets, ISSUE_NUM)", () => {
    const ACTOR_ID = "worker-abc123";

    function makeWorkerHome() {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const actorDir = join(mcHome, "workers", ACTOR_ID);
      mkdirSync(actorDir, { recursive: true });
      process.env.HOME = home;

      // No workerTokenPath: the gh-credential split stays inert (it warns once)
      // — these tests exercise ONLY the secrets masking.
      mockLoadConfig.mockReturnValue({
        github: { account: "test" },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      return { home, mcHome, actorDir, secretsDir: join(mcHome, "secrets") };
    }

    function writeActiveGrant(mcHome: string, actorId: string, capability: string) {
      writeFileSync(
        join(mcHome, "capability-grants.json"),
        JSON.stringify({
          grants: [
            {
              actorId,
              capability,
              grantedBy: "parent-1",
              grantedAt: "2026-07-17T00:00:00Z",
            },
          ],
        })
      );
    }

    it("tmpfs-masks the whole secrets dir and scrubs GLASS_GOALS_PASSWORD for every sandboxed worker (no grant → no re-bind)", async () => {
      const { actorDir, secretsDir } = makeWorkerHome();
      // A populated secrets dir with NO grant: everything stays masked.
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(secretsDir, "gemini-api-key"), "AIza_SECRET\n", { mode: 0o600 });
      writeFileSync(join(secretsDir, "webhook-secret"), "hook_SECRET\n", { mode: 0o600 });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args, commandPrefix } = buildActorBwrapArgs(actorDir, "antigravity");

      expect(args.filter((_, i) => args[i - 1] === "--tmpfs")).toContain(secretsDir);
      const unsets = args.filter((_, i) => args[i - 1] === "--unsetenv");
      expect(unsets).toContain("GLASS_GOALS_PASSWORD");
      expect(unsets).toContain("GEMINI_API_KEY");
      expect(unsets).toContain("WEBHOOK_SECRET");
      expect(args.some((a, i) => a === "--setenv" && args[i + 1] === "MISTRAL_API_KEY")).toBe(
        false
      );
      expect(commandPrefix).toEqual([]);
      // No grant → nothing from the secrets dir is bound back through the mask.
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--bind" || args[i] === "--ro-bind") {
          expect(args[i + 1]).not.toContain(secretsDir);
          expect(args[i + 2]).not.toContain(secretsDir);
        }
      }
      warnSpy.mockRestore();
    });

    it("masks even when the host has no secrets dir yet (the mask dir is created 0700)", async () => {
      const { actorDir, secretsDir } = makeWorkerHome();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir, "antigravity");

      expect(args.filter((_, i) => args[i - 1] === "--tmpfs")).toContain(secretsDir);
      expect(statSync(secretsDir).mode & 0o777).toBe(0o700);
      warnSpy.mockRestore();
    });

    it("ro-binds the real gemini-api-key back over its masked path — AFTER the tmpfs — when the actor holds an active secret:gemini-api-key grant and exports it", async () => {
      const { mcHome, actorDir, secretsDir } = makeWorkerHome();
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      const geminiKeyPath = join(secretsDir, "gemini-api-key");
      writeFileSync(geminiKeyPath, "AIza_SECRET\n", { mode: 0o600 });
      writeFileSync(join(secretsDir, "webhook-secret"), "hook_SECRET\n", { mode: 0o600 });
      writeActiveGrant(mcHome, ACTOR_ID, "secret:gemini-api-key");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args, commandPrefix } = buildActorBwrapArgs(actorDir, "antigravity");

      const tmpfsIndex = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === secretsDir);
      expect(tmpfsIndex).toBeGreaterThan(-1);
      const keyBindIndex = args.findIndex(
        (a, i) =>
          a === "--ro-bind" && args[i + 1] === geminiKeyPath && args[i + 2] === geminiKeyPath
      );
      expect(keyBindIndex).toBeGreaterThan(-1);
      // bwrap applies mounts in argument order: the single-file re-bind must come
      // AFTER the directory tmpfs, or the mask would swallow it.
      expect(keyBindIndex).toBeGreaterThan(tmpfsIndex);
      // ONLY the granted file is re-bound; the other secrets stay masked.
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--bind" || args[i] === "--ro-bind") {
          expect(args[i + 2]).not.toBe(join(secretsDir, "webhook-secret"));
          expect(args[i + 2]).not.toBe(join(secretsDir, "glass-goals-password"));
        }
      }
      // With the generic mechanism, the gemini key is also exported.
      expect(commandPrefix).toEqual([
        "/bin/sh",
        "-c",
        expect.stringContaining('GEMINI_API_KEY=$(/bin/cat -- "$1")'),
        "rusa-secrets-entrypoint",
        geminiKeyPath,
      ]);
      warnSpy.mockRestore();
    });

    it("ro-binds mistral-api-key after the mask and defers MISTRAL_API_KEY resolution to an in-sandbox entrypoint", async () => {
      const { mcHome, actorDir, secretsDir } = makeWorkerHome();
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      const mistralKeyPath = `${secretsDir}/mistral-api-key`;
      const fixtureValue = "dummy-mistral-test-key";
      writeFileSync(mistralKeyPath, `${fixtureValue}\n`, { mode: 0o600 });
      writeActiveGrant(mcHome, ACTOR_ID, "secret:mistral-api-key");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { buildActorBwrapArgs, buildActorBwrapCommand } = await import("./sandbox.js");
      const result = buildActorBwrapArgs(actorDir, "antigravity");
      const { args, commandPrefix } = result;

      const tmpfsIndex = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === secretsDir);
      const keyBindIndex = args.findIndex(
        (a, i) =>
          a === "--ro-bind" && args[i + 1] === mistralKeyPath && args[i + 2] === mistralKeyPath
      );
      expect(keyBindIndex).toBeGreaterThan(tmpfsIndex);
      expect(args.some((a, i) => a === "--setenv" && args[i + 1] === "MISTRAL_API_KEY")).toBe(
        false
      );
      expect(commandPrefix).toEqual([
        "/bin/sh",
        "-c",
        expect.stringContaining('MISTRAL_API_KEY=$(/bin/cat -- "$1")'),
        "rusa-secrets-entrypoint",
        mistralKeyPath,
      ]);

      // This is the complete host-side bwrap/spawn argv. The fixture plaintext
      // must not appear anywhere on it; only the well-known bound filename may.
      const spawnArgs = buildActorBwrapCommand(result, "/usr/bin/env", []);
      expect(spawnArgs).not.toContain(fixtureValue);
      expect(spawnArgs.join("\0")).not.toContain(fixtureValue);
      warnSpy.mockRestore();
    });

    it("does not re-bind the key for a grant held by a DIFFERENT actor, a revoked grant, or an unreadable grant store (fail-closed to masked)", async () => {
      const { mcHome, actorDir, secretsDir } = makeWorkerHome();
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      const geminiKeyPath = join(secretsDir, "gemini-api-key");
      writeFileSync(geminiKeyPath, "AIza_SECRET\n", { mode: 0o600 });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { buildActorBwrapArgs } = await import("./sandbox.js");

      const expectMasked = () => {
        const { args } = buildActorBwrapArgs(actorDir, "antigravity");
        expect(args.filter((_, i) => args[i - 1] === "--tmpfs")).toContain(secretsDir);
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === "--bind" || args[i] === "--ro-bind") {
            expect(args[i + 2]).not.toBe(geminiKeyPath);
          }
        }
      };

      // Someone else's grant.
      writeActiveGrant(mcHome, "some-other-actor", "secret:gemini-api-key");
      expectMasked();

      // The actor's own grant, revoked.
      writeFileSync(
        join(mcHome, "capability-grants.json"),
        JSON.stringify({
          grants: [
            {
              actorId: ACTOR_ID,
              capability: "secret:gemini-api-key",
              grantedBy: "parent-1",
              grantedAt: "2026-07-17T00:00:00Z",
              revokedAt: "2026-07-17T01:00:00Z",
            },
          ],
        })
      );
      expectMasked();

      // Corrupt store: a read/parse error means "no grant", never "leaked".
      writeFileSync(join(mcHome, "capability-grants.json"), "{not json!!");
      expectMasked();

      warnSpy.mockRestore();
    });

    it("does not mask the secrets dir for the E2E root-agent double (workers-only guard)", async () => {
      const home = mkdtempSync(join(tmpdir(), "mc-home-"));
      tempDirs.push(home);
      const mcHome = join(home, ".rusa");
      const rootAgentDir = join(mcHome, "root-agent");
      mkdirSync(rootAgentDir, { recursive: true });
      const secretsDir = join(mcHome, "secrets");
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      process.env.HOME = home;

      mockLoadConfig.mockReturnValue({
        github: { account: "test" },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: false,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        if (command === "which git") return "/usr/bin/git\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(rootAgentDir, "antigravity", undefined, true);
      expect(args.filter((_, i) => args[i - 1] === "--tmpfs")).not.toContain(secretsDir);
    });
  });

  it("puts node, corepack, and pnpm on PATH and pins the v10 store for mesh actors", async () => {
    process.env.PATH = "/usr/local/bin:/usr/bin";
    const storeRoot = mkdtempSync(join(tmpdir(), "mc-pnpm-mesh-store-"));
    tempDirs.push(storeRoot);
    const v11Store = join(storeRoot, "store", "v11");
    const v10Store = join(storeRoot, "store", "v10");
    const authModes = ["claude", "codex", "antigravity", "kimi"] as const;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return `${v11Store}\n`;
      if (command === "which node") return "/opt/fnm/node-v22/bin/node\n";
      if (command === "which corepack") return "/opt/fnm/node-v22/bin/corepack\n";
      if (command === "which pnpm") return "/opt/fnm/pnpm-shims/pnpm\n";
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");

    for (const mode of authModes) {
      const { args } = buildActorBwrapArgs(`/tmp/worktree-${mode}`, mode);
      expectSetenv(
        args,
        "PATH",
        "/opt/fnm/node-v22/bin:/opt/fnm/pnpm-shims:/usr/local/bin:/usr/bin:/bin"
      );
      expectSetenv(args, "NPM_CONFIG_STORE_DIR", v10Store);
      expectSetenv(args, "npm_config_store_dir", v10Store);
      expect(args).toContain(v10Store);
      expect(args).not.toContain(v11Store);
      expect(args).not.toContain("/tmp/sandbox-bin/node");
      expect(args).not.toContain("/tmp/sandbox-bin/corepack");
      expect(args).not.toContain("/tmp/sandbox-bin/pnpm");
    }
  });

  it("injects only a generated @thkp-eng npmrc into mesh actor bwrap args", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-npm-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    delete process.env.NODE_AUTH_TOKEN;
    process.env.STAMP_SECRET = "hmac-secret-must-not-enter-bwrap";
    writeFileSync(
      join(home, ".npmrc"),
      [
        "@other:registry=https://registry.example.test/",
        "//registry.example.test/:_authToken=other-secret",
        "@thkp-eng:registry=https://registry.npmjs.org/",
        "//registry.npmjs.org/:_authToken=thkp-read-token",
      ].join("\n")
    );

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args, tempPaths } = buildActorBwrapArgs("/tmp/worktree");

    const sandboxNpmrc = "/tmp/rusa-npmrc";
    expectSetenv(args, "NPM_CONFIG_USERCONFIG", sandboxNpmrc);
    expectSetenv(args, "npm_config_userconfig", sandboxNpmrc);

    const targetIndex = args.indexOf(sandboxNpmrc);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(args[targetIndex - 2]).toBe("--ro-bind");
    const generatedNpmrc = args[targetIndex - 1];
    const hostNpmrcIndex = args.indexOf(join(home, ".npmrc"));
    expect(hostNpmrcIndex).toBeGreaterThan(-1);
    expect(args[hostNpmrcIndex - 2]).toBe("--ro-bind");
    expect(args[hostNpmrcIndex - 1]).toBe(generatedNpmrc);
    expect(tempPaths).toContain(generatedNpmrc);
    const generated = readFileSync(generatedNpmrc, "utf-8");
    expect(generated).toContain("@thkp-eng:registry=https://registry.npmjs.org/");
    expect(generated).toContain("//registry.npmjs.org/:_authToken=thkp-read-token");
    expect(generated).not.toContain("other-secret");
    expect(args).not.toContain("thkp-read-token");
    expect(args).not.toContain("STAMP_SECRET");
    expect(args).not.toContain("hmac-secret-must-not-enter-bwrap");
    rmSync(generatedNpmrc, { force: true });
  });

  it("uses a creatable /tmp npmrc target when only NODE_AUTH_TOKEN is available", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-npm-env-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.NODE_AUTH_TOKEN = "env-read-token";
    process.env.STAMP_SECRET = "hmac-secret-must-not-enter-bwrap";

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args, tempPaths } = buildActorBwrapArgs("/tmp/worktree");

    const sandboxNpmrc = "/tmp/rusa-npmrc";
    expectSetenv(args, "NPM_CONFIG_USERCONFIG", sandboxNpmrc);
    expectSetenv(args, "npm_config_userconfig", sandboxNpmrc);
    const targetIndex = args.indexOf(sandboxNpmrc);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(args[targetIndex - 2]).toBe("--ro-bind");
    const generatedNpmrc = args[targetIndex - 1];
    expect(tempPaths).toContain(generatedNpmrc);
    expect(args).not.toContain(join(home, ".npmrc"));
    const generated = readFileSync(generatedNpmrc, "utf-8");
    expect(generated).toContain("//registry.npmjs.org/:_authToken=env-read-token");
    expect(args).not.toContain("env-read-token");
    expect(args).not.toContain("STAMP_SECRET");
    expect(args).not.toContain("hmac-secret-must-not-enter-bwrap");
    rmSync(generatedNpmrc, { force: true });
  });

  it("binds the per-invocation mcp config and shared host auth to /tmp for codex", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-home-"));
    tempDirs.push(home);
    process.env.HOME = home;

    // Create mock auth file
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "mock-auth-data");

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs } = await import("./sandbox.js");
    const { args, tempPaths } = buildActorBwrapArgs(
      "/tmp/worktree",
      "codex",
      "/tmp/mcp-temp-config.toml"
    );

    const configIndex = args.indexOf("/tmp/config.toml");
    expect(configIndex).toBeGreaterThan(-1);
    expect(args[configIndex - 1]).toBe("/tmp/mcp-temp-config.toml");
    expect(args[configIndex - 2]).toBe("--bind");

    const hostAuthPath = join(home, ".codex", "auth.json");
    const authIndex = args.indexOf("/tmp/auth.json");
    expect(authIndex).toBeGreaterThan(-1);
    expect(args[authIndex - 1]).toBe(hostAuthPath);
    expect(args[authIndex - 2]).toBe("--bind");

    // Auth refreshes must land in the one file every codex session reads. It is
    // live host state, not a per-run copy to sweep at teardown.
    expect(tempPaths).not.toContain(hostAuthPath);
    expect(tempPaths).not.toContain("/tmp/rusa-auth-codex-worktree.json");

    const sibling = buildActorBwrapArgs("/tmp/sibling-worktree", "codex");
    const siblingAuthIndex = sibling.args.indexOf("/tmp/auth.json");
    expect(sibling.args[siblingAuthIndex - 1]).toBe(hostAuthPath);
    tempDirs.push("/tmp/rusa-codex-sessions-sibling-worktree");

    expect(args.join(" ")).toContain("--setenv CODEX_HOME /tmp");
    expect(args.join(" ")).not.toContain(`--bind ${join(home, ".codex")} ${join(home, ".codex")}`);
  });

  it("persists codex session rollouts: binds a per-actor host-/tmp store over /tmp/sessions, after the tmpfs", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-home-"));
    tempDirs.push(home);
    process.env.HOME = home;

    execSyncMock.mockImplementation((command: string) => {
      if (command === "pnpm store path") return "/tmp/pnpm-store\n";
      const fallback = defaultExecSyncResponse(command);
      if (fallback) return fallback;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { buildActorBwrapArgs, codexRolloutStoreDir } = await import("./sandbox.js");
    const { args, tempPaths } = buildActorBwrapArgs("/tmp/worktree", "codex");
    const store = codexRolloutStoreDir("/tmp/worktree");
    tempDirs.push(store);

    // Stable, per-actor, host-/tmp path keyed by the actor id (dir basename).
    expect(store).toBe("/tmp/rusa-codex-sessions-worktree");
    // The store is mkdir'd so the bind source exists.
    expect(existsSync(store)).toBe(true);

    // Bound over CODEX_HOME's sessions path.
    const sessIndex = args.indexOf("/tmp/sessions");
    expect(sessIndex).toBeGreaterThan(-1);
    expect(args[sessIndex - 1]).toBe(store);
    expect(args[sessIndex - 2]).toBe("--bind");

    // Ordering is load-bearing: the `--tmpfs /tmp` MUST precede the bind, or the
    // tmpfs would shadow the persistent store.
    const tmpfsTmp = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === "/tmp");
    expect(tmpfsTmp).toBeGreaterThan(-1);
    expect(tmpfsTmp).toBeLessThan(sessIndex - 2);

    // The store is the actor's MEMORY, not a per-run secret: it must NOT be swept
    // as a tempPath (that discipline is auth-only).
    expect(tempPaths).not.toContain(store);
  });

  describe("git-bridge mode redirects", () => {
    it("injects GIT_CONFIG_PARAMETERS when gitBridge is enabled", async () => {
      mockLoadConfig.mockReturnValue({
        github: { account: "test" },
        providers: {},
        webhook: { port: 9742, secret: "secret" },
        gitBridge: true,
        gitBridgePort: 9005,
      });

      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");

      const { args: actorArgs } = buildActorBwrapArgs("/tmp/worktree", "codex");
      expectSetenv(
        actorArgs,
        "GIT_CONFIG_PARAMETERS",
        "'url.http://127.0.0.1:9005/.insteadOf=https://github.com/' 'url.http://127.0.0.1:9005/.insteadOf=git@github.com:'"
      );
    });
  });

  describe("non-interactive environment baseline ", () => {
    it("sets COREPACK_ENABLE_DOWNLOAD_PROMPT=0, CI=1, GIT_TERMINAL_PROMPT=0, GIT_PAGER=cat, PAGER=cat, DEBIAN_FRONTEND=noninteractive in buildActorBwrapArgs", async () => {
      execSyncMock.mockImplementation((command: string) => {
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs("/tmp/worktree");

      expectSetenv(args, "COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");
      expectSetenv(args, "CI", "1");
      expectSetenv(args, "GIT_TERMINAL_PROMPT", "0");
      expectSetenv(args, "GIT_PAGER", "cat");
      expectSetenv(args, "PAGER", "cat");
      expectSetenv(args, "DEBIAN_FRONTEND", "noninteractive");
    });

    it("injects a fail-loud flutter shim when fuse-overlayfs is missing but flutter is installed", async () => {
      const actorDir = mkdtempSync(join(tmpdir(), "actor-"));
      tempDirs.push(actorDir);
      const fakeFlutterBin = join(actorDir, "bin", "flutter");
      mkdirSync(dirname(fakeFlutterBin), { recursive: true });
      writeFileSync(fakeFlutterBin, "");
      execSyncMock.mockImplementation((command: string) => {
        if (command === "which flutter") return fakeFlutterBin;
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      const { buildActorBwrapArgs } = await import("./sandbox.js");
      const { args } = buildActorBwrapArgs(actorDir);

      const pathIndex = args.indexOf("PATH");
      expect(args[pathIndex + 1]).toContain("/tmp/flutter-wrapper/bin:");
      expectSetenv(args, "PUB_CACHE", "/tmp/flutter-sdk/.pub-cache");
      expect(args).toContain("/tmp/flutter-sdk");
      expect(args).toContain("/tmp/flutter-wrapper/bin");

      const fakeFlutterBinPath = join(realpathSync(actorDir), ".flutter_fail");
      expect(args).toContain(fakeFlutterBinPath);
    });

    it("binds the host-mounted FUSE overlay when fuse-overlayfs is present", async () => {
      const actorDir = mkdtempSync(join(tmpdir(), "actor-"));
      tempDirs.push(actorDir);
      const fakeFlutterBin = join(actorDir, "bin", "flutter");
      mkdirSync(dirname(fakeFlutterBin), { recursive: true });
      writeFileSync(fakeFlutterBin, "");

      execSyncMock.mockImplementation((command: string) => {
        if (command === "which flutter") return fakeFlutterBin;
        if (command === "pnpm store path") return "/tmp/pnpm-store\n";
        const fallback = defaultExecSyncResponse(command);
        if (fallback) return fallback;
        throw new Error(`Unexpected command: ${command}`);
      });

      process.env.MOCK_FUSE = "1";
      try {
        const { buildActorBwrapArgs } = await import("./sandbox.js");

        const { args } = buildActorBwrapArgs(actorDir);

        const pathIndex = args.indexOf("PATH");
        expect(args[pathIndex + 1]).toContain("/tmp/flutter-sdk/bin:");
        expectSetenv(args, "PUB_CACHE", "/tmp/flutter-sdk/.pub-cache");
        expect(args).toContain("/tmp/flutter-sdk");

        const flutterMnt = join(realpathSync(actorDir), ".flutter_mnt");
        expect(
          args.some(
            (a, i) =>
              a === "--bind" && args[i + 1] === flutterMnt && args[i + 2] === "/tmp/flutter-sdk"
          )
        ).toBe(true);
      } finally {
        delete process.env.MOCK_FUSE;
      }
    });

    it("teardownFlutterOverlay unmounts using fusermount3 when .flutter_mnt is present", async () => {
      const actorDir = mkdtempSync(join(tmpdir(), "actor-"));
      tempDirs.push(actorDir);

      process.env.MOCK_FUSE = "1";
      try {
        const { teardownFlutterOverlay } = await import("./sandbox.js");
        teardownFlutterOverlay(actorDir);
        expect(execFileSyncMock).toHaveBeenCalledWith(
          "fusermount3",
          ["-u", "-z", join(actorDir, ".flutter_mnt")],
          { stdio: "pipe" }
        );
      } finally {
        delete process.env.MOCK_FUSE;
      }
    });

    it("teardownFlutterOverlay falls back to fusermount when fusermount3 fails", async () => {
      const actorDir = mkdtempSync(join(tmpdir(), "actor-"));
      tempDirs.push(actorDir);

      execFileSyncMock.mockImplementation((bin: string) => {
        if (bin === "fusermount3") {
          throw new Error("fusermount3: not found");
        }
        return Buffer.from("");
      });

      process.env.MOCK_FUSE = "1";
      try {
        const { teardownFlutterOverlay } = await import("./sandbox.js");
        teardownFlutterOverlay(actorDir);
        expect(execFileSyncMock).toHaveBeenCalledWith(
          "fusermount3",
          ["-u", "-z", join(actorDir, ".flutter_mnt")],
          { stdio: "pipe" }
        );
        expect(execFileSyncMock).toHaveBeenCalledWith(
          "fusermount",
          ["-u", "-z", join(actorDir, ".flutter_mnt")],
          { stdio: "pipe" }
        );
      } finally {
        delete process.env.MOCK_FUSE;
      }
    });

    it("setupFlutterOverlay performs construction resilience by unmounting existing mount before mounting fresh ", async () => {
      const actorDir = mkdtempSync(join(tmpdir(), "actor-"));
      const hostFlutterRoot = mkdtempSync(join(tmpdir(), "flutter-root-"));
      tempDirs.push(actorDir, hostFlutterRoot);
      const flutterMnt = join(actorDir, ".flutter_mnt");
      mkdirSync(flutterMnt, { recursive: true });

      const calls: string[] = [];
      execFileSyncMock.mockImplementation((bin: string) => {
        calls.push(bin);
        return Buffer.from("");
      });

      process.env.MOCK_FUSE = "1";
      try {
        const { setupFlutterOverlay } = await import("./sandbox.js");
        const args: string[] = [];
        const result = setupFlutterOverlay(args, hostFlutterRoot, actorDir);

        expect(result.inSandboxFlutter).toBe("/tmp/flutter-sdk");
        // Must unmount with fusermount3 before mounting with fuse-overlayfs
        expect(calls[0]).toBe("fusermount3");
        expect(calls[1]).toBe("/usr/bin/fuse-overlayfs");
        expect(execFileSyncMock).toHaveBeenCalledWith("fusermount3", ["-u", "-z", flutterMnt], {
          stdio: "pipe",
        });
      } finally {
        delete process.env.MOCK_FUSE;
      }
    });
  });
});
