import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveServiceInstance, type ServiceEnvironment } from "./service-instance.js";

function hasCommand(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function follow(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code);
    });
  });
}

export async function runLogs(opts?: { environment?: ServiceEnvironment }): Promise<void> {
  const instance = resolveServiceInstance(opts?.environment ?? "production");
  const logPath = instance.logPath;

  if (hasCommand("journalctl")) {
    console.log("Following systemd logs (no history). Press Ctrl-C to stop.\n");

    const code = await follow("journalctl", [
      "--user",
      "-u",
      instance.serviceUnit,
      "-f",
      "-n",
      "0",
      "-o",
      "cat",
    ]);

    // Usually Ctrl-C ends the process; only fall back on explicit failure.
    if (code === 0 || code === null) {
      return;
    }

    console.log("journalctl follow failed; falling back to log file tail.\n");
  }

  if (!existsSync(logPath)) {
    throw new Error(
      `No log file found at ${logPath}. Start the service or run 'rusa install-service' first.`
    );
  }

  console.log(`Following ${logPath} (no history). Press Ctrl-C to stop.\n`);
  await follow("tail", ["-n", "0", "-F", logPath]);
}
