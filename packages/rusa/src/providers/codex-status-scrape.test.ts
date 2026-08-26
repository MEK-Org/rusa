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
const writeFileSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

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
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  rmSync: (...args: unknown[]) => rmSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  readFileSync: vi.fn().mockReturnValue(""),
  default: {
    mkdtempSync: (...args: unknown[]) => mkdtempSyncMock(...args),
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    rmSync: (...args: unknown[]) => rmSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    readFileSync: vi.fn().mockReturnValue(""),
  },
}));

import {
  buildTmuxScript,
  scrapeCodexStatus,
  type TmuxScriptTiming,
} from "./codex-status-scrape.js";

describe("codex-status-scrape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdtempSyncMock.mockReturnValue("/tmp/test-codex-home");
    existsSyncMock.mockReturnValue(false);
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

    it("resolves stdout when the scrape process exits with 0", async () => {
      const mockChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
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
  });
});
