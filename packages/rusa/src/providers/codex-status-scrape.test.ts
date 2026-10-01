import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock intercepts ESM imports of node:fs / node:child_process (below), but the
// fake-tmux end-to-end tests need the REAL modules to touch disk and spawn a shell.
// A CJS require is not intercepted by vi.mock, so it yields the genuine builtins.
const nodeRequire = createRequire(import.meta.url);

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const mkdtempSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const lstatSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const symlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const readlinkSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  default: {
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  },
}));

vi.mock("node:fs", () => ({
  mkdtempSync: (...args: unknown[]) => mkdtempSyncMock(...args),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  lstatSync: (...args: unknown[]) => lstatSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  rmSync: (...args: unknown[]) => rmSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  symlinkSync: (...args: unknown[]) => symlinkSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
  readlinkSync: (...args: unknown[]) => readlinkSyncMock(...args),
  default: {
    mkdtempSync: (...args: unknown[]) => mkdtempSyncMock(...args),
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    lstatSync: (...args: unknown[]) => lstatSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    rmSync: (...args: unknown[]) => rmSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    symlinkSync: (...args: unknown[]) => symlinkSyncMock(...args),
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
    readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
    readlinkSync: (...args: unknown[]) => readlinkSyncMock(...args),
  },
}));

const leaseMock = vi.fn();
const revokeMock = vi.fn();
let brokerOn = false;

vi.mock("./codex-auth-broker.js", () => ({
  CODEX_REFRESH_URL_ENV: "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
  activeCodexAuthBroker: () => (brokerOn ? { lease: leaseMock } : undefined),
  writeCodexLeaseAuth: (dir: string, lease: { authJson: string }) => {
    writeFileSyncMock(`${dir}/auth.json`, lease.authJson, { mode: 0o600 });
    return `${dir}/auth.json`;
  },
}));

import type { Logger } from "../observability/logger.js";
import {
  buildTmuxScript,
  detectProcessesReferencingHome,
  isProcessReferencingHome,
  scrapeCodexStatus,
  setCodexScrapeLogger,
  supportsNoDaemon,
  type TmuxScriptTiming,
} from "./codex-status-scrape.js";

