import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Host-side PTY scrape of codex's interactive `/status` panel .
 *
 * This runs in the quota MCP's own host process (same plane as get_quota), NOT
 * in a bwrap worker sandbox — the host has full latitude to open a PTY. codex
 * exposes remaining-quota numbers ONLY through the interactive TUI's `/status`
 * slash command (`codex exec` has no quiet quota surface), and that TUI is a
 * ratatui full-screen app that needs a real PTY. We rent one with `tmux`: run
 * codex in a detached tmux session, send `/status`, and `capture-pane -p` the
 * rendered screen as clean text (tmux reconstructs the final screen for us, so
 * we never hand-parse ANSI).
 *
 * AUTH-SAFETY (the ISSUE_NUM/ISSUE_NUM non-negotiable — never mutate provider auth):
 *  - We drive codex's ALREADY-authenticated session and only READ what it prints.
 *  - We send `/status` (read-only), NEVER `/usage` — on codex `/usage` CONSUMES
 *    one of the account's limited "usage limit resets", a mutating action.
 *  - We point codex at an ISOLATED, throwaway `CODEX_HOME` seeded with a COPY of
 *    the host's `auth.json` — never the real `~/.codex`. codex builds its own
 *    fresh state DB there; the real auth/state is never opened, refreshed,
 *    rotated, or written. Auth-safe AND host-state-safe by construction. The
 *    copied-auth home is deleted after each scrape.
 *
 * `/status` itself is free; the caller (quota MCP) still gates this behind the
 * interactive_scrape TTL so we never probe-on-read.
 */
export interface ScrapeCodexStatusOptions {
  /** Scratch working dir the probe's codex session runs in (created if absent). */
  actorDir: string;
  /** Overall wall-clock budget for the scrape. Default 90s. */
  timeoutMs?: number;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Command binary (test/override). Default "codex". */
  cliCommand?: string;
  /** Host codex config dir to copy auth/config from (test seam). Default `~/.codex`. */
  codexConfigDir?: string;
}

/** tmux orchestration: launch codex, send /status, capture the rendered panel. */
export function buildTmuxScript(cliCommand: string, sockPath: string): string {
  // Poll (not fixed sleeps) for TUI-ready then for the status panel, so a fast
  // machine returns promptly and a slow one still succeeds. capture-pane -p emits
  // the clean rendered screen to stdout. The tmux server inherits CODEX_HOME/TERM
  // from this process's env, so the codex child it spawns sees them too.
  //
  // RETRY ON THE "refresh requested" PLACEHOLDER (issue #8): codex often answers
  // the first /status with `Limits: refresh requested; run /status again shortly.`
  // — it kicks off an async limits refresh and asks the caller to re-issue
  // /status. That placeholder is NOT a reading (it parses to zero windows), so
  // treating it as a successful render leaves the pipeline blind for hours. Here
  // we distinguish a real limits table from the placeholder and, on a placeholder,
  // wait a few seconds for the refresh to land and re-send /status IN THE SAME
  // SESSION, looping while the wall-clock budget allows. AUTH-SAFETY is unchanged:
  // every retry is still /status (read-only), NEVER /usage. If only placeholders
  // ever render we still capture the last one so the parser gets the pending panel
  // (which it classifies as no-data) rather than the scrape erroring.
  const q = JSON.stringify;
  return [
    "set -u",
    `SOCK=${q(sockPath)}`,
    "S=probe",
    // Whole-script budget in seconds since shell start (banner wait + all /status
    // retries share it). Kept below the caller's 90s Node wall-clock so we finish
    // capturing + reaping tmux before Node's timer fires.
    "BUDGET_S=80",
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
    `tmux -S "$SOCK" new-session -d -s "$S" -x 120 -y 50 ${q(cliCommand)}`,
    // Wait up to ~20s for the codex banner (TUI ready).
    "for i in $(seq 1 40); do",
    '  scr=$(tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true)',
    '  printf "%s" "$scr" | grep -q "OpenAI Codex" && break',
    "  sleep 0.5",
    "done",
    // One /status attempt: type the read-only command and submit it, then poll the
    // pane. On codex CLI >=0.148.0 the first Enter may be swallowed by the
    // slash-command autocomplete popup without submitting, so if the panel hasn't
    // rendered and the popup or prompt is still visible we re-send Enter.
    // Sets `saw_real` (a real limits table / exhaustion banner rendered) and
    // `saw_ph` (only the refresh-requested placeholder rendered). Keeps polling
    // after a placeholder appears — the async refresh may still resolve into a
    // real table within THIS attempt.
    "attempt_status() {",
    "  saw_real=0",
    "  saw_ph=0",
    '  tmux -S "$SOCK" send-keys -t "$S" "/status"',
    "  sleep 1",
    '  tmux -S "$SOCK" send-keys -t "$S" Enter',
    "  local deadline=$((SECONDS + 14))",
    '  while [ "$SECONDS" -lt "$deadline" ] && [ "$SECONDS" -lt "$BUDGET_S" ]; do',
    '    scr=$(tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true)',
    '    if printf "%s" "$scr" | grep -qE "limit:|hit your usage limit"; then',
    "      saw_real=1",
    "      return 0",
    "    fi",
    '    if printf "%s" "$scr" | grep -qE "refresh requested|run /status again"; then',
    "      saw_ph=1",
    "    fi",
    '    if printf "%s" "$scr" | grep -qiE "show current session|/statusline|configure which items"; then',
    '      tmux -S "$SOCK" send-keys -t "$S" Enter',
    '    elif printf "%s" "$scr" | grep -qE "(›|>)[[:space:]]*/status"; then',
    '      tmux -S "$SOCK" send-keys -t "$S" Enter',
    "    fi",
    "    sleep 0.5",
    "  done",
    "  return 0",
    "}",
    // Retry /status until a real limits table (or exhaustion banner) renders or the
    // budget runs out; on a placeholder, wait for codex's async refresh to land
    // before re-issuing. `placeholder_seen` lets an all-placeholder run still
    // capture the pending panel instead of erroring.
    "rendered=0",
    "placeholder_seen=0",
    'while [ "$SECONDS" -lt "$BUDGET_S" ]; do',
    "  attempt_status",
    '  if [ "$saw_real" -eq 1 ]; then',
    "    rendered=1",
    "    break",
    "  fi",
    '  if [ "$saw_ph" -eq 1 ]; then',
    "    placeholder_seen=1",
    "  fi",
    // Give codex's async limits refresh a few seconds before re-issuing /status.
    '  [ "$SECONDS" -lt "$BUDGET_S" ] && sleep 6',
    "done",
    'if [ "$rendered" -eq 0 ] && [ "$placeholder_seen" -eq 0 ]; then',
    '  echo "ERROR: /status panel never rendered in Codex session" >&2',
    '  tmux -S "$SOCK" kill-server 2>/dev/null || true',
    "  exit 1",
    "fi",
    'tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true',
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
  ].join("\n");
}

