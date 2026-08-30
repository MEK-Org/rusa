import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import {
  clearProviderModelCatalog,
  getProviderModelCatalog,
  setProviderModelCatalog,
} from "./model-catalog.js";
import {
  buildCodexModelTmuxScript,
  refreshConfiguredProviderModelCatalogs,
  refreshProviderModelCatalog,
  scrapeCodexModelScreen,
} from "./model-scrape.js";

describe("refreshProviderModelCatalog", () => {
  it("probes codex and records extracted catalog", async () => {
    clearProviderModelCatalog();
    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-codex-1"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
    };

    const mockScrapeCodex = vi.fn().mockResolvedValue(`
OpenAI Codex (v0.1.0)
Model: gpt-5.6-sol (current)
  gpt-5.6-terra
`);

    // In unit test without real gemini client, LLM extraction returns unknown or we mock gemini:
    const res = await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      scrapeStore: mockStore,
      probers: {
        scrapeCodex: mockScrapeCodex,
      },
    });

    expect(mockScrapeCodex).toHaveBeenCalledWith({
      actorDir: "/tmp/test-workers/model-probe-codex",
    });
    expect(mockStore.recordRaw).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it("probes agy and records extracted catalog", async () => {
    clearProviderModelCatalog();
    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-agy-1"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
    };

    const mockScrapeAgy = vi.fn().mockResolvedValue(`
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
`);

    const res = await refreshProviderModelCatalog({
      provider: "agy",
      workersDir: "/tmp/test-workers",
      scrapeStore: mockStore,
      probers: {
        scrapeAgy: mockScrapeAgy,
      },
    });

    expect(mockScrapeAgy).toHaveBeenCalledWith({
      actorDir: "/tmp/test-workers/model-probe-agy",
    });
    expect(mockStore.recordRaw).toHaveBeenCalled();
    expect(mockStore.recordParsed).toHaveBeenCalledWith("scrape-agy-1", [
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
    ]);
    expect(res).toEqual({
      status: "known",
      entries: [
        {
          identifier: "gemini-3.7-flash-high",
          displayLabel: "Gemini 3.7 Flash (High)",
          passable: true,
        },
        {
          identifier: "gemini-3.1-pro-high",
          displayLabel: "Gemini 3.1 Pro (High)",
          passable: true,
        },
      ],
    });
  });

  it("handles probe failure gracefully without throwing and retains last-known-good catalog", async () => {
    setProviderModelCatalog("codex", [
      { displayLabel: "old-model", identifier: "old-model", passable: true },
    ]);
    const mockScrapeCodex = vi.fn().mockRejectedValue(new Error("tmux not available"));

    const res = await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      probers: {
        scrapeCodex: mockScrapeCodex,
      },
    });

    expect(res.status).toBe("unknown");
    if (res.status === "unknown") {
      expect(res.message).toContain("tmux not available");
    }
    expect(getProviderModelCatalog("codex")).toEqual([
      { displayLabel: "old-model", identifier: "old-model", passable: true },
    ]);
  });

  it("retains last-known-good catalog and records parse error when agy output parses zero models", async () => {
    setProviderModelCatalog("agy", [
      { displayLabel: "old-model", identifier: "old-model", passable: true },
    ]);
    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-agy-empty"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
    };
    const mockScrapeAgy = vi.fn().mockResolvedValue("no valid model rows here\n");

    const res = await refreshProviderModelCatalog({
      provider: "agy",
      workersDir: "/tmp/test-workers",
      scrapeStore: mockStore,
      probers: {
        scrapeAgy: mockScrapeAgy,
      },
    });

    expect(res.status).toBe("unknown");
    expect(mockStore.recordParseError).toHaveBeenCalledWith("scrape-agy-empty", expect.any(Error));
    expect(getProviderModelCatalog("agy")).toEqual([
      { displayLabel: "old-model", identifier: "old-model", passable: true },
    ]);
  });

  it("retains last-known-good catalog when no probe is implemented (e.g. claude)", async () => {
    setProviderModelCatalog("claude", [
      { displayLabel: "claude-sonnet-5", identifier: "claude-sonnet-5", passable: true },
    ]);

    const res = await refreshProviderModelCatalog({
      provider: "claude",
      workersDir: "/tmp/test-workers",
    });

    expect(res.status).toBe("unknown");
    expect(getProviderModelCatalog("claude")).toEqual([
      { displayLabel: "claude-sonnet-5", identifier: "claude-sonnet-5", passable: true },
    ]);
  });

  it("includes last scraped timestamp from getLatestParsedForProvider in warning log on probe failure", async () => {
    setProviderModelCatalog("codex", [
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol", passable: true },
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-fail-1"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
      getLatestParsedForProvider: vi.fn().mockReturnValue({
        scrapedAt: "2026-08-26T18:00:00.000Z",
        parsedModels: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol", passable: true }],
      }),
    };

    const mockScrapeCodex = vi.fn().mockRejectedValue(new Error("codex crashed"));

    const res = await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      scrapeStore: mockStore,
      probers: {
        scrapeCodex: mockScrapeCodex,
      },
    });

    expect(res.status).toBe("unknown");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "retaining last-known-good catalog (1 models, last scraped at 2026-08-26T18:00:00.000Z)"
      )
    );

    warnSpy.mockRestore();
  });
});

