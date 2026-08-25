import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFlutterCommand } from "./flutter-resolver.mjs";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDir, "..");
const flutterAppDir = resolve(packageRoot, "flutter_dashboard");

const resolved = resolveFlutterCommand();
const flutterArgs = process.argv.slice(2);

execFileSync(resolved.cmd, [...resolved.args, ...flutterArgs], {
  cwd: flutterAppDir,
  stdio: "inherit",
});
