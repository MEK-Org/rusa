import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A build-complete sentinel that guarantees a partial/mismatched `dist/` never boots
 * (ISSUE_NUM, elder require #1). The `update` tool builds into a STAGING dir and atomically
 * swaps it onto the live `dist/` only on a green build; the sentinel (the built commit
 * sha) is written INTO the staging dir, so it travels WITH `dist` in the swap — `dist`
 * and its sentinel are always one consistent unit, and a failed build leaves the live
 * pair untouched.
 *
 * Boot is gated by `ExecStartPre` running the standalone, build-independent
 * `scripts/verify-build.mjs`, which calls {@link verifyBuildSentinel}: the service
 * starts only when the sentinel exists AND matches the checkout's current HEAD. So a
 * mismatched/absent sentinel → boot refused (loud, alerted via `OnFailure`) rather than
 * running a corrupt dist.
 */
export function buildSentinelPath(distDir: string): string {
  return join(distDir, ".build-ok");
}

/** Remove the sentinel (force-invalidate a dist's build-complete marker). */
export function clearBuildSentinel(distDir: string): void {
  rmSync(buildSentinelPath(distDir), { force: true });
}

/** Write the sentinel with the built sha — into the staging dir, before the swap. */
export function writeBuildSentinel(distDir: string, sha: string): void {
  const path = buildSentinelPath(distDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${sha.trim()}\n`, "utf8");
}

/** The sha recorded in the sentinel, or null if absent/unreadable. */
export function readBuildSentinel(distDir: string): string | null {
  try {
    const sha = readFileSync(buildSentinelPath(distDir), "utf8").trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Verify the built dist matches `expectedSha` (the checkout's current HEAD). Used
 * by the boot-time `ExecStartPre` gate. Pure + total (never throws) so the
 * standalone verifier can rely on it.
 */
export function verifyBuildSentinel(
  distDir: string,
  expectedSha: string
): { ok: boolean; reason: string } {
  const recorded = readBuildSentinel(distDir);
  if (!recorded) {
    return { ok: false, reason: "no build-complete sentinel (build missing or interrupted)" };
  }
  if (recorded !== expectedSha.trim()) {
    return {
      ok: false,
      reason: `built sha ${recorded.slice(0, 7)} != checkout HEAD ${expectedSha.trim().slice(0, 7)}`,
    };
  }
  return { ok: true, reason: "build matches HEAD" };
}
