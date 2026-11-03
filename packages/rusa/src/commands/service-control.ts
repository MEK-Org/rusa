import { execFileSync, spawnSync } from "node:child_process";
import { dashboardBaseUrl } from "./chat.js";
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

export async function runServiceShutdown(opts?: {
  environment?: ServiceEnvironment;
  timeout?: number;
  behavior?: "cancel" | "terminate";
  reason?: string;
  cancel?: boolean;
  url?: string;
}): Promise<void> {
  const instance = resolveServiceInstance(opts?.environment ?? "production");
  const baseUrl = opts?.url ?? dashboardBaseUrl({ home: instance.mcHome });
  const endpoint = opts?.cancel
    ? `${baseUrl}/api/mesh/shutdown/cancel`
    : `${baseUrl}/api/mesh/shutdown`;
  const body = opts?.cancel
    ? JSON.stringify({ reason: opts?.reason })
    : JSON.stringify({
        timeoutSeconds: opts?.timeout,
        timeoutBehavior: opts?.behavior,
        reason: opts?.reason,
      });

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok || !data.ok) {
      console.error(`Failed to request shutdown: ${data.error ?? res.statusText}`);
      process.exitCode = 1;
      return;
    }
    console.log(data.message);
  } catch (err) {
    console.error(
      `Failed to connect to Rusa service at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}
