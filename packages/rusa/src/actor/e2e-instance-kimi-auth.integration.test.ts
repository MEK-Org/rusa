import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2EInstanceManager } from "./e2e-instance-manager.js";

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

// Mirrors kimi's own write paths (see sandbox.ts's kimi handling): credentials/ is
// replaced via same-directory tmpfile + rename, and oauth/ hosts proper-lockfile's
// mkdir-based refresh lock. Run as the trailing command of the REAL outer e2e bwrap
// (in place of `pnpm run e2e am-up ...`), nesting a second real bwrap that mirrors
// exactly what a Kimi actor sandbox does with KIMI_CODE_HOME. Before issue #225's fix,
// the outer sandbox bound the whole ~/.kimi-code tree read-only, so this nested
// writable bind inherited that read-only mount and both operations failed EROFS.
const NESTED_KIMI_WRITE_SCRIPT = `
set -e
bwrap --unshare-all --share-net --die-with-parent \
  --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp \
  --setenv KIMI_CODE_HOME /tmp/kimi-home --dir /tmp/kimi-home \
  --ro-bind "$HOME/.kimi-code/config.toml" /tmp/kimi-home/config.toml \
  --bind "$HOME/.kimi-code/credentials" /tmp/kimi-home/credentials \
  --bind "$HOME/.kimi-code/oauth" /tmp/kimi-home/oauth \
  -- /bin/sh -c '
    printf %s "{\\"accessToken\\":\\"synthetic-after\\"}" > /tmp/kimi-home/credentials/kimi-code.json.tmp &&
    mv /tmp/kimi-home/credentials/kimi-code.json.tmp /tmp/kimi-home/credentials/kimi-code.json &&
    mkdir /tmp/kimi-home/oauth/kimi-code.lock &&
    rmdir /tmp/kimi-home/oauth/kimi-code.lock
  '
`;

describe.skipIf(!BWRAP_CAPABLE)(
  "E2EInstanceManager Kimi auth projection (real nested bwrap)",
  () => {
    let root = "";
    let workersDir = "";
    let mcHome = "";
    let actorWorktree = "";
    let hostCredsFile = "";
    let active = false;

    const makeWorktree = (path: string) => {
      mkdirSync(join(path, "packages", "rusa", "scripts"), { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        `${JSON.stringify({ packageManager: "pnpm@10.29.3" })}\n`
      );
      writeFileSync(join(path, "packages", "rusa", "scripts", "e2e.mjs"), "");
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "e2e-instance-kimi-auth-"));
      workersDir = join(root, "workers");
      mcHome = join(root, "mc-home");
      actorWorktree = join(workersDir, "actor-a", "rusa");
      mkdirSync(mcHome, { recursive: true });
      makeWorktree(actorWorktree);
      writeFileSync(join(mcHome, "config.yaml"), "providers: {}\n");
      // Synthetic fixtures only — structurally like kimi's real files, no real secrets.
      const kimiCodeDir = join(root, ".kimi-code");
      mkdirSync(join(kimiCodeDir, "credentials"), { recursive: true });
      mkdirSync(join(kimiCodeDir, "oauth"), { recursive: true });
      writeFileSync(join(kimiCodeDir, "config.toml"), "");
      hostCredsFile = join(kimiCodeDir, "credentials", "kimi-code.json");
      writeFileSync(hostCredsFile, '{"accessToken":"synthetic-before"}', { mode: 0o600 });
      active = false;
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const manager = () =>
      new E2EInstanceManager({
        mcHome,
        workersDir,
        hostHome: root,
        toolchainPath: "/usr/local/bin:/usr/bin:/bin",
        corepackPath: "/bin/true",
        flutterRoot: "", // skip the Flutter overlay branch; irrelevant to Kimi auth
        providerExecutables: {},
        isPortReady: async () => true,
        delay: async () => {},
        handleForId: (id) => `handle-${id}`,
        now: () => "2026-09-05T00:00:00.000Z",
        exec: (file, args) => {
          if (file === "systemd-run") {
            const bwrapIndex = args.indexOf("bwrap");
            const bwrapArgs = args.slice(bwrapIndex + 1);
            const sepIndex = bwrapArgs.indexOf("--");
            const outerMountArgs = bwrapArgs.slice(0, sepIndex);
            // Run the REAL outer bwrap the manager constructed, replacing only the
            // trailing `pnpm run e2e am-up ...` workload with our nested-write probe.
            execFileSync(
              "bwrap",
              [...outerMountArgs, "--", "/bin/sh", "-c", NESTED_KIMI_WRITE_SCRIPT],
              {
                stdio: "pipe",
              }
            );
            active = true;
            return "";
          }
          if (file === "systemctl" && args.includes("stop")) {
            active = false;
            return "";
          }
          return [
            "LoadState=loaded",
            `ActiveState=${active ? "active" : "inactive"}`,
            `SubState=${active ? "running" : "dead"}`,
            "Result=success",
          ].join("\n");
        },
      });

    it("writes a nested Kimi sandbox's refresh through the outer projection to the real host credentials file", async () => {
      await manager().up("actor-a", actorWorktree);

      expect(JSON.parse(readFileSync(hostCredsFile, "utf8"))).toEqual({
        accessToken: "synthetic-after",
      });
    });

    it("keeps the nested write-through working across the externally-stopped-unit recovery shape", async () => {
      const subject = manager();
      await subject.up("actor-a", actorWorktree);
      expect(JSON.parse(readFileSync(hostCredsFile, "utf8"))).toEqual({
        accessToken: "synthetic-after",
      });

      // Simulate the unit dying outside the instance manager (issue #225's actual
      // trigger): the holder record survives, the unit itself does not. Since #224's
      // fix, `up()` now rejects any second call while a holder record exists —
      // recovery is only via that holder's own down() + up() — so exercise that
      // exact path here and confirm the rebuilt runtime's Kimi auth projection is
      // still correctly write-through, not just correctly *shaped* (the unit test
      // already covers shape; this covers a real nested bwrap actually writing).
      active = false;
      writeFileSync(hostCredsFile, '{"accessToken":"synthetic-rotated-by-real-host-actor"}', {
        mode: 0o600,
      });

      subject.down("actor-a");
      await subject.up("actor-a", actorWorktree);

      expect(JSON.parse(readFileSync(hostCredsFile, "utf8"))).toEqual({
        accessToken: "synthetic-after",
      });
    });
  }
);
