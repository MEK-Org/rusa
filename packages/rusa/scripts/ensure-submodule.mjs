import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

// Initialize the glass_goals_devkit submodule if it is empty/missing
export function ensureSubmodule() {
  const devkitDir = resolve(repoRoot, "third_party/glass_goals_devkit");
  const packagesDir = resolve(devkitDir, "packages");

  if (existsSync(resolve(repoRoot, ".git"))) {
    let isEmpty = true;
    try {
      if (existsSync(packagesDir)) {
        const files = readdirSync(packagesDir);
        if (files.length > 0) {
          isEmpty = false;
        }
      }
    } catch {
      // ignore
    }

    if (isEmpty) {
      console.log("Initializing glass_goals_devkit submodule...");
      try {
        execSync("git submodule update --init --recursive", {
          cwd: repoRoot,
          stdio: "inherit",
        });
      } catch (err) {
        console.error("Warning: Failed to update git submodules:", err);
      }
    }
  }
}
