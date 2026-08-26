import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RusaConfig } from "../config/types.js";
import {
  getProviderModelCatalog,
  ingestKimiHostModels,
  type ModelCatalogExtraction,
  type ModelScrapeStore,
  parseAgyModelsOutput,
  recordAndExtractModelCatalog,
  setProviderModelCatalog,
} from "./model-catalog.js";

export interface ModelProbeOptions {
  actorDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  cliCommand?: string;
  configDir?: string;
}

/** tmux orchestration: launch codex, send /model, capture the rendered menu panel . */
export function buildCodexModelTmuxScript(
  cliCommand: string,
  sockPath: string,
  trustArg = ""
): string {
  const q = JSON.stringify;
  return [
    "set -u",
    `SOCK=${q(sockPath)}`,
    "S=probe",
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
    `tmux -S "$SOCK" new-session -d -s "$S" -x 120 -y 50 ${q(cliCommand)}${trustArg ? ` ${trustArg}` : ""}`,
    // Wait up to ~20s for the composer prompt to become ready (not just the banner).
    "ready=0",
    "for i in $(seq 1 40); do",
    '  scr=$(tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true)',
    '  if printf "%s" "$scr" | grep -qiE "Ask Codex to do anything"; then',
    "    ready=1",
    "    break",
    "  fi",
    "  sleep 0.5",
    "done",
    'if [ "$ready" -eq 0 ]; then',
    '  echo "ERROR: composer never became ready in Codex session" >&2',
    '  tmux -S "$SOCK" kill-server 2>/dev/null || true',
    "  exit 1",
    "fi",
    // Settle before sending keys so TUI is fully accepting input.
    "sleep 2",
    // Type the /model command with literal keys and submit after a short pause.
    'tmux -S "$SOCK" send-keys -t "$S" -l "/model"',
    "sleep 1.5",
    'tmux -S "$SOCK" send-keys -t "$S" Enter',
    // Wait up to ~20s for the model menu panel to render.
    // On codex CLI, the first Enter may be consumed by the autocomplete popup.
    // Poll for confirmation: if the menu hasn't rendered yet and the popup or
    // prompt is still visible, re-send Enter to submit the command.
    // Note: Keep regex in sync with extractModelCatalog pre-extraction guard in model-catalog.ts
    "rendered=0",
    "for i in $(seq 1 40); do",
    '  scr=$(tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true)',
    '  if printf "%s" "$scr" | grep -qiE "Select Model|Select a model|Select model and effort|[0-9]+\\.[[:space:]]*gpt-"; then',
    "    rendered=1",
    "    break",
    "  fi",
    '  if printf "%s" "$scr" | grep -qiE "change model|switch model|select model|choose model"; then',
    '    tmux -S "$SOCK" send-keys -t "$S" Enter',
    '  elif printf "%s" "$scr" | grep -qE "(›|>)[[:space:]]*/model"; then',
    '    tmux -S "$SOCK" send-keys -t "$S" Enter',
    "  fi",
    "  sleep 0.5",
    "done",
    'if [ "$rendered" -eq 0 ]; then',
    '  echo "ERROR: /model panel never rendered in Codex session" >&2',
    '  tmux -S "$SOCK" kill-server 2>/dev/null || true',
    "  exit 1",
    "fi",
    'tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true',
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
  ].join("\n");
}

/**
 * Host-side non-interactive execution of `agy models` .
 * Runs `agy models` directly without PTY or tmux and captures standard output.
 */
