import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Dev-only launcher for the self-contained e2e runner. Builds the CLI, then runs
// the dev-only e2e entry, forwarding signals so SIGINT/SIGTERM reach the instance
// and its teardown handler runs (rm -rf $ROOT). See
// devlog/2026-06-07-self-contained-runner/design.md §5.1.

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDir, "..");

const rawArgs = process.argv.slice(2);
const watchIndex = rawArgs.indexOf("--watch");
const isWatch = watchIndex !== -1;
const e2eEnv = { ...process.env, RUSA_DISABLE_DASHBOARD_CACHE: "1" };

if (isWatch) {
  rawArgs.splice(watchIndex, 1);
}

if (isWatch) {
  console.log("[e2e] Building dashboard UI...");
  execFileSync("node", ["scripts/build-dashboard-ui.mjs"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  const { watch } = await import("node:fs");
  let buildTimer = null;
  const triggerBuild = () => {
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      console.log("[e2e] Rebuilding dashboard UI...");
      try {
        execFileSync("node", ["scripts/build-dashboard-ui.mjs"], {
          cwd: packageRoot,
          stdio: "inherit",
        });
        console.log("[e2e] Dashboard UI rebuilt.");
      } catch (e) {
        console.error("[e2e] Dashboard UI build failed.", e.message);
      }
    }, 500);
  };
  try {
    watch(resolve(packageRoot, "flutter_dashboard", "lib"), { recursive: true }, triggerBuild);
    watch(resolve(packageRoot, "flutter_dashboard", "web"), { recursive: true }, triggerBuild);
  } catch (e) {
    console.warn(`[e2e] Could not watch flutter_dashboard: ${e.message}`);
  }

  console.log("[e2e] Starting tsup in watch mode...");
  const commandArgs = ["./dist/commands/e2e.cli.js", ...rawArgs]
    .map((a) => (a.includes(" ") ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");

  const proc = spawn("pnpm", ["exec", "tsup", "--watch", "--onSuccess", `node ${commandArgs}`], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...e2eEnv, RUSA_TSUP_PRESERVE_DIST: "1" },
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!proc.killed) {
      proc.kill(signal);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  proc.on("exit", (code, signal) => {
    if (signal) {
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
} else {
  console.log("[e2e] Building dashboard UI...");
  execFileSync("node", ["scripts/build-dashboard-ui.mjs"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  console.log("[e2e] Building local CLI (tsup)...");
  execFileSync("pnpm", ["exec", "tsup"], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, RUSA_TSUP_PRESERVE_DIST: "1" },
  });

  const proc = spawn("node", ["./dist/commands/e2e.cli.js", ...rawArgs], {
    cwd: packageRoot,
    stdio: "inherit",
    env: e2eEnv,
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!proc.killed) {
      proc.kill(signal);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  proc.on("exit", (code, signal) => {
    if (signal) {
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}
