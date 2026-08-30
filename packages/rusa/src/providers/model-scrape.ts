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
  trustArg: string,
  deadlineSeconds: number
): string {
  const q = JSON.stringify;
  return [
    "set -u",
    `SOCK=${q(sockPath)}`,
    "S=probe",
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
    // Bound the session's own command so the probe tree cannot outlive the
    // probe. Every other reaping path can be cut: the tmux server runs in its
    // own session, so a process-group kill never reaches it, and its socket
    // lives under a temp dir this probe deletes on the way out - once that dir
    // is gone `kill-server` can never reach the server again. When the command
    // exits the session ends, and tmux's default exit-empty shuts the server
    // down, needing neither this process, nor the wrapper shell, nor the socket.
    // The 5s --kill-after grace covers a CLI that ignores the initial TERM.
    // -f /dev/null starts the server on stock settings: that self-reaping turns
    // on tmux's exit-empty, which a stray `set -s exit-empty off` in a user or
    // system tmux.conf would otherwise disable, stranding an empty server for
    // good. It also keeps someone's status bar or key bindings out of the pane
    // text this probe greps.
    `tmux -f /dev/null -S "$SOCK" new-session -d -s "$S" -x 120 -y 50 timeout --kill-after=5 ${deadlineSeconds} ${q(cliCommand)}${trustArg ? ` ${trustArg}` : ""}`,
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
  // The caller's timeout is the probe's declared lifetime, so it is also the
  // deadline for anything the probe spawns; no separate knob to drift. The
  // extra second is what keeps this a pure backstop: the child is spawned
  // before the Node-side timer is armed, and a busy event loop can delay that
  // timer further, so an exactly-equal inner deadline could fire first and cut
  // short a probe the Node side would have let finish. One second of grace is
  // far more than the spawn-plus-scheduling skew, so the Node deadline wins by
  // construction, and an abandoned tree still self-reaps a second later.
  const script = buildCodexModelTmuxScript(
    cliCommand,
    sock,
    trustArg,
    Math.ceil(timeoutMs / 1000) + 1
  );

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
 * The result of a probe the OWNER cancelled — never logged.
 *
 * Shared by the pre-entry guard and both in-flight catches so the two cannot drift: a
 * shutdown that lands before the probe starts and one that lands mid-probe are the same
 * event, and a caller must not be able to tell them apart by the noise they make. An
 * aborted probe is the owner's own decision, not a provider failure, so routing it
 * through `logFailedRefresh` would print an error line per configured provider on every
 * restart and write a failure into the scrape store for a provider that was working.
 *
 * A fresh object each call: `entries` is handed to callers, and one shared array would
 * let a mutation by one of them alter what the next one sees.
 */
function abortedProbeResult(): ModelCatalogExtraction {
  return { status: "unknown", entries: [], message: "model probe aborted" };
}

/**
 * Probe a single provider's available models and persist the scrape.
 */
export async function refreshProviderModelCatalog(opts: {
  provider: string;
  workersDir: string;
  scrapeStore?: ModelScrapeStore;
  geminiApiKey?: string;
  /**
   * Aborts the probe. The leaf probers already honour a signal; this is the
   * hop that was dropping it, so an owner shutting down could not reach them.
   */
  signal?: AbortSignal;
  probers?: {
    scrapeCodex?: (opts: ModelProbeOptions) => Promise<string>;
    scrapeAgy?: (opts: ModelProbeOptions) => Promise<string>;
  };
}): Promise<ModelCatalogExtraction> {
  const { provider, workersDir, scrapeStore, geminiApiKey, signal, probers } = opts;
  const actorDir = join(workersDir, `model-probe-${provider}`);

  // Don't start a probe for an owner that has already stopped. Today every
  // provider's probe is launched in the same tick as the caller's Promise.all,
  // so an abort cannot land between this check and the leaf attaching its abort
  // listener - but that is an implicit property of the current call shape, and
  // without this guard the whole design rests on it silently. Returning quietly
  // rather than through logFailedRefresh: an aborted probe is the owner's own
  // decision, not a provider failure, so a restart should not print an error
  // line per provider it never reached.
  if (signal?.aborted) {
    return abortedProbeResult();
  }

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
      // scrapeAgyModels takes its own option shape and ignores actorDir, so pass
      // only the signal rather than relying on structural compatibility.
      const probe =
        probers?.scrapeAgy ?? ((o: ModelProbeOptions) => scrapeAgyModels({ signal: o.signal }));
      const rawOutput = await probe({ actorDir, signal });
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
      // The abort we asked for, arriving as a rejection. `scrapeAgyModels` rejects with
      // `agy models aborted` when the owner's signal fires mid-probe, and that is the
      // case this whole seam exists to serve - so it must not come back out as a
      // provider failure. Checked on the signal rather than on the error's shape: the
      // message is the leaf's to word, and matching on it would make this silently stop
      // working the day that string changes.
      if (signal?.aborted) return abortedProbeResult();
      const message = `agy models probe failed: ${err instanceof Error ? err.message : String(err)}`;
      logFailedRefresh(provider, message, scrapeStore);
      return { status: "unknown", entries: [], message };
    }
  }

  let rawOutput = "";
  try {
    if (provider === "codex") {
      const probe = probers?.scrapeCodex ?? scrapeCodexModelScreen;
      rawOutput = await probe({ actorDir, signal });
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
    // Same owner-initiated abort as the agy path above, and deliberately the same
    // branch: two probers whose abort semantics diverge would mean a restart is quiet
    // or noisy depending on which providers happen to be configured.
    if (signal?.aborted) return abortedProbeResult();
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
  /** Aborts every probe this call starts. See `refreshProviderModelCatalog`. */
  signal?: AbortSignal;
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
          signal: deps.signal,
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
