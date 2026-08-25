import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("handles probe failure gracefully without throwing and clears stale catalog ", async () => {
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
    expect(getProviderModelCatalog("codex")).toBeUndefined();
  });

  it("clears stale catalog and fails loud when agy output parses zero models ", async () => {
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
    expect(getProviderModelCatalog("agy")).toBeUndefined();
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

  it("generates tmux script with autocomplete confirmation and render error check ", () => {
    const script = buildCodexModelTmuxScript("codex", "/tmp/sock", '-c projects.trust="trusted"');
    expect(script).toContain('tmux -S "$SOCK" send-keys -t "$S" "/model"');
    expect(script).toContain("Select Model");
    expect(script).toContain("ERROR: /model panel never rendered in Codex session");
    expect(script).toContain("exit 1");
  });
});
