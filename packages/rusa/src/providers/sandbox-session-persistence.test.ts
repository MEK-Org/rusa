import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs, codexRolloutStoreDir, teardownFlutterOverlay } from "./sandbox.js";

/**
 * Real-bwrap integration guard for the ONE property every resumable provider
 * session depends on: the session store must PERSIST across two independent
 * sandbox invocations for the same actor. `codex --resume` / `kimi -r <id>`
 * both resolve a prior session by reading that store on a later, fresh run — so
 * if the store lives on per-invocation tmpfs it silently vanishes and every
 * multi-turn sandboxed actor dies on its first continuation.
 *
 * This is the class behind three sequential sandboxed-kimi seam bugs (ISSUE_NUM
 * EROFS creds, ISSUE_NUM fix, ISSUE_NUM `-r` "Session not found") — each argv-only
 * sandbox.test.ts assertion checked that a bind FLAG was present, but none
 * proved the bind actually achieves persistence through real bwrap. This does,
 * with NO provider creds required: the sentinel is written by /bin/sh, not the
 * provider CLI, so it exercises the sandbox wiring alone.
 *
 * codex is the green control (persistent store since ISSUE_NUM). kimi is the ISSUE_NUM
 * canary: RED on staging (no sessions bind — store is under `--tmpfs /tmp`),
 * GREEN once ISSUE_NUM binds `rusa-kimi-sessions-<actor>` over
 * `/tmp/kimi-home/sessions`. Run this on the ISSUE_NUM branch to prove the fix
 * offline before spending a live re-fire.
 *
 * Gated on a real trivial-sandbox probe (not `which bwrap`) — the exact
 * convention from host-job-runner.test.ts:38 — so a runner with the binary but
 * no unprivileged-userns capability skips cleanly instead of red-flaking.
 */
function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const BWRAP_CAPABLE = probeBwrapCapable();

// The in-sandbox path each provider writes its resumable session store to.
// - codex: SANDBOX_CODEX_SESSIONS_PATH, a persistent bind ← codexRolloutStoreDir .
// - kimi:  KIMI_CODE_HOME/sessions, which `kimi -r` resolves via a readdir scan ;
//          persisted by the rusa-kimi-sessions-<actor> bind added in ISSUE_NUM.
const PROVIDER_SESSION_STORE = {
  codex: "/tmp/sessions",
  kimi: "/tmp/kimi-home/sessions",
} as const;

describe.skipIf(!BWRAP_CAPABLE)(
  "provider session store persists across sandbox invocations (real bwrap)",
  () => {
    let actorDir: string;
    let fixtureHome: string;
    const createdTempPaths: string[] = [];
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fixtureHome = mkdtempSync(join(tmpdir(), "session-persist-home-"));
      process.env.HOME = fixtureHome;
      actorDir = mkdtempSync(join(tmpdir(), "session-persist-test-"));
    });

    afterEach(() => {
      // Both providers' stores are deliberately persistent (the actor's memory,
      // NOT tempPaths) so the sandbox never sweeps them — this test must, keyed
      // by the actor id (= dir basename), matching each store's own convention.
      // Resolve the id BEFORE removing actorDir, or realpath would ENOENT.
      const actorId = basename(realpathSync(actorDir));
      rmSync(codexRolloutStoreDir(actorDir), { recursive: true, force: true });
      rmSync(join(tmpdir(), `rusa-kimi-sessions-${actorId}`), {
        recursive: true,
        force: true,
      });
      teardownFlutterOverlay(actorDir);
      rmSync(actorDir, { recursive: true, force: true });
      for (const p of createdTempPaths.splice(0)) {
        rmSync(p, { recursive: true, force: true });
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(fixtureHome, { recursive: true, force: true });
    });

    /**
     * Write a sentinel into the provider's session store in one sandbox, then
     * read it back from a second, independent sandbox for the same actor dir.
     * Returns whether the sentinel survived — i.e. whether resume could ever
     * find a prior session.
     */
    function survivesSecondInvocation(
      authMode: "codex" | "kimi",
      storePath: string,
      sentinel: string
    ): boolean {
      const { args, tempPaths } = buildActorBwrapArgs(actorDir, authMode);
      if (tempPaths) {
        createdTempPaths.push(...tempPaths);
      }
      execFileSync(
        "bwrap",
        [
          ...args,
          "--",
          "/bin/sh",
          "-c",
          `mkdir -p '${storePath}' && echo '${sentinel}' > '${storePath}/probe'`,
        ],
        { encoding: "utf-8" }
      );
      const out = execFileSync(
        "bwrap",
        [...args, "--", "/bin/sh", "-c", `cat '${storePath}/probe' 2>/dev/null || echo MISSING`],
        { encoding: "utf-8" }
      );
      return out.includes(sentinel);
    }

    // Green control: codex's rollout store persists . If this ever goes
    // red, the harness/env is broken — not a provider regression.
    it("codex: rollout store survives a second invocation (ISSUE_NUM resume baseline)", () => {
      expect(
        survivesSecondInvocation("codex", PROVIDER_SESSION_STORE.codex, "CODEX_SENTINEL")
      ).toBe(true);
    }, 15_000);

    // ISSUE_NUM canary: RED on staging (store under tmpfs), GREEN on the ISSUE_NUM branch.
    it("kimi: session store survives a second invocation (ISSUE_NUM -r resume; requires ISSUE_NUM)", () => {
      expect(survivesSecondInvocation("kimi", PROVIDER_SESSION_STORE.kimi, "KIMI_SENTINEL")).toBe(
        true
      );
    }, 15_000);
  }
);
