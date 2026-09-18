import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFlutterCommand } from "./flutter-resolver.mjs";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDir, "..");
const flutterAppDir = resolve(packageRoot, "flutter_dashboard");
const flutterBuildDir = resolve(flutterAppDir, "build/web");
// RUSA_DIST_DIR lets the `update` tool stage into dist.new ; default dist.
const distDir = process.env.RUSA_DIST_DIR
  ? resolve(process.env.RUSA_DIST_DIR)
  : resolve(packageRoot, "dist");
const outputDir = resolve(distDir, "dashboard-ui-app");
const dashboardInstances = {
  prod: {
    iconSet: "prod",
    name: "Rusa",
    shortName: "Rusa",
    themeColor: "#38bdf8",
  },
  staging: {
    iconSet: "staging",
    name: "Rusa Staging",
    shortName: "Rusa Staging",
    themeColor: "#f59e0b",
  },
};
const dashboardInstance = dashboardInstances[process.env.RUSA_INSTANCE] ?? dashboardInstances.prod;

if (!existsSync(flutterAppDir)) {
  throw new Error(`Flutter dashboard app missing at ${flutterAppDir}`);
}

const resolved = resolveFlutterCommand();
const flutterProc = spawn(resolved.cmd, [...resolved.args, "build", "web", "--release"], {
  cwd: flutterAppDir,
  stdio: "pipe",
});
let output = "";
flutterProc.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
flutterProc.stderr.on("data", (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});
const code = await new Promise((resolve) => flutterProc.on("close", resolve));
if (code !== 0) {
  throw new Error(`Flutter build failed (exit ${code}):\n${output}`);
}

if (!existsSync(flutterBuildDir)) {
  throw new Error(`Expected Flutter web build output at ${flutterBuildDir}`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(flutterBuildDir, outputDir, { recursive: true });

const iconSourceDir = resolve(flutterAppDir, "web/icons", dashboardInstance.iconSet);
const iconOutputDir = resolve(outputDir, "icons");
if (!existsSync(iconSourceDir)) {
  throw new Error(`Dashboard icon set missing at ${iconSourceDir}`);
}
for (const iconName of [
  "Icon-192.png",
  "Icon-512.png",
  "Icon-maskable-192.png",
  "Icon-maskable-512.png",
]) {
  cpSync(resolve(iconSourceDir, iconName), resolve(iconOutputDir, iconName));
}

const manifestPath = resolve(outputDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.name = dashboardInstance.name;
manifest.short_name = dashboardInstance.shortName;
manifest.theme_color = dashboardInstance.themeColor;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const indexPath = resolve(outputDir, "index.html");
let indexHtml = readFileSync(indexPath, "utf8");
indexHtml = indexHtml.replace(
  /<meta name="theme-color" content="[^"]*">/,
  `<meta name="theme-color" content="${dashboardInstance.themeColor}">`
);
indexHtml = indexHtml.replace(
  /<meta name="apple-mobile-web-app-title" content="[^"]*">/,
  `<meta name="apple-mobile-web-app-title" content="${dashboardInstance.name}">`
);
indexHtml = indexHtml.replace(/<title>.*<\/title>/, `<title>${dashboardInstance.name}</title>`);
writeFileSync(indexPath, indexHtml);
