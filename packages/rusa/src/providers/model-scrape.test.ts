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

  it("hands every prober the caller's abort signal", async () => {
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
      const line = execFileSync("ps", ["-eo", "pgid=,args="], { encoding: "utf8" })
        .split("\n")
        .find((l) => l.includes(bin) && !l.includes("new-session"));
      const pgid = Number(line?.trim().split(/\s+/)[0]);
      return Number.isInteger(pgid) ? pgid : undefined;
    };
    const paneGroupSize = (pgid: number) =>
      execFileSync("ps", ["-eo", "pgid="], { encoding: "utf8" })
        .split("\n")
        .filter((l) => Number(l.trim()) === pgid).length;

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
      for (const line of serversFor(sock)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid)) spawnSync("kill", ["-9", String(pid)]);
      }
      if (paneGroup !== undefined) spawnSync("kill", ["-9", `-${paneGroup}`]);
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
