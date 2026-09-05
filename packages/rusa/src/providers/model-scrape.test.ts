import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import {
  clearProviderModelCatalog,
  getProviderModelCatalog,
  setProviderModelCatalog,
} from "./model-catalog.js";
import {
  buildCodexModelTmuxScript,
  describeCodexScrapeFailure,
  refreshConfiguredProviderModelCatalogs,
  refreshProviderModelCatalog,
  scrapeCodexModelScreen,
} from "./model-scrape.js";
import {
  groupStillHosts,
  processTable,
  reapProcess,
  reapProcessGroup,
  unsafeGroupReason,
} from "./test-support/process-group-cleanup.js";

/**
 * Every codex refresh now reads the CLI's models cache before it considers the
 * TUI, and `CODEX_HOME` is how codex itself says where that cache lives. Tests
 * point it at a directory they own so a suite never reads - or is decided by -
 * whatever cache the machine running it happens to have.
 */
const codexHomes: string[] = [];

/**
 * The version the stubbed codex reports. A cache is only trusted when it names
 * the installed client, so a suite must decide what "installed" means rather
 * than inheriting whatever codex the machine running it happens to have.
 */
const STUB_CODEX_VERSION = "9.9.9-test";

/** Puts a codex on PATH that reports `version` and does nothing else. */
function stubInstalledCodex(version: string = STUB_CODEX_VERSION): void {
  const dir = mkdtempSync(join(tmpdir(), "codex-bin-test-"));
  codexHomes.push(dir);
  writeFileSync(join(dir, "codex"), `#!/bin/bash\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
}

function stubCodexHome(cache?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-home-test-"));
  codexHomes.push(dir);
  if (cache !== undefined) {
    writeFileSync(
      join(dir, "models_cache.json"),
      typeof cache === "string" ? cache : JSON.stringify(cache)
    );
  }
  vi.stubEnv("CODEX_HOME", dir);
  stubInstalledCodex();
  return dir;
}

/** A cache the freshness rule accepts, listing exactly the given slugs. */
function freshCache(slugs: string[]) {
  return {
    fetched_at: new Date().toISOString(),
    client_version: STUB_CODEX_VERSION,
    models: [
      ...slugs.map((slug) => ({ slug, display_name: slug.toUpperCase(), visibility: "list" })),
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (codexHomes.length > 0) {
    const dir = codexHomes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("refreshProviderModelCatalog", () => {
  it("probes codex and records extracted catalog", async () => {
    clearProviderModelCatalog();
    stubCodexHome();
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
    stubCodexHome();
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
      { displayLabel: "gemini-old-model", identifier: "gemini-old-model", passable: true },
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
      {
        displayLabel: "gemini-old-model",
        identifier: "gemini-old-model",
        passable: true,
        efforts: [],
      },
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
    stubCodexHome();
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

  it("takes the codex catalog from the CLI's own models cache without starting a TUI", async () => {
    clearProviderModelCatalog();
    stubCodexHome(freshCache(["gpt-5.6-sol", "gpt-5.5"]));
    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-codex-cache"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
    };
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");

    const res = await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      scrapeStore: mockStore,
      probers: { scrapeCodex: mockScrapeCodex },
    });

    // The whole point of the cheap source: a usable cache means no codex start,
    // no PTY, and no keystroke race for a list that was already on disk.
    expect(mockScrapeCodex).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: "known",
      entries: [
        { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol", passable: true },
        { displayLabel: "gpt-5.5", identifier: "gpt-5.5", passable: true },
      ],
    });
    expect(getProviderModelCatalog("codex")).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol", passable: true },
      { displayLabel: "gpt-5.5", identifier: "gpt-5.5", passable: true },
    ]);
    expect(mockStore.recordRaw).toHaveBeenCalled();
  });

  it("falls back to the TUI when the cache is malformed", async () => {
    clearProviderModelCatalog();
    stubCodexHome("{ this is not json");
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");

    await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      probers: { scrapeCodex: mockScrapeCodex },
    });

    expect(mockScrapeCodex).toHaveBeenCalled();
  });

  it("falls back to the TUI when the cache is too old to trust", async () => {
    clearProviderModelCatalog();
    stubCodexHome({
      fetched_at: "2026-09-03T12:00:00.000Z",
      client_version: STUB_CODEX_VERSION,
      models: [{ slug: "gpt-5.6-sol", visibility: "list" }],
    });
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");

    await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      probers: { scrapeCodex: mockScrapeCodex },
    });

    // A stale cache means codex has not started in a day; the fallback both gets
    // an answer now and restarts codex, which is what rewrites the cache.
    expect(mockScrapeCodex).toHaveBeenCalled();
  });

  it("falls back to the TUI when the cache belongs to a different codex build", async () => {
    // The upgrade window: `npm i -g` replaces the binary and leaves the cache
    // untouched, so a cache-first refresh would keep serving the previous
    // build's model list - for up to a day, and precisely across the moment the
    // list is most likely to have changed. Age cannot see this; the
    // client_version the cache carries can.
    clearProviderModelCatalog();
    stubCodexHome({ ...freshCache(["gpt-5.5"]), client_version: "0.1.0-previous" });
    const mockScrapeCodex = vi.fn().mockRejectedValue(new Error("tui unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await refreshProviderModelCatalog({
        provider: "codex",
        workersDir: "/tmp/test-workers",
        probers: { scrapeCodex: mockScrapeCodex },
      });

      expect(mockScrapeCodex).toHaveBeenCalled();
      if (res.status !== "unknown") throw new Error(`expected unknown, got ${res.status}`);
      // The fallback message names the stage, not the versions: the cache's
      // client_version is vendor-written text and this string is logged.
      expect(res.message).toContain(
        "fell back to the /model TUI because codex models cache was written by a different codex client version than the one installed"
      );
      expect(res.message).not.toContain("0.1.0-previous");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses the cache when it names the codex that is installed now", async () => {
    clearProviderModelCatalog();
    stubCodexHome(freshCache(["gpt-5.6-sol"]));
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");

    const res = await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      probers: { scrapeCodex: mockScrapeCodex },
    });

    expect(mockScrapeCodex).not.toHaveBeenCalled();
    expect(res.entries).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol", passable: true },
    ]);
  });

  it("declines the cache when no installed codex version can be read", async () => {
    // Unattributable is not the same as fresh: without a version to compare
    // against, nothing establishes that this file describes the codex that
    // would answer a pin.
    clearProviderModelCatalog();
    stubCodexHome(freshCache(["gpt-5.5"]));
    const emptyBin = mkdtempSync(join(tmpdir(), "codex-bin-none-"));
    codexHomes.push(emptyBin);
    vi.stubEnv("PATH", emptyBin);
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");

    await refreshProviderModelCatalog({
      provider: "codex",
      workersDir: "/tmp/test-workers",
      probers: { scrapeCodex: mockScrapeCodex },
    });

    expect(mockScrapeCodex).toHaveBeenCalled();
  });

  it("names both the declined cache and the failing TUI stage when everything fails", async () => {
    stubCodexHome("{ this is not json");
    setProviderModelCatalog("codex", [
      { displayLabel: "gpt-5.4", identifier: "gpt-5.4", passable: true },
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await refreshProviderModelCatalog({
        provider: "codex",
        workersDir: "/tmp/test-workers",
        probers: {
          scrapeCodex: vi
            .fn()
            .mockRejectedValue(
              new Error(
                "codex /model scrape failed with exit code 1: /model was submitted but the model panel never rendered"
              )
            ),
        },
      });

      if (res.status !== "unknown") throw new Error(`expected unknown, got ${res.status}`);
      // One line an operator can act on: which cheap source was declined, and
      // how far the fallback got before giving up.
      expect(res.message).toContain("the model panel never rendered");
      expect(res.message).toContain("codex models cache is not a JSON document");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("retaining last-known-good catalog")
      );
      expect(getProviderModelCatalog("codex")).toEqual([
        { displayLabel: "gpt-5.4", identifier: "gpt-5.4", passable: true },
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("refreshConfiguredProviderModelCatalogs", () => {
  it("probes all configured providers in config", async () => {
    stubCodexHome();
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

  it("hands every prober the caller's abort signal", async () => {
    stubCodexHome();
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");
    const mockScrapeAgy = vi.fn().mockResolvedValue("agy screen");
    const controller = new AbortController();

    const config = {
      providers: { codex: { command: "codex" }, agy: { command: "agy" } },
    } as unknown as RusaConfig;

    await refreshConfiguredProviderModelCatalogs({
      config,
      workersDir: "/tmp/test-workers",
      signal: controller.signal,
      probers: { scrapeCodex: mockScrapeCodex, scrapeAgy: mockScrapeAgy },
    });

    // Identity, not just presence: the probers honour a signal already, so what
    // was broken is that they were handed nobody's - the owner's signal has to
    // arrive intact at the leaf for an abort to reach a running probe.
    expect(mockScrapeCodex.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
    expect(mockScrapeAgy.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it("starts no probe at all when the signal is already aborted", async () => {
    const mockScrapeCodex = vi.fn().mockResolvedValue("codex screen");
    const mockScrapeAgy = vi.fn().mockResolvedValue("agy screen");
    const controller = new AbortController();
    controller.abort();

    const config = {
      providers: { codex: { command: "codex" }, agy: { command: "agy" } },
    } as unknown as RusaConfig;

    await refreshConfiguredProviderModelCatalogs({
      config,
      workersDir: "/tmp/test-workers",
      signal: controller.signal,
      probers: { scrapeCodex: mockScrapeCodex, scrapeAgy: mockScrapeAgy },
    });

    // Aborting a probe that never started is not the same as not starting it:
    // a spawned-then-aborted codex probe still leaves a temp dir behind.
    expect(mockScrapeCodex).not.toHaveBeenCalled();
    expect(mockScrapeAgy).not.toHaveBeenCalled();
  });

  it("reports an aborted provider as unknown without logging a provider failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await refreshProviderModelCatalog({
        provider: "codex",
        workersDir: "/tmp/test-workers",
        signal: controller.signal,
        probers: { scrapeCodex: vi.fn().mockResolvedValue("codex screen") },
      });

      expect(res.status).toBe("unknown");
      // A restart aborts one probe per configured provider. Routing that through
      // the failure log would print an error line per provider on every restart,
      // for a decision the owner made itself.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // The two above abort BEFORE the probe starts, which the pre-entry guard catches.
  // These abort a probe that is already running - the case #89 is actually about, and
  // the one where the leaf rejects and the rejection reaches a catch. A prober that
  // only settles on abort is what makes "in flight" real rather than a comment.
  const blockedProber = (controller: AbortController) =>
    vi.fn(
      (o: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          o.signal?.addEventListener("abort", () => reject(new Error("probe aborted")));
          controller.abort();
        })
    );

  it("stays quiet when codex is aborted mid-probe, not just before it starts", async () => {
    stubCodexHome();
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await refreshProviderModelCatalog({
        provider: "codex",
        workersDir: "/tmp/test-workers",
        signal: controller.signal,
        probers: { scrapeCodex: blockedProber(controller) },
      });

      // Narrowed rather than asserted: `message` lives only on the unknown arm of
      // ModelCatalogExtraction, so this also pins that an aborted probe never comes
      // back as `known`.
      if (res.status !== "unknown") throw new Error(`expected unknown, got ${res.status}`);
      expect(res.message).toBe("model probe aborted");
      // Indistinguishable from the pre-entry abort: same owner decision, same silence.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("stays quiet when agy is aborted mid-probe", async () => {
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await refreshProviderModelCatalog({
        provider: "agy",
        workersDir: "/tmp/test-workers",
        signal: controller.signal,
        probers: { scrapeAgy: blockedProber(controller) },
      });

      if (res.status !== "unknown") throw new Error(`expected unknown, got ${res.status}`);
      expect(res.message).toBe("model probe aborted");
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("still reports a genuine probe failure loudly", async () => {
    // The other half of the branch: silence is conditioned on the OWNER having
    // aborted, so an ordinary rejection must not inherit it. Without this, adding
    // the quiet path could have muted every provider failure and no test would say so.
    stubCodexHome();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await refreshProviderModelCatalog({
        provider: "codex",
        workersDir: "/tmp/test-workers",
        probers: { scrapeCodex: vi.fn().mockRejectedValue(new Error("codex exploded")) },
      });

      if (res.status !== "unknown") throw new Error(`expected unknown, got ${res.status}`);
      expect(res.message).toContain("codex exploded");
      // Either channel: logFailedRefresh downgrades to a warning when a
      // last-known-good catalog survives, and that choice is not what this pins.
      expect(errorSpy.mock.calls.length + warnSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
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
    // A dead server is only a proxy for what #84 actually exhausted: the
    // Codex/Node descendants holding the inotify instances. tmux runs the pane
    // command in a process group of its own - distinct from the server's - and
    // that group holds the whole tree (`timeout`, the CLI, and any grandchild
    // it spawns), so draining it is the real "no orphaned probe processes"
    // check. The server's own argv embeds the pane command verbatim, hence the
    // new-session exclusion; without it the server is misread as a descendant.
    const paneGroupOf = (bin: string): number | undefined => {
      const row = processTable().find(
        (r) => r.args.includes(bin) && !r.args.includes("new-session")
      );
      if (row === undefined) return undefined;
      // tmux setsids the pane leader, so the tree it holds is always a group of
      // its own. A group of 1, or this runner's own, means the match is the
      // runner rather than the probe - fail the test loudly instead of handing
      // cleanup a group whose reaping would kill the run that asked for it.
      const unsafe = unsafeGroupReason(row.pgid);
      if (unsafe) throw new Error(`refusing to track the probe's group: ${unsafe} - ${row.args}`);
      return row.pgid;
    };
    const paneGroupSize = (pgid: number) => processTable().filter((r) => r.pgid === pgid).length;

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

    let paneGroup: number | undefined;
    try {
      for (let i = 0; i < 100 && serversFor(sock).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(serversFor(sock).length).toBeGreaterThan(0);
      // Take the descendants' group while they are alive; once they exit there
      // is nothing left to derive it from.
      paneGroup = paneGroupOf(mockBin);
      expect(paneGroup).toBeDefined();
      // Establishing the separate group is the probe's job; proving it is this
      // test's, because everything below signals that group by its negative id.
      expect(unsafeGroupReason(paneGroup as number)).toBeUndefined();
      expect(paneGroupSize(paneGroup as number)).toBeGreaterThan(0);

      // Slam the door: the socket is gone, so no kill-server can ever land.
      rmSync(tempHome, { recursive: true, force: true });
      await expect(pending).rejects.toThrow();

      for (
        let i = 0;
        i < 150 && (serversFor(sock).length > 0 || paneGroupSize(paneGroup as number) > 0);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(serversFor(sock)).toEqual([]);
      // The point of the fix: the tree the probe spawned is gone too, not just
      // the daemon that supervised it.
      expect(paneGroupSize(paneGroup as number)).toBe(0);
    } finally {
      // A failing run deliberately creates an unreapable server; never let one
      // escape onto the shared box - and reap the descendant group too, since
      // that is the residue #84 was actually about.
      // Both paths go through the guarded helpers: inside a sandbox whose init
      // is PID 1, a misread group id is not a stray signal, it is this run.
      for (const line of serversFor(sock)) {
        reapProcess(Number(line.trim().split(/\s+/)[0]));
      }
      // Group ids are recycled, and this one was read tens of seconds ago, so
      // only signal it while it still holds something this probe started.
      if (paneGroup !== undefined && groupStillHosts(paneGroup, mockBin)) {
        reapProcessGroup(paneGroup);
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

  it("waits out a composer that takes its time appearing ", async () => {
    // Readiness is polled against a deadline, so a codex that spends several
    // seconds on startup before drawing its composer is a slow success rather
    // than a failure - which is what a daemon start actually looks like.
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-slow-ready-"));
    const mockBin = join(actorDir, "mock-codex-slow-ready.sh");
    writeFileSync(
      mockBin,
      `#!/bin/bash
echo "OpenAI Codex"
sleep 4
echo "Ask Codex to do anything"
while read -r line; do
  if [ "$line" = "/model" ]; then
    echo "Select Model and Effort"
    echo "1. gpt-5.6-sol (current)"
    echo "2. gpt-5.6-terra"
    sleep 30
  fi
done
`,
      { mode: 0o755 }
    );

    try {
      const output = await scrapeCodexModelScreen({
        actorDir,
        cliCommand: mockBin,
        timeoutMs: 45_000,
      });
      expect(output).toContain("Select Model and Effort");
      expect(output).toContain("gpt-5.6-sol");
    } finally {
      rmSync(actorDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("re-confirms with Enter when the popup swallows the first submission ", async () => {
    // The evidenced swallowed-submission case: the autocomplete popup takes the
    // first Enter, so the command is staged rather than run and no panel opens.
    // Waiting out the render window for a keystroke nothing was going to answer
    // is how a healthy codex became an exit 1. Enter is the only key re-sent -
    // it commits what is already in the composer and adds nothing to it.
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-retry-"));
    const mockBin = join(actorDir, "mock-codex-swallow.sh");
    writeFileSync(
      mockBin,
      `#!/bin/bash
echo "OpenAI Codex"
echo "Ask Codex to do anything"
pending=0
while read -r line; do
  if [ "$line" = "/model" ]; then
    pending=1
    echo "change model  - press enter to confirm"
  elif [ "$pending" = "1" ]; then
    echo "Select Model and Effort"
    echo "1. gpt-5.6-sol (current)"
    sleep 30
  fi
done
`,
      { mode: 0o755 }
    );

    try {
      const output = await scrapeCodexModelScreen({
        actorDir,
        cliCommand: mockBin,
        timeoutMs: 30_000,
      });
      expect(output).toContain("Select Model and Effort");
      expect(output).toContain("gpt-5.6-sol");
    } finally {
      rmSync(actorDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports a composer that never became ready as that stage ", async () => {
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-no-composer-"));
    const mockBin = join(actorDir, "mock-codex-no-composer.sh");
    // Banner only: codex started but never reached the point of taking input.
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
        scrapeCodexModelScreen({ actorDir, cliCommand: mockBin, timeoutMs: 12_000 })
      ).rejects.toThrow(
        "codex /model scrape failed with exit code 1: the Codex composer never became ready, so /model was never submitted"
      );
    } finally {
      rmSync(actorDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("reports an unrendered panel as that stage, without quoting the screen ", async () => {
    const actorDir = mkdtempSync(join(tmpdir(), "codex-test-actor-no-panel-"));
    const mockBin = join(actorDir, "mock-codex-no-panel.sh");
    // Ready, then deaf: the composer took the command and nothing opened.
    writeFileSync(
      mockBin,
      `#!/bin/bash
echo "OpenAI Codex"
echo "Ask Codex to do anything"
echo "sensitive-pane-text-do-not-quote"
while true; do
  sleep 1
done
`,
      { mode: 0o755 }
    );

    try {
      await expect(
        scrapeCodexModelScreen({ actorDir, cliCommand: mockBin, timeoutMs: 16_000 })
      ).rejects.toThrow(
        "codex /model scrape failed with exit code 1: /model was submitted but the model panel never rendered"
      );

      // The diagnostic comes from stderr, which carries the wrapper's own
      // markers; the rendered screen leaves through stdout and stays there.
      await expect(
        scrapeCodexModelScreen({ actorDir, cliCommand: mockBin, timeoutMs: 16_000 })
      ).rejects.not.toThrow("sensitive-pane-text-do-not-quote");
    } finally {
      rmSync(actorDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("spends the caller's whole deadline instead of a fixed poll count ", () => {
    // The failure this repairs: a 90s probe abandoned a slow start at ~43s
    // because both waits were fixed 40-iteration loops, then reported it as if
    // codex had refused. Every wait is now derived from the caller's deadline.
    const script = buildCodexModelTmuxScript("codex", "/tmp/sock", "", 91);
    expect(script).toContain("BUDGET_S=81");
    expect(script).toContain("READY_S=32");
    expect(script).not.toContain("seq 1 40");
    expect(script).toContain('while [ "$SECONDS" -lt "$READY_S" ]; do');
  });

  it("keeps ready <= budget < deadline for every deadline a caller can ask for ", () => {
    // The script's budget is nested inside the deadline its own session command
    // carries, so the ordering has to hold for a 3s probe as well as a 90s one.
    // Where it does not, the script stops being the thing that reaps itself and
    // names its stage, and the Node-side timer kills it instead - which is the
    // undiagnosable exit this PR exists to remove.
    for (const deadline of [1, 2, 3, 5, 12, 21, 30, 91, 600]) {
      const script = buildCodexModelTmuxScript("codex", "/tmp/sock", "", deadline);
      const budget = Number(/BUDGET_S=(\d+)/.exec(script)?.[1]);
      const ready = Number(/READY_S=(\d+)/.exec(script)?.[1]);
      const applied = Number(/timeout --kill-after=5 (\d+) /.exec(script)?.[1]);
      expect(ready).toBeGreaterThanOrEqual(1);
      expect(ready).toBeLessThanOrEqual(budget);
      expect(budget).toBeLessThan(applied);
    }
  });

  it("types the /model command exactly once ", () => {
    // Enter may be re-sent; the command text may not be re-typed. Nothing
    // capture-pane returns distinguishes a live empty composer from the same
    // placeholder text sitting in scrollback, so a retype would be authorized by
    // a predicate that cannot see what is focused - and typing into an open
    // picker is how a probe that only reads turns into one that changes state.
    const script = buildCodexModelTmuxScript("codex", "/tmp/sock", "", 91);
    const typed = script.match(/send-keys -t "\$S" -l "\/model"/g) ?? [];
    expect(typed).toHaveLength(1);
    expect(script).not.toContain("attempt_model");
  });
});

describe("describeCodexScrapeFailure", () => {
  it("names the stage the wrapper gave up in", () => {
    expect(
      describeCodexScrapeFailure("ERROR: composer never became ready in Codex session\n")
    ).toBe("the Codex composer never became ready, so /model was never submitted");
    expect(
      describeCodexScrapeFailure("ERROR: /model panel never rendered in Codex session\n")
    ).toBe("/model was submitted but the model panel never rendered");
  });

  it("still says something bounded when no stage marker was written", () => {
    expect(describeCodexScrapeFailure("")).toBe(
      "the wrapper exited without a stage marker or any stderr"
    );
    expect(describeCodexScrapeFailure("   \n\n")).toBe(
      "the wrapper exited without a stage marker or any stderr"
    );

    const flattened = describeCodexScrapeFailure("open terminal failed: missing or unsuitable\n");
    expect(flattened).toBe(
      "the wrapper exited without a stage marker (stderr: open terminal failed: missing or unsuitable)"
    );

    const long = describeCodexScrapeFailure(`tmux: ${"x".repeat(500)}`);
    expect(long.length).toBeLessThan(280);
    expect(long).toContain("...");
  });
});
