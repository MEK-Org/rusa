import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type { RusaConfig } from "../config/types.js";
import { runStart } from "./start.js";

const DEV_HOME = join(process.env.HOME || homedir(), ".rusa-test");

/** Dev-dedicated ports that don't collide with staging. */
const DEV_WEBHOOK_PORT = 9745;
const DEV_DASHBOARD_PORT = 8082;

function setDevPorts(): void {
  const configPath = join(DEV_HOME, "config.yaml");
  if (!existsSync(configPath)) {
    console.error(`❌ No config found at ${configPath}`);
    console.error(`   Run: RUSA_HOME=${DEV_HOME} rusa init`);
    process.exit(1);
  }

  const rawDevConfig = readFileSync(configPath, "utf-8");
  const devConfig = parseYaml(rawDevConfig) as RusaConfig;

  devConfig.webhook = {
    ...(devConfig.webhook ?? {}),
    port: DEV_WEBHOOK_PORT,
  };
  devConfig.dashboard = {
    ...(devConfig.dashboard ?? {}),
    port: DEV_DASHBOARD_PORT,
  };
  if (devConfig.dashboard && "tailscaleHostname" in devConfig.dashboard) {
    delete devConfig.dashboard.tailscaleHostname;
  }
  if (devConfig.dashboard && "tailscaleServiceName" in devConfig.dashboard) {
    delete devConfig.dashboard.tailscaleServiceName;
  }

  writeFileSync(configPath, toYaml(devConfig), "utf-8");
}

/**
 * `rusa dev` — Start rusa against the ~/.rusa-test instance
 * with a fresh database. Useful for development and testing.
 */
export async function runDev(opts: {
  keepDb?: boolean;
  noDashboardServer?: boolean;
}): Promise<void> {
  // Override RUSA_HOME to point at the test instance
  process.env.RUSA_HOME = DEV_HOME;
  setDevPorts();

  const dbPath = join(DEV_HOME, "data", "mesh.db");
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  if (!opts.keepDb) {
    for (const f of [dbPath, walPath, shmPath]) {
      if (existsSync(f)) {
        rmSync(f);
      }
    }
    console.log("🗑️  Cleared database for fresh start");
  } else {
    console.log("📦 Keeping existing database");
  }

  // runStart initializes the DB (and runs migrations) itself; clearing the files
  // above is enough for a fresh start.
  console.log(
    `🔧 Dev mode: RUSA_HOME=${DEV_HOME} (webhook=${DEV_WEBHOOK_PORT}, dashboard=${DEV_DASHBOARD_PORT})\n`
  );

  await runStart({
    noDashboardServer: opts.noDashboardServer,
  });
}
