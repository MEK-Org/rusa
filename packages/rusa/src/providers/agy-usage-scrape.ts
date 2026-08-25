import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Host-side PTY scrape of agy's (Antigravity) interactive `/usage` — the
 * "Models & Quota" view (ISSUE_NUM, leg 2).
 *
 * Runs in the quota MCP's host process (same plane as get_quota), which can open
 * a PTY freely. agy exposes quota ONLY through this interactive TUI view; it's a
 * bubbletea app that dies with `bubbletea: could not open TTY` non-interactively,
 * so a PTY is mandatory. We rent one with `tmux`.
 *
 * AUTH-SAFETY:
 *  - `/usage` is a **read-only display** ("View model quota usage") — confirmed
 *    host-side that it consumes nothing (unlike codex `/usage`, which burns a
 *    reset). We open it and read; `Escape` closes it.
 *  - Unlike codex (static bearer in auth.json → isolatable), agy authenticates
 *    via Google OAuth and a fresh isolated HOME triggers its onboarding + sign-in
 *    wizard. So we drive the **real `~/.gemini`** — exactly what every mesh agy
 *    run does (sandbox.ts binds it writable). This is auth-safe because agy's
 *    durable refresh_token is **non-rotating** (unchanged for a month of constant
 *    mesh use; only the short-lived access JWT cycles) — a refresh never
 *    invalidates the login. We never force a rotation.
 *  - Runs under its own tmux socket + scratch cwd so it doesn't disturb other
 *    agy sessions.
 *
 * The caller (quota MCP) gates this behind the interactive_scrape TTL so we never
 * probe-on-read.
 */
export interface ScrapeAgyUsageOptions {
  /** Scratch working dir the probe's agy session runs in (created if absent). */
  actorDir: string;
  /** Overall wall-clock budget for the scrape. Default 90s. */
  timeoutMs?: number;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Command binary (test/override). Default "agy". */
  cliCommand?: string;
}

/** tmux orchestration: launch agy, open /usage, capture the Models & Quota view. */
function buildTmuxScript(cliCommand: string, sockPath: string): string {
  const q = JSON.stringify;
  return [
    "set -u",
    `SOCK=${q(sockPath)}`,
    "S=probe",
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
    `tmux -S "$SOCK" new-session -d -s "$S" -x 140 -y 50 ${q(cliCommand)}`,
    // Wait for a genuine POST-sign-in, input-ready prompt — NOT agy's boot splash,
    // which shows "Welcome to the Antigravity CLI … Signing in…" (it contains
    // "Antigravity"/">" while auth is still in flight; matching that fired the old
    // grep ~1s in and sent /usage into a not-ready CLI). Robust signal: a
    // live-prompt marker ("? for shortcuts" footer or the signed-in plan header)
    // present, with NO signing-in/splash text, STABLE across 2 consecutive
    // captures (a single mid-repaint frame can flicker). agy boots a language
    // server + signs in, so poll up to ~48s.
    //
    // In a fresh dir agy first shows a trust-folder gate ("Do you trust the
    // contents of this project?") and BLOCKS there. Detect it and send Enter to
    // accept the default ("Yes, I trust this folder") — grep-gated so we only
    // send Enter when that screen is actually up (idempotent; some runs skip it
    // because agy remembers a previously-trusted dir). Trust is benign config in
    // ~/.gemini, NOT auth — within the auth-safety bound. The probe reuses a
    // stable actorDir, so the gate typically appears only on the very first scrape.
    "consec=0",
    "for i in $(seq 1 80); do",
    '  scr=$(tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true)',
    '  if printf "%s" "$scr" | grep -qiE "do you trust|trust this folder|trust the contents"; then',
    '    tmux -S "$SOCK" send-keys -t "$S" Enter',
    "    consec=0",
    "    sleep 0.6",
    "    continue",
    "  fi",
    '  if printf "%s" "$scr" | grep -qiE "signing in|not signed in|welcome to the antigravity"; then',
    "    consec=0",
    '  elif printf "%s" "$scr" | grep -qE "\\? for shortcuts|Google AI Pro"; then',
    "    consec=$((consec + 1))",
    '    [ "$consec" -ge 2 ] && break',
    "  else",
    "    consec=0",
    "  fi",
    "  sleep 0.6",
    "done",
    // Open the read-only usage view now that the prompt is settled.
    'tmux -S "$SOCK" send-keys -t "$S" "/usage"',
    "sleep 1",
    'tmux -S "$SOCK" send-keys -t "$S" Enter',
    // Wait up to ~36s for the Models & Quota view to render.
    "for i in $(seq 1 60); do",
    '  scr=$(tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true)',
    '  printf "%s" "$scr" | grep -qiE "Models & Quota|Weekly Limit|Quota available|MODELS" && break',
    "  sleep 0.6",
    "done",
    'tmux -S "$SOCK" capture-pane -t "$S" -p 2>/dev/null || true',
    // Close the view (Escape) then tear the session down.
    'tmux -S "$SOCK" send-keys -t "$S" Escape 2>/dev/null || true',
    'tmux -S "$SOCK" kill-server 2>/dev/null || true',
  ].join("\n");
}

export async function scrapeAgyUsage(opts: ScrapeAgyUsageOptions): Promise<string> {
  const cliCommand = opts.cliCommand ?? "agy";
  // agy boots a language server + does a network sign-in before the prompt is
  // ready, so it needs a longer budget than codex (ready-poll ~48s + panel ~36s).
  const timeoutMs = opts.timeoutMs ?? 120_000;
  mkdirSync(opts.actorDir, { recursive: true });

  // A private tmux socket dir (NOT a copy of ~/.gemini — we drive the real,
  // already-signed-in home; see the auth-safety note above).
  const sockDir = mkdtempSync(join(tmpdir(), "rusa-agy-usage-"));
  const sock = join(sockDir, "usage-tmux.sock");
  const script = buildTmuxScript(cliCommand, sock);

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
      rmSync(sockDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    return await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const child = spawn("bash", ["-c", script], {
        cwd: opts.actorDir,
        env: { ...process.env, TERM: "xterm-256color" },
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
        settle(new Error("agy /usage scrape aborted"));
      }
      timer = setTimeout(
        () => settle(new Error(`agy /usage scrape timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      opts.signal?.addEventListener("abort", onAbort);
      child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.on("error", (err) => settle(err));
      child.on("close", () => settle());
    });
  } finally {
    cleanup();
  }
}
