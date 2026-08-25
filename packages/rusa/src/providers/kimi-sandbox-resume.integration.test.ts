import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KimiProvider } from "./kimi.js";

/**
 * Operator-run E2E gate for the per-provider "one sandboxed prompt + one
 * sandboxed `-r` resume" check root and ISSUE_NUM/ISSUE_NUM asked for. Unlike the
 * zero-creds structural probe (sandbox-session-persistence.test.ts), this drives
 * the REAL {@link KimiProvider} adapter through real bwrap + the real kimi CLI,
 * so it proves the whole resume path end to end — including the one thing ISSUE_NUM
 * deliberately left to this check: that the captured `session_<uuid>` id round
 * trips VERBATIM through `-r` (the ISSUE_NUM secondary — resume hints carry the
 * underscore form; the CLI's not-found error echoed a no-underscore form, so the
 * only proof is a real resume of the real id succeeding).
 *
 * It SPENDS a little kimi quota (two live prompts) and needs a real CLI + real
 * creds, so it is gated OFF unless `RUSA_LIVE_PROVIDER_E2E=1` is set AND
 * all of bwrap-capable + kimi-on-PATH + kimi-credentials are present. In CI and
 * any creds-less env it skips cleanly — this is the re-fire pre-flight, run on
 * demand (`RUSA_LIVE_PROVIDER_E2E=1 vitest run kimi-sandbox-resume`), not a
 * per-PR test. Its zero-creds structural sibling is the per-PR CI guard.
 *
 * The opt-in is load-bearing, and separate from the capability probes on
 * purpose. Capability answers "could this run here"; it does NOT answer "did
 * someone mean to spend quota right now." Gating on capability alone conflated
 * the two, so on any box that happens to hold real kimi creds — the staging
 * validation box does — a bare `pnpm -r test` silently spent a live provider
 * window, and reported a red suite whenever that window was already exhausted
 * (`403 You've reached your usage limit`, twice in staging validation on
 * 2026-08-06). Neither failure was about the diff under test. Keep the
 * capability probes anyway: opting in on a box without bwrap or a CLI should
 * still skip cleanly rather than error.
 *
 * Close-gate for ISSUE_NUM: this must go GREEN before a live G2-v2 kimi re-fire is
 * spent. Empirically RED both before AND after ISSUE_NUM — ISSUE_NUM is necessary but not
 * sufficient. ISSUE_NUM persists a per-actor bind over `KIMI_CODE_HOME/sessions` only,
 * but `-r <id>` also consults `KIMI_CODE_HOME/session_index.jsonl` — a SIBLING of
 * `sessions/`, not a child — to map the id to its workdir bucket. That index stays
 * on the per-invocation tmpfs, so resume still fails "Session not found" even
 * though the session dir itself persists. Verified: a fully-persistent
 * KIMI_CODE_HOME (index included) resumes correctly. Goes GREEN once the ISSUE_NUM
 * follow-up persists the sibling index too (see ISSUE_NUM close-gate comment).
 */
function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function resolveKimiCli(): string {
  try {
    return execFileSync("which", ["kimi"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Explicit intent to spend live provider quota. Capability is not consent. */
const LIVE_E2E_OPTED_IN = process.env.RUSA_LIVE_PROVIDER_E2E === "1";
const BWRAP_CAPABLE = probeBwrapCapable();
const KIMI_CLI = resolveKimiCli();
const KIMI_CREDS_PRESENT = existsSync(join(homedir(), ".kimi-code", "credentials"));
const RUNNABLE = LIVE_E2E_OPTED_IN && BWRAP_CAPABLE && KIMI_CLI !== "" && KIMI_CREDS_PRESENT;

// Two live prompts through a real model — give the whole exchange generous room.
const E2E_TIMEOUT_MS = 12 * 60 * 1000;
const PER_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const CANARY_TOKEN = "MAGENTA-CANARY-7291";

describe.skipIf(!RUNNABLE)(
  "kimi sandboxed prompt + -r resume (operator E2E; ISSUE_NUM close-gate)",
  () => {
    let worktree: string;

    beforeEach(() => {
      worktree = mkdtempSync(join(tmpdir(), "kimi-resume-check-"));
    });

    afterEach(() => {
      // ISSUE_NUM's per-actor kimi session store is deliberately persistent (keyed by
      // the worktree basename), so nothing sweeps it but this test.
      const actorId = basename(realpathSync(worktree));
      rmSync(join(tmpdir(), `rusa-kimi-sessions-${actorId}`), {
        recursive: true,
        force: true,
      });
      rmSync(worktree, { recursive: true, force: true });
    });

    it(
      "resumes a prior sandboxed session by its verbatim captured id (no 'Session not found')",
      async () => {
        const provider = new KimiProvider("kimi-resume-check", { cliCommand: KIMI_CLI });
        const sandbox = { worktreePath: worktree };

        // Prompt 1 (fresh): plant a token and capture the session id from stream-json.
        const first = await provider.run({
          prompt: `Remember this token for later: ${CANARY_TOKEN}. Reply with exactly: stored.`,
          cwd: worktree,
          sandbox,
          timeoutMs: PER_RUN_TIMEOUT_MS,
        });
        expect(first.success, `fresh run failed: ${first.output.slice(0, 400)}`).toBe(true);
        expect(
          first.sessionId,
          "fresh run must capture a session id from stream-json"
        ).toBeTruthy();
        // ISSUE_NUM secondary: the captured id is the verbatim `session_<uuid>` resume hint.
        expect(first.sessionId).toMatch(/^session_/);

        // Prompt 2 (resume): pass that id VERBATIM to `-r`; it must resolve (the
        // ISSUE_NUM regression surfaced here as exitCode≠0 + "Session ... not found")
        // and the resumed session must recall the planted token.
        const second = await provider.run({
          prompt: "What token did I ask you to remember? Reply with only the token.",
          cwd: worktree,
          sandbox,
          session: { id: first.sessionId },
          timeoutMs: PER_RUN_TIMEOUT_MS,
        });
        expect(second.output).not.toMatch(/[Ss]ession.*not found/);
        expect(second.success, `resume run failed: ${second.output.slice(0, 400)}`).toBe(true);
        expect(second.output, "resumed session must recall the planted token").toContain(
          CANARY_TOKEN
        );
      },
      E2E_TIMEOUT_MS
    );
  }
);