/**
 * Seed an isolated throwaway `CODEX_HOME`: a copy of the host `auth.json` plus a
 * `config.toml` (host config, best effort) with the probe dir pre-trusted so the
 * interactive TUI never blocks on its "Do you trust this directory?" prompt.
 * Returns the new home dir (caller deletes it).
 */
function seedIsolatedCodexHome(actorDir: string, hostCodexDir: string): string {
  const codexHome = mkdtempSync(join(tmpdir(), "rusa-codex-status-"));
  const hostAuth = join(hostCodexDir, "auth.json");
  if (existsSync(hostAuth)) {
    writeFileSync(join(codexHome, "auth.json"), readFileSync(hostAuth), { mode: 0o600 });
  }
  let baseConfig = "";
  const hostConfig = join(hostCodexDir, "config.toml");
  if (existsSync(hostConfig)) {
    try {
      baseConfig = readFileSync(hostConfig, "utf-8");
    } catch {
      /* best effort */
    }
  }
  const trust = `\n[projects.${JSON.stringify(actorDir)}]\ntrust_level = "trusted"\n`;
  writeFileSync(join(codexHome, "config.toml"), baseConfig + trust, { mode: 0o600 });
  return codexHome;
}

export async function scrapeCodexStatus(opts: ScrapeCodexStatusOptions): Promise<string> {
  const cliCommand = opts.cliCommand ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 90_000;
  mkdirSync(opts.actorDir, { recursive: true });

  const hostCodexDir = opts.codexConfigDir ?? join(homedir(), ".codex");
  const codexHome = seedIsolatedCodexHome(opts.actorDir, hostCodexDir);
  const sock = join(codexHome, "status-tmux.sock");
  const script = buildTmuxScript(cliCommand, sock);

  // The bash script launches a DETACHED tmux server (`new-session -d`) that
  // double-forks away from bash's process group — so killing the bash shell (on
  // timeout/abort) does NOT reap the tmux server or the codex child it holds. We
  // must tear tmux down explicitly, from Node, and do it BEFORE removing the home
  // (which holds the copied-auth secret and the tmux socket). `kill-server` is the
  // authoritative reap; the process-group kill is belt-and-suspenders for the
  // bash shell + its poll subshells.
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
      rmSync(codexHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    return await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      // `detached: true` makes the child its own process-group leader so we can
      // signal the whole group with `process.kill(-pid, ...)`.
      const child = spawn("bash", ["-c", script], {
        cwd: opts.actorDir,
        env: { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" },
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
      // Single settle path: on any error/timeout/abort, reap tmux + the process
      // group (the bash SIGTERM alone would leave the detached tmux server + codex
      // child alive) and reject → the caller maps a rejection to `unknown`, never
      // a partial/stale scrape. `finally`'s cleanup then removes the copied-auth
      // home, always after tmux is dead.
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
        settle(new Error("codex /status scrape aborted"));
      }
      // Own the timeout in Node (not spawn's `timeout`, whose SIGTERM leaves the
      // detached tmux server alive).
      timer = setTimeout(
        () => settle(new Error(`codex /status scrape timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      opts.signal?.addEventListener("abort", onAbort);
      child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.on("error", (err) => settle(err));
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          settle(new Error(`codex /status scrape failed with exit code ${code}`));
        } else {
          settle();
        }
      });
    });
  } finally {
    cleanup();
  }
}
