import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveServiceInstance, type ServiceEnvironment } from "./service-instance.js";

function runOrThrow(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function hasCommand(command: string): boolean {
  try {
    runOrThrow("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

function runSystemctlBestEffort(args: string[]): void {
  try {
    runOrThrow("systemctl", args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`⚠️  systemctl ${args.join(" ")} failed: ${msg}`);
  }
}

/**
 * Uninstall the systemd user service for rusa.
 */
export async function runUninstallService(opts?: {
  environment?: ServiceEnvironment;
}): Promise<void> {
  if (!hasCommand("systemctl")) {
    throw new Error(
      "systemctl is not available on this host. uninstall-service currently supports systemd only."
    );
  }

  const instance = resolveServiceInstance(opts?.environment ?? "production");
  const systemdUserDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(systemdUserDir, instance.serviceUnit);

  runSystemctlBestEffort(["--user", "stop", instance.serviceUnit]);
  runSystemctlBestEffort(["--user", "disable", instance.serviceUnit]);

  if (existsSync(unitPath)) {
    rmSync(unitPath);
    console.log(`✓ Removed ${unitPath}`);
  } else {
    console.log(`ℹ️  Unit file not found at ${unitPath}`);
  }

  runOrThrow("systemctl", ["--user", "daemon-reload"]);
  runSystemctlBestEffort(["--user", "reset-failed", instance.serviceUnit]);

  console.log("\nService uninstalled.");
  console.log(`- To reinstall: rusa install-service --environment ${instance.environment}`);
}