export async function scrapeAgyModels(opts?: {
  cliCommand?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const cliCommand = opts?.cliCommand ?? "agy";
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const spawnFn = opts?.spawnImpl ?? spawn;

  return new Promise<string>((resolve, reject) => {
    const child = spawnFn(cliCommand, ["models"], {
      cwd: opts?.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const settle = (err?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
      if (err) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        reject(err);
      } else {
        resolve(result ?? stdout);
      }
    };

    function onAbort() {
      settle(new Error("agy models aborted"));
    }

    timer = setTimeout(
      () => settle(new Error(`agy models timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    opts?.signal?.addEventListener("abort", onAbort);

    child.on("error", (err) => settle(err));
    child.on("close", (code) => {
      if (code === 0) {
        settle(undefined, stdout);
      } else {
        settle(new Error(`agy models exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

/**
 * Host-side PTY scrape of Codex's interactive `/model` panel.
 * Uses inline config override (-c) for actor project trust so codex operates on the
 * real host ~/.codex in-place — any OAuth token rotation naturally persists and
 * host auth is never revoked or deleted.
 */
export async function scrapeCodexModelScreen(opts: ModelProbeOptions): Promise<string> {
  const cliCommand = opts.cliCommand ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 90_000;
  mkdirSync(opts.actorDir, { recursive: true });

  const tempHome = mkdtempSync(join(tmpdir(), "rusa-codex-model-"));
  const sock = join(tempHome, "model-tmux.sock");
  const q = JSON.stringify;
  const trustArg = `-c projects.${q(opts.actorDir)}.trust_level="trusted"`;
  const script = buildCodexModelTmuxScript(cliCommand, sock, trustArg);

  const killTmux = () => {
    try {
      spawnSync("tmux", ["-S", sock, "kill-server"], { stdio: "ignore" });
    } catch {
      /* best effort */
    }
  };
  const cleanup = () => {
    killTmux();
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    return await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const child = spawn("bash", ["-c", script], {
        cwd: opts.actorDir,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          ...(opts.configDir ? { CODEX_HOME: opts.configDir } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const killGroup = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* group already gone */
          }
        }
      };
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) {
          killTmux();
          killGroup();
          reject(err);
        } else {
          resolve(chunks.join(""));
        }
      };
      function onAbort() {
        settle(new Error("codex /model scrape aborted"));
      }
      timer = setTimeout(
        () => settle(new Error(`codex /model scrape timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      opts.signal?.addEventListener("abort", onAbort);
      child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.on("error", (err) => settle(err));
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          settle(new Error(`codex /model scrape failed with exit code ${code}`));
        } else {
          settle();
        }
      });
    });
  } finally {
    cleanup();
  }
}

function logFailedRefresh(provider: string, message: string, scrapeStore?: ModelScrapeStore): void {
  const existing = getProviderModelCatalog(provider);
  if (existing && existing.length > 0) {
    let ageNote = "";
    try {
      const latest =
        scrapeStore?.getLatestParsedForProvider?.(provider) ??
        scrapeStore?.getLatestForProvider?.(provider);
      if (latest?.scrapedAt) {
        ageNote = `, last scraped at ${latest.scrapedAt}`;
      }
    } catch {
      /* best effort */
    }
    console.warn(
      `[model-catalog] ${message}; retaining last-known-good catalog (${existing.length} models${ageNote})`
    );
  } else {
    console.error(`[model-catalog] ${message}`);
  }
}

/**
 * Probe a single provider's available models and persist the scrape.
 */
export async function refreshProviderModelCatalog(opts: {
  provider: string;
  workersDir: string;
  scrapeStore?: ModelScrapeStore;
  geminiApiKey?: string;
  probers?: {
    scrapeCodex?: (opts: ModelProbeOptions) => Promise<string>;
    scrapeAgy?: (opts: ModelProbeOptions) => Promise<string>;
  };
}): Promise<ModelCatalogExtraction> {
  const { provider, workersDir, scrapeStore, geminiApiKey, probers } = opts;
  const actorDir = join(workersDir, `model-probe-${provider}`);

  if (provider === "kimi") {
    const entries = ingestKimiHostModels({ scrapeStore });
    if (entries.length > 0) {
      return { status: "known", entries };
    }
    const message = "no models found in Kimi config";
    logFailedRefresh(provider, message, scrapeStore);
    return { status: "unknown", entries: [], message };
  }

  if (provider === "agy" || provider === "antigravity") {
    try {
      const probe = probers?.scrapeAgy ?? (() => scrapeAgyModels({}));
      const rawOutput = await probe({ actorDir });
      const entries = parseAgyModelsOutput(rawOutput);

      const scrapedAt = new Date().toISOString();
      let id: string | undefined;
      try {
        id = scrapeStore?.recordRaw({ provider, scrapedAt, rawOutput });
        if (id && entries.length > 0) {
          scrapeStore?.recordParsed(id, entries);
        } else if (id && entries.length === 0) {
          scrapeStore?.recordParseError(id, new Error("no models parsed from agy models output"));
        }
      } catch (err) {
        console.warn(
          `[model-catalog] failed to persist agy model scrape: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (entries.length > 0) {
        setProviderModelCatalog(provider, entries);
        return { status: "known", entries };
      }
      const message = "no models found in agy models output";
      logFailedRefresh(provider, message, scrapeStore);
      return { status: "unknown", entries: [], message };
    } catch (err) {
      const message = `agy models probe failed: ${err instanceof Error ? err.message : String(err)}`;
      logFailedRefresh(provider, message, scrapeStore);
      return { status: "unknown", entries: [], message };
    }
  }

  let rawOutput = "";
  try {
    if (provider === "codex") {
      const probe = probers?.scrapeCodex ?? scrapeCodexModelScreen;
      rawOutput = await probe({ actorDir });
    } else {
      const message = `no probe implemented for provider "${provider}"`;
      logFailedRefresh(provider, message, scrapeStore);
      return {
        status: "unknown",
        entries: [],
        message,
      };
    }
  } catch (err) {
    const message = `model probe failed for provider "${provider}": ${err instanceof Error ? err.message : String(err)}`;
    logFailedRefresh(provider, message, scrapeStore);
    return {
      status: "unknown",
      entries: [],
      message,
    };
  }

  const res = await recordAndExtractModelCatalog({
    provider,
    rawOutput,
    scrapeStore,
    geminiApiKey,
  });
  if (res.status === "unknown") {
    logFailedRefresh(
      provider,
      `model extraction failed for provider "${provider}": ${res.message}`,
      scrapeStore
    );
  }
  return res;
}

/**
 * Probe all configured providers on startup and daily intervals.
 */
export async function refreshConfiguredProviderModelCatalogs(deps: {
  config: RusaConfig;
  workersDir: string;
  scrapeStore?: ModelScrapeStore;
  probers?: {
    scrapeCodex?: (opts: ModelProbeOptions) => Promise<string>;
    scrapeAgy?: (opts: ModelProbeOptions) => Promise<string>;
  };
}): Promise<void> {
  const configured = Object.keys(deps.config.providers ?? {});
  const providersToProbe = configured.length > 0 ? configured : ["kimi", "codex", "claude", "agy"];

  await Promise.all(
    providersToProbe.map(async (provider) => {
      try {
        await refreshProviderModelCatalog({
          provider,
          workersDir: deps.workersDir,
          scrapeStore: deps.scrapeStore,
          geminiApiKey: deps.config.geminiApiKey,
          probers: deps.probers,
        });
      } catch (err) {
        logFailedRefresh(
          provider,
          `failed to refresh model catalog for ${provider}: ${err instanceof Error ? err.message : String(err)}`,
          deps.scrapeStore
        );
      }
    })
  );
}