describe("refreshConfiguredProviderModelCatalogs", () => {
  it("probes all configured providers in config", async () => {
    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-1"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
    };

    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");
    const mockScrapeAgy = vi.fn().mockResolvedValue("agy screen");

    const config = {
      providers: {
        codex: { command: "codex" },
        agy: { command: "agy" },
      },
    } as unknown as RusaConfig;

    await refreshConfiguredProviderModelCatalogs({
      config,
      workersDir: "/tmp/test-workers",
      scrapeStore: mockStore,
      probers: {
        scrapeCodex: mockScrapeCodex,
        scrapeAgy: mockScrapeAgy,
      },
    });

    expect(mockScrapeCodex).toHaveBeenCalled();
    expect(mockScrapeAgy).toHaveBeenCalled();
  });
});

describe("scrapeCodexModelScreen", () => {
  it("launches codex with inline project trust config and captures /model menu ", async () => {
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-"));
    const mockBin = join(actorDir, "mock-codex.sh");
    writeFileSync(
      mockBin,
      `#!/bin/bash
echo "OpenAI Codex"
echo "Ask Codex to do anything"
while read -r line; do
  if [ "$line" = "/model" ]; then
    echo "Select Model and Effort"
    echo "1. gpt-5.6-sol (current)"
    echo "2. gpt-5.6-terra"
    break
  fi
done
sleep 1
`,
      { mode: 0o755 }
    );

    try {
      const output = await scrapeCodexModelScreen({
        actorDir,
        cliCommand: mockBin,
        timeoutMs: 10_000,
      });
      expect(output).toContain("Select Model and Effort");
      expect(output).toContain("gpt-5.6-sol");
      expect(output).toContain("gpt-5.6-terra");
    } finally {
      rmSync(actorDir, { recursive: true, force: true });
    }
  });

  it("handles unrendered /model menu with error and failure ", async () => {
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-unrendered-"));
    const mockBin = join(actorDir, "mock-codex-hang.sh");
    // Mock codex that displays initial banner but never renders model menu
    writeFileSync(
      mockBin,
      `#!/bin/bash
echo "OpenAI Codex"
echo "Ask Codex to do anything"
while true; do
  sleep 1
done
`,
      { mode: 0o755 }
    );

    try {
      await expect(
        scrapeCodexModelScreen({
          actorDir,
          cliCommand: mockBin,
          timeoutMs: 3_000,
        })
      ).rejects.toThrow();
    } finally {
      rmSync(actorDir, { recursive: true, force: true });
    }
  });

  it("leaves no tmux server behind when its socket is destroyed before teardown ", async () => {
    // The production leak shape. The tmux server the probe starts lives in its
    // own session, so killing the wrapper's process group cannot reach it, and
    // its socket sits under a temp dir the probe deletes on the way out. Once
    // that dir is gone, `tmux -S <sock> kill-server` can never reach the server
    // again - a transient miss becomes a permanent orphan holding an inotify
    // instance. Destroying the socket mid-probe reproduces that deterministically.
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-orphan-"));
    const mockBin = join(actorDir, "mock-codex-hang.sh");
    writeFileSync(
      mockBin,
      `#!/bin/bash
echo "OpenAI Codex"
echo "Ask Codex to do anything"
while true; do
  sleep 1
done
`,
      { mode: 0o755 }
    );

    const probeDirs = () =>
      new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("rusa-codex-model-")));
    // Match only the daemonised server: its argv carries the expanded socket
    // path, where the wrapper shell's argv still holds the literal "$SOCK".
    // Scoping to this probe's own socket also keeps a shared box's other runs
    // from being read as our orphans.
    const serversFor = (sock: string) =>
      execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.includes(`-S ${sock} new-session`));

    const before = probeDirs();
    // The probe creates its temp dir synchronously, so it is observable as soon
    // as the call returns a promise.
    const pending = scrapeCodexModelScreen({
      actorDir,
      cliCommand: mockBin,
      timeoutMs: 4_000,
    });
    // Keep an early assertion failure from surfacing as an unhandled rejection:
    // the probe is still in flight and will reject once its deadline lands.
    pending.catch(() => {});
    const created = [...probeDirs()].filter((n) => !before.has(n));
    expect(created).toHaveLength(1);
    const tempHome = join(tmpdir(), created[0]);
    const sock = join(tempHome, "model-tmux.sock");

    try {
      for (let i = 0; i < 100 && serversFor(sock).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(serversFor(sock).length).toBeGreaterThan(0);

      // Slam the door: the socket is gone, so no kill-server can ever land.
      rmSync(tempHome, { recursive: true, force: true });
      await expect(pending).rejects.toThrow();

      for (let i = 0; i < 150 && serversFor(sock).length > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(serversFor(sock)).toEqual([]);
    } finally {
      // A failing run deliberately creates an unreapable server; never let one
      // escape onto the shared box.
      for (const line of serversFor(sock)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid)) spawnSync("kill", ["-9", String(pid)]);
      }
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(actorDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("generates tmux script with autocomplete confirmation and render error check ", () => {
    const script = buildCodexModelTmuxScript(
      "codex",
      "/tmp/sock",
      '-c projects.trust="trusted"',
      90
    );
    // The session's command carries its own deadline, so an abandoned probe
    // tree reaps itself even if nothing else ever kills it - and the server
    // starts on stock settings, since that self-reaping relies on exit-empty
    // being on and a user tmux.conf is free to turn it off.
    expect(script).toContain('timeout --kill-after=5 90 "codex"');
    expect(script).toContain('tmux -f /dev/null -S "$SOCK" new-session');
    expect(script).toContain("Ask Codex to do anything");
    expect(script).toContain("ERROR: composer never became ready in Codex session");
    expect(script).toContain('tmux -S "$SOCK" send-keys -t "$S" -l "/model"');
    expect(script).toContain("Select Model");
    expect(script).toContain("ERROR: /model panel never rendered in Codex session");
    expect(script).toContain("exit 1");
  });
});
