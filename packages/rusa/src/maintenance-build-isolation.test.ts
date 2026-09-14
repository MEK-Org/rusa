import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// #318 accepted this package on one boundary: a maintenance script may never
// clean or rebuild `packages/rusa/dist`, because a live service runs from it.
// That boundary lives entirely in build configuration, so nothing but a test
// stops a future path or entry edit from quietly restoring the coupling.

const packageRoot = process.cwd();
const distDir = join(packageRoot, "dist");
const maintenanceOutDir = join(packageRoot, "build", "maintenance");
const sentinelPath = join(distDir, "maintenance-build-isolation.sentinel");
const staleBundlePath = join(maintenanceOutDir, "stale-orphan-entry.js");

// One authoritative spelling of the maintenance build; every maintenance script
// prepends exactly this, so the config path is named in a single place.
const MAINTENANCE_BUILD = "pnpm --reporter=silent run build:maintenance --silent";

const SCRIPT_FILES = {
  "backfill:codex-quota": "backfill-codex-quota-parses.mjs",
  "backfill:token-records": "backfill-run-token-records.mjs",
  "eval:quota": "eval-quota-extraction.mjs",
  "replay:codex-observations": "replay-codex-quota-observations.mjs",
} as const;

const MAINTENANCE_SCRIPTS = Object.keys(SCRIPT_FILES) as (keyof typeof SCRIPT_FILES)[];

const MAINTENANCE_ENTRIES = [
  "actor/backfill-run-token-records.js",
  "mcp/quota-mcp.js",
  "quota/shared-store.js",
] as const;

type PackageManifest = { scripts: Record<string, string> };

function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
}

function listFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}

// Content hash *and* mtime per file: rebuilding `dist` beside a live service is
// the hazard #318 named, and a rebuild that happened to reproduce byte-identical
// output still deleted and rewrote the file the service is running from.
function snapshotTree(dir: string): string[] {
  return listFiles(dir)
    .map((file) => {
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      return `${digest} ${statSync(file).mtimeMs} ${relative(dir, file)}`;
    })
    .sort();
}

let createdDistDir = false;

afterEach(() => {
  rmSync(sentinelPath, { force: true });
  rmSync(staleBundlePath, { force: true });
  if (createdDistDir) {
    rmSync(distDir, { recursive: true, force: true });
    createdDistDir = false;
  }
});

describe("maintenance build isolation", () => {
  it("routes every maintenance script through the single maintenance build command", () => {
    const { scripts } = readPackageManifest();
    expect(scripts["build:maintenance"]).toBe("tsup --config tsup.maintenance.config.ts");
    for (const name of MAINTENANCE_SCRIPTS) {
      expect(scripts[name]).toBe(`${MAINTENANCE_BUILD} && node scripts/${SCRIPT_FILES[name]}`);
    }
    // The build contract is spelled once, in `build:maintenance` itself.
    const namingTheConfig = Object.entries(scripts)
      .filter(([, command]) => command.includes("tsup.maintenance.config.ts"))
      .map(([name]) => name);
    expect(namingTheConfig).toEqual(["build:maintenance"]);
  });

  it("keeps maintenance entries out of the production bundle", () => {
    const production = readFileSync(join(packageRoot, "tsup.config.ts"), "utf8");
    const maintenance = readFileSync(join(packageRoot, "tsup.maintenance.config.ts"), "utf8");
    for (const entry of MAINTENANCE_ENTRIES) {
      const key = entry.replace(/\.js$/, "");
      expect(production).not.toContain(`"${key}"`);
      expect(maintenance).toContain(`"${key}"`);
    }
    expect(maintenance).toContain('outDir: "build/maintenance"');
    expect(maintenance).not.toContain('outDir: "dist"');
  });

  it("builds and runs a maintenance script without touching dist", () => {
    createdDistDir = !existsSync(distDir);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(sentinelPath, "maintenance tooling must never rebuild dist\n", "utf8");
    mkdirSync(maintenanceOutDir, { recursive: true });
    // A bundle from an entry that no longer exists must not survive a build.
    writeFileSync(staleBundlePath, "export const stale = true;\n", "utf8");

    const before = snapshotTree(distDir);

    // The full shipped path: build the isolated output, then run the script,
    // whose `build/maintenance` imports are top-level — so exit 0 proves the
    // isolated bundle both built and resolved.
    const run = spawnSync("pnpm", ["--reporter=silent", "run", "eval:quota", "--help"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("pnpm --filter rusa run eval:quota");

    expect(snapshotTree(distDir)).toEqual(before);
    for (const entry of MAINTENANCE_ENTRIES) {
      expect(existsSync(join(maintenanceOutDir, entry))).toBe(true);
    }
    expect(existsSync(staleBundlePath)).toBe(false);
  }, 120_000);
});
