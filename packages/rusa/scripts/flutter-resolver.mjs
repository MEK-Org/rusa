import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveFlutterCommand() {
  if (process.env.FLUTTER_CMD) {
    const parts = process.env.FLUTTER_CMD.trim().split(/\s+/);
    return {
      cmd: parts[0],
      args: parts.slice(1),
    };
  }

  let hasFvmOnPath = false;
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      try {
        if (existsSync(resolve(dir, `fvm${ext}`))) {
          hasFvmOnPath = true;
          break;
        }
      } catch {
        // ignore fs errors
      }
    }
    if (hasFvmOnPath) break;
  }

  if (hasFvmOnPath) {
    return {
      cmd: "fvm",
      args: ["flutter"],
    };
  }

  return {
    cmd: "flutter",
    args: [],
  };
}