describe("codex-status-scrape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdtempSyncMock.mockReturnValue("/tmp/test-codex-home");
    existsSyncMock.mockReturnValue(false);
    lstatSyncMock.mockReturnValue({ isSymbolicLink: () => true });
    readFileSyncMock.mockReturnValue("");
    readdirSyncMock.mockReturnValue([]);
    readlinkSyncMock.mockReturnValue("");
  });

  describe("buildTmuxScript", () => {
    it("generates a bash script that handles autocomplete popup consumption and confirms submit", () => {
      const script = buildTmuxScript("codex", "/tmp/test.sock");

      // Verify tmux session creation
      expect(script).toContain('tmux -S "$SOCK" new-session -d -s "$S" -x 120 -y 50 "codex"');

      // Verify TUI ready poll
      expect(script).toContain('grep -q "OpenAI Codex"');

      // Verify initial /status command and Enter
      expect(script).toContain('send-keys -t "$S" "/status"');
      expect(script).toContain('send-keys -t "$S" Enter');

      // Verify submit-confirmation / autocomplete handling
      expect(script).toContain("show current session|/statusline|configure which items");
      expect(script).toContain("(›|>)[[:space:]]*/status");

      // A real limits table / exhaustion banner is detected separately from the
      // "refresh requested" placeholder — the placeholder must NOT count as a
      // successful reading (issue #8).
      expect(script).toContain('grep -qE "limit:|hit your usage limit"');
      expect(script).toContain('grep -qE "refresh requested|run /status again"');

      // Verify error exit behavior: only errors when NEITHER a real table nor a
      // placeholder ever rendered, and does not capture-pane on that failure.
      const errorBlock = script.slice(
        script.indexOf('if [ "$rendered" -eq 0 ] && [ "$placeholder_seen" -eq 0 ]; then')
      );
      const errorBranch = errorBlock.slice(0, errorBlock.indexOf("fi"));
      expect(errorBranch).toContain(
        'echo "ERROR: /status panel never rendered in Codex session" >&2'
      );
      expect(errorBranch).toContain("exit 1");
      expect(errorBranch).not.toContain("capture-pane");
    });

    it("runs without background daemon (issue #779)", () => {
      const script = buildTmuxScript("codex", "/tmp/test.sock");
      expect(script).toContain("--no-daemon");
      expect(script).not.toContain("--disable daemon_auto_start");
    });

    it("omits --no-daemon for a CLI whose help does not advertise it", () => {
      const script = buildTmuxScript("codex", "/tmp/test.sock", {}, false);
      expect(script).toContain('tmux -S "$SOCK" new-session -d -s "$S" -x 120 -y 50 "codex"');
      expect(script).not.toContain(
        'tmux -S "$SOCK" new-session -d -s "$S" -x 120 -y 50 "codex" --no-daemon'
      );
    });

    it("retries /status within a bounded budget when only the refresh placeholder renders", () => {
      const script = buildTmuxScript("codex", "/tmp/test.sock");

      // A bounded whole-script budget bounds the retry loop (kept below the 90s
      // Node wall-clock).
      expect(script).toContain("BUDGET_S=80");

      // The retry loop re-issues /status while the budget allows.
      expect(script).toContain('while [ "$SECONDS" -lt "$BUDGET_S" ]; do');
      expect(script).toContain("attempt_status");

      // A real table stops the loop; a bare placeholder does not (it only records
      // placeholder_seen and waits for codex's async refresh before re-issuing).
      expect(script).toContain("rendered=1");
      expect(script).toContain("placeholder_seen=1");

      // AUTH-SAFETY: every retry is still /status, never /usage.
      expect(script).not.toContain("/usage");
    });
  });

  describe("--no-daemon capability detection (issue #779)", () => {
    const probeEnv = { CODEX_HOME: "/tmp/isolated-codex-home" };

    it("picks up an in-place CLI upgrade between probes", () => {
      spawnSyncMock
        .mockReturnValueOnce({ status: 0, stdout: "Usage: codex\n", stderr: "" })
        .mockReturnValueOnce({
          status: 0,
          stdout: "Usage: codex\n  --no-daemon\n",
          stderr: "",
        });

      expect(supportsNoDaemon("codex-upgrade-test", probeEnv)).toBe(false);
      expect(supportsNoDaemon("codex-upgrade-test", probeEnv)).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(spawnSyncMock).toHaveBeenNthCalledWith(1, "codex-upgrade-test", ["--help"], {
        encoding: "utf8",
        env: probeEnv,
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(spawnSyncMock).toHaveBeenNthCalledWith(2, "codex-upgrade-test", ["--help"], {
        encoding: "utf8",
        env: probeEnv,
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

    it("does not use the flag when a CLI help result lacks it", () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: "Usage: codex\n", stderr: "" });
      expect(supportsNoDaemon("codex-without-daemon-test", probeEnv)).toBe(false);
    });

    it("falls back when the bounded capability probe fails", () => {
      spawnSyncMock.mockReturnValue({ status: 2, stdout: "", stderr: "unknown option" });
      expect(supportsNoDaemon("codex-failed-help-test", probeEnv)).toBe(false);
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  // Execute the ACTUAL generated bash against a fake `tmux` that scripts codex's
  // pane across successive /status sends. This exercises the real control flow —
  // does `saw_ph` gate the retry, does a real table stop it, does a non-placeholder
  // no-render exit 1, is `/usage` ever sent — rather than asserting on script
  // substrings (which pass even when the logic is wrong). buildTmuxScript's
  // overridable timing bounds shrink the budget/backoffs so these stay fast.
  describe("retry control flow against a fake tmux (issue #8, end-to-end)", () => {
    const FAKE_TMUX = [
      "#!/usr/bin/env bash",
      "set -u",
      'STATE="$FAKE_TMUX_STATE"',
      'CNT="$STATE/status_count"',
      // The tmux subcommand is the 3rd arg (after `-S <sock>`).
      'sub="$3"',
      'case "$sub" in',
      "  kill-server) exit 0 ;;",
      "  new-session) printf '0' > \"$CNT\"; exit 0 ;;",
      "  send-keys)",
      // Classify the key payload by scanning all args (avoids ${...} expansions).
      '    case " $* " in',
      '      *" /status "*)',
      '        n=$(cat "$CNT" 2>/dev/null || printf 0)',
      '        printf "%s" "$((n+1))" > "$CNT" ;;',
      '      *" /usage "*) : > "$STATE/USAGE_VIOLATION" ;;',
      "    esac",
      "    exit 0 ;;",
      "  capture-pane)",
      '    n=$(cat "$CNT" 2>/dev/null || printf 0)',
      // Always render the banner so the TUI-ready wait clears.
      "    printf 'OpenAI Codex\\n'",
      '    case "$FAKE_TMUX_SCENARIO" in',
      // First /status → placeholder; second /status → a real limits table.
      "      placeholder_then_real)",
      '        if [ "$n" -ge 2 ]; then',
      "          printf '5h limit: 1%% used\\nWeekly limit: 7%% used\\n'",
      '        elif [ "$n" -ge 1 ]; then',
      "          printf 'Limits: refresh requested; run /status again shortly.\\n'",
      "        fi ;;",
      // Every /status → placeholder, forever.
      "      persistent_placeholder)",
      '        if [ "$n" -ge 1 ]; then',
      "          printf 'Limits: refresh requested; run /status again shortly.\\n'",
      "        fi ;;",
      // Nothing but the banner ever renders.
      "      never_render) : ;;",
      "    esac",
      "    exit 0 ;;",
      "esac",
      "exit 0",
    ].join("\n");

    async function runScript(scenario: string, timing: TmuxScriptTiming) {
      const fs = nodeRequire("node:fs") as typeof import("node:fs");
      const cp = nodeRequire("node:child_process") as typeof import("node:child_process");
      const os = nodeRequire("node:os") as typeof import("node:os");
      const path = nodeRequire("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-scrape-faketmux-"));
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(dir, "tmux"), FAKE_TMUX, { mode: 0o755 });
      const script = buildTmuxScript("codex", path.join(dir, "probe.sock"), timing);
      const res = cp.spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FAKE_TMUX_STATE: stateDir,
          FAKE_TMUX_SCENARIO: scenario,
        },
      });
      let statusSends = 0;
      try {
        statusSends = Number(
          fs.readFileSync(path.join(stateDir, "status_count"), "utf-8").trim() || "0"
        );
      } catch {
        statusSends = 0;
      }
      const out = {
        code: res.status,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        statusSends,
        usageSent: fs.existsSync(path.join(stateDir, "USAGE_VIOLATION")),
      };
      fs.rmSync(dir, { recursive: true, force: true });
      return out;
    }

    it("recovers a real table when the first /status is a placeholder, by re-issuing in-session", async () => {
      const r = await runScript("placeholder_then_real", {
        budgetS: 6,
        attemptSecs: 3,
        backoffSecs: 0,
        bannerTries: 5,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("5h limit:");
      // It re-issued /status in-session (>=2 sends) instead of giving up on the first.
      expect(r.statusSends).toBeGreaterThanOrEqual(2);
      expect(r.usageSent).toBe(false);
    });

    it("captures the pending panel and exits 0 when only the placeholder ever renders", async () => {
      const r = await runScript("persistent_placeholder", {
        budgetS: 3,
        attemptSecs: 2,
        backoffSecs: 0,
        bannerTries: 5,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("refresh requested");
      // Bounded retry: it re-issued /status at least once while placeholders persisted.
      expect(r.statusSends).toBeGreaterThanOrEqual(2);
      expect(r.usageSent).toBe(false);
    });

    it("exits 1 without retrying when nothing recognizable ever renders", async () => {
      const r = await runScript("never_render", {
        budgetS: 4,
        attemptSecs: 1,
        backoffSecs: 0,
        bannerTries: 5,
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("never rendered");
      // A non-placeholder no-render is a hard stop, not a placeholder-style retry:
      // exactly one /status attempt, and never /usage.
      expect(r.statusSends).toBe(1);
      expect(r.usageSent).toBe(false);
    });
  });

  describe("scrapeCodexStatus", () => {
    it("rejects when the underlying scrape process exits with a non-zero code", async () => {
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });

      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.emit("close", 1);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      await expect(
        scrapeCodexStatus({
          actorDir: "/tmp/actor",
          codexConfigDir: "/tmp/codex-config",
        })
      ).rejects.toThrow("codex /status scrape failed with exit code 1");
    });

    it("names the failing stage from the script's stderr on a non-zero exit", async () => {
      // The coordinator only ever sees this message. Without the stderr tail a
      // codex TUI that never launched and a panel that never parsed both read
      // as "exit code 1", which is the failure mode #517's production evidence
      // showed for hours on end.
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });

      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.stderr.emit(
            "data",
            Buffer.from("ERROR: /status panel never rendered in Codex session\n")
          );
          mockChild.emit("close", 1);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      await expect(
        scrapeCodexStatus({
          actorDir: "/tmp/actor",
          codexConfigDir: "/tmp/codex-config",
        })
      ).rejects.toThrow(
        "codex /status scrape failed with exit code 1: ERROR: /status panel never rendered in Codex session"
      );
    });

    it("resolves stdout when the scrape process exits with 0", async () => {
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });

      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.stdout.emit("data", Buffer.from("rendered 5h limit: 99% left\n"));
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      const output = await scrapeCodexStatus({
        actorDir: "/tmp/actor",
        codexConfigDir: "/tmp/codex-config",
      });

      expect(output).toBe("rendered 5h limit: 99% left\n");
    });

    it("launches an older CLI without --no-daemon when its help lacks that flag", async () => {
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });
      spawnSyncMock.mockImplementation((command: unknown) => {
        if (command === "codex-0.144.4-test") {
          return { status: 0, stdout: "Usage: codex\n", stderr: "" };
        }
      });
      spawnMock.mockImplementation((_command, _args) => {
        setTimeout(() => {
          mockChild.stdout.emit("data", Buffer.from("rendered 5h limit: 99% left\n"));
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      await scrapeCodexStatus({
        actorDir: "/tmp/actor",
        cliCommand: "codex-0.144.4-test",
        codexConfigDir: "/tmp/codex-config",
      });

      const script = String(spawnMock.mock.calls[0]?.[1]?.[1]);
      expect(script).toContain('new-session -d -s "$S" -x 120 -y 50 "codex-0.144.4-test"');
      expect(script).not.toContain('"codex-0.144.4-test" --no-daemon');
    });

    it("runs the capability probe in the isolated home, never an inherited CODEX_HOME (issue #781)", async () => {
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });
      spawnSyncMock.mockReturnValue({ status: 0, stdout: "Usage: codex\n", stderr: "" });
      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.stdout.emit("data", Buffer.from("rendered 5h limit: 99% left\n"));
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      const origCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = "/tmp/ambient-live-codex-home";
      try {
        await scrapeCodexStatus({
          actorDir: "/tmp/actor",
          cliCommand: "codex-env-pin-test",
          codexConfigDir: "/tmp/codex-config",
        });
      } finally {
        if (origCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = origCodexHome;
      }

      const probe = spawnSyncMock.mock.calls.find(
        ([command, args]) => command === "codex-env-pin-test" && String(args) === "--help"
      );
      expect(probe?.[2]?.env?.CODEX_HOME).toBe("/tmp/test-codex-home");
      expect(spawnMock.mock.calls[0]?.[2]?.env?.CODEX_HOME).toBe("/tmp/test-codex-home");
    });

    it("symlinks the host auth.json into the isolated codex home when it exists", async () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith("auth.json"));

      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });

      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.stdout.emit("data", Buffer.from("rendered 5h limit: 99% left\n"));
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      await scrapeCodexStatus({
        actorDir: "/tmp/actor",
        codexConfigDir: "/tmp/codex-config",
      });

      expect(symlinkSyncMock).toHaveBeenCalledWith(
        expect.stringContaining("/tmp/codex-config/auth.json"),
        "/tmp/test-codex-home/auth.json"
      );
    });

    it("with the broker on, seeds a leased copy instead of the shared symlink and revokes it", async () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith("auth.json"));
      lstatSyncMock.mockReturnValue({ isSymbolicLink: () => false });
      leaseMock.mockResolvedValue({
        authJson: '{"tokens":{"refresh_token":"rusa-cap-fixture"}}',
        refreshUrl: "http://127.0.0.1:4555/oauth/token",
        revoke: revokeMock,
      });
      brokerOn = true;
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });
      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.stdout.emit("data", Buffer.from("rendered 5h limit: 99% left\n"));
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      try {
        await scrapeCodexStatus({ actorDir: "/tmp/actor", codexConfigDir: "/tmp/codex-config" });
      } finally {
        brokerOn = false;
      }

      expect(symlinkSyncMock).not.toHaveBeenCalled();
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        "/tmp/test-codex-home/auth.json",
        '{"tokens":{"refresh_token":"rusa-cap-fixture"}}',
        { mode: 0o600 }
      );
      const env = spawnMock.mock.calls[0]?.[2]?.env;
      expect(env?.CODEX_HOME).toBe("/tmp/test-codex-home");
      expect(env?.CODEX_REFRESH_TOKEN_URL_OVERRIDE).toBe("http://127.0.0.1:4555/oauth/token");
      expect(revokeMock).toHaveBeenCalledTimes(1);
    });

    it("with the broker on, rejects rather than falling back when the lease fails", async () => {
      leaseMock.mockRejectedValue(
        new Error("codex auth broker cannot read the canonical auth.json")
      );
      brokerOn = true;
      try {
        await expect(
          scrapeCodexStatus({ actorDir: "/tmp/actor", codexConfigDir: "/tmp/codex-config" })
        ).rejects.toThrow(/canonical auth\.json/);
      } finally {
        brokerOn = false;
      }
      expect(symlinkSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("logs diagnostic warning if lingering processes reference codexHome during cleanup", async () => {
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
      });

      spawnMock.mockImplementation(() => {
        setTimeout(() => {
          mockChild.stdout.emit("data", Buffer.from("rendered 5h limit: 99% left\n"));
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as unknown as childProcess.ChildProcess;
      });

      readdirSyncMock.mockReturnValue(["99999"]);
      readFileSyncMock.mockReturnValue("/tmp/test-codex-home/app-server --managed-daemon");
      const logs: { event: string; fields?: Record<string, unknown> }[] = [];
      const testLogger = {
        warn: (event: string, fields?: Record<string, unknown>) => {
          logs.push({ event, fields });
        },
      } as unknown as Logger;
      setCodexScrapeLogger(testLogger);

      try {
        await scrapeCodexStatus({
          actorDir: "/tmp/actor",
          codexConfigDir: "/tmp/codex-config",
        });

        expect(
          logs.some((l) => l.event === "lingering_codex_home_processes" && l.fields?.count === 1)
        ).toBe(true);
        expect(rmSyncMock).toHaveBeenCalledWith("/tmp/test-codex-home", {
          recursive: true,
          force: true,
        });
      } finally {
        setCodexScrapeLogger(undefined);
      }
    });
  });

  describe("process detection and cleanup diagnostics (issue #779)", () => {
    it.each([
      { pid: 0, home: "/tmp/home", cmd: "", cwd: "", expected: false, name: "system pid 0" },
      { pid: 1, home: "/tmp/home", cmd: "", cwd: "", expected: false, name: "init pid 1" },
      { pid: process.pid, home: "/tmp/home", cmd: "", cwd: "", expected: false, name: "self pid" },
      {
        pid: process.ppid,
        home: "/tmp/home",
        cmd: "",
        cwd: "",
        expected: false,
        name: "parent pid",
      },
      { pid: 54321, home: "", cmd: "/tmp/home", cwd: "", expected: false, name: "empty home" },
      {
        pid: 54321,
        home: "/tmp/home",
        cmd: "codex --listen unix:///tmp/home/app.sock",
        cwd: "",
        expected: true,
        name: "cmdline match",
      },
      {
        pid: 54321,
        home: "/tmp/home",
        cmd: "codex",
        cwd: "/tmp/home/subpath",
        expected: true,
        name: "cwd match",
      },
      {
        pid: 54321,
        home: "/tmp/home",
        cmd: "unrelated",
        cwd: "/var/log",
        expected: false,
        name: "unrelated process",
      },
    ])("isProcessReferencingHome correctly classifies $name", ({
      pid,
      home,
      cmd,
      cwd,
      expected,
    }) => {
      readFileSyncMock.mockReturnValue(cmd);
      readlinkSyncMock.mockReturnValue(cwd);
      expect(isProcessReferencingHome(pid, home)).toBe(expected);
    });

    it("isProcessReferencingHome handles unreadable /proc entries gracefully", () => {
      readFileSyncMock.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      readlinkSyncMock.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(isProcessReferencingHome(54321, "/tmp/home")).toBe(false);
    });

    it("detectProcessesReferencingHome returns matching pids without killing", () => {
      readdirSyncMock.mockReturnValue(["100", "200", "not-a-pid"]);
      readFileSyncMock.mockImplementation((p: unknown) => {
        if (String(p).includes("/100/cmdline")) return "app-server /tmp/target-home";
        return "unrelated-process";
      });
      readlinkSyncMock.mockReturnValue("/other/dir");

      const matches = detectProcessesReferencingHome("/tmp/target-home");
      expect(matches).toEqual([100]);
    });

    it("detectProcessesReferencingHome returns empty array on empty home or unreadable /proc", () => {
      expect(detectProcessesReferencingHome("")).toEqual([]);
      readdirSyncMock.mockImplementation(() => {
        throw new Error("EACCES");
      });
      expect(detectProcessesReferencingHome("/tmp/home")).toEqual([]);
    });
  });
});
