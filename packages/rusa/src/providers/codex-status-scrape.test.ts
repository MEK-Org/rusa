import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { buildTmuxScript, scrapeCodexStatus } from "./codex-status-scrape.js";

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
