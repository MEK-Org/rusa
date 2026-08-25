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

      // Verify panel readiness grep
      expect(script).toContain("limit:|hit your usage limit|refresh requested|run /status again");

      // Verify error exit behavior: does not capture-pane unrendered popup on failure
      const errorBlock = script.slice(script.indexOf('if [ "$rendered" -eq 0 ]; then'));
      const errorBranch = errorBlock.slice(0, errorBlock.indexOf("fi"));
      expect(errorBranch).toContain(
        'echo "ERROR: /status panel never rendered in Codex session" >&2'
      );
      expect(errorBranch).toContain("exit 1");
      expect(errorBranch).not.toContain("capture-pane");
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
