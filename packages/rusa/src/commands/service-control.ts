import { execFileSync, spawnSync } from "node:child_process";
import { resolveServiceInstance, type ServiceEnvironment } from "./service-instance.js";

function hasCommand(command: string): boolean {
  const probe = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function ensureSystemctl(): void {
  if (!hasCommand("systemctl")) {
    throw new Error(
      "systemctl is not available on this host. service control commands require systemd."
    );
  }
}

export async function runServiceStatus(opts?: { environment?: ServiceEnvironment }): Promise<void> {
  ensureSystemctl();
  const instance = resolveServiceInstance(opts?.environment ?? "production");

  const result = spawnSync(
    "systemctl",
    ["--user", "status", instance.serviceUnit, "--no-pager", "-l"],
    {
      stdio: "inherit",
    }
  );

  if (result.error) {
    throw new Error(`Failed to run systemctl status: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

export async function runServiceRestart(opts?: {
  environment?: ServiceEnvironment;
}): Promise<void> {
  ensureSystemctl();
  const instance = resolveServiceInstance(opts?.environment ?? "production");

  execFileSync("systemctl", ["--user", "restart", instance.serviceUnit], {
    stdio: "inherit",
  });

  console.log(`✓ ${instance.serviceUnit} restarted`);
}

export async function runServiceStop(opts?: { environment?: ServiceEnvironment }): Promise<void> {
  ensureSystemctl();
  const instance = resolveServiceInstance(opts?.environment ?? "production");

  execFileSync("systemctl", ["--user", "stop", instance.serviceUnit], {
    stdio: "inherit",
  });

  console.log(`✓ ${instance.serviceUnit} stopped`);
}
