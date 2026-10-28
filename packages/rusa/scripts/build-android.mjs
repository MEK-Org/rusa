#!/usr/bin/env node
// Build the Android dashboard APK branded for this instance (#1191): the
// launcher label, launcher icon and application id come from config.yaml the
// way the web dashboard's branding does. Arguments after `--` go to
// `flutter build apk` unchanged (build mode, `--dart-define`s).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatAndroidBuildReceipt,
  resolveAndroidBranding,
  writeAndroidBrandingResources,
} from "../build/maintenance/dashboard/android-branding.js";
import { resolveFlutterCommand } from "./flutter-resolver.mjs";

const thisDir = dirname(fileURLToPath(import.meta.url));
const flutterAppDir = resolve(thisDir, "../flutter_dashboard");
const resDir = resolve(flutterAppDir, "build/rusa-android-branding/res");
const flutterArgs = process.argv.slice(2).filter((arg) => arg !== "--");

let branding;
try {
  branding = resolveAndroidBranding({ instance: process.env.RUSA_INSTANCE, flutterAppDir });
  writeAndroidBrandingResources(branding, resDir);
} catch (err) {
  process.stderr.write(`build:android: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const resolved = resolveFlutterCommand();
const build = spawnSync(
  resolved.cmd,
  [
    ...resolved.args,
    "build",
    "apk",
    ...flutterArgs,
    `--android-project-arg=rusaApplicationId=${branding.applicationId}`,
    `--android-project-arg=rusaBrandingRes=${resDir}`,
  ],
  { cwd: flutterAppDir, stdio: "inherit" }
);
if (build.status !== 0) {
  process.stderr.write(`build:android: flutter build apk exited ${build.status ?? build.signal}\n`);
  process.exit(build.status ?? 1);
}

// Flutter names the APK by mode, ABI split and flavor; name its directory.
const outputDir = resolve(flutterAppDir, "build/app/outputs/flutter-apk");
process.stdout.write(`\n${formatAndroidBuildReceipt(branding, outputDir)}`);
