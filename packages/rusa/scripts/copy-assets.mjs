import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copy bundled static assets (e.g. the fixed root avatar, ISSUE_NUM) into dist/ so a
// fresh `npm pack`/deploy (which ships only `dist/`) has them. The avatar module
// resolves `dist/assets/...` at runtime when bundled.
const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDir, "..");
const assetsSrc = resolve(packageRoot, "assets");
// RUSA_DIST_DIR lets the `update` tool stage into dist.new ; default dist.
const distDir = process.env.RUSA_DIST_DIR
  ? resolve(process.env.RUSA_DIST_DIR)
  : resolve(packageRoot, "dist");
const assetsDest = resolve(distDir, "assets");

if (!existsSync(assetsSrc)) {
  console.warn(`[copy-assets] no assets dir at ${assetsSrc} — nothing to copy`);
} else {
  mkdirSync(assetsDest, { recursive: true });
  cpSync(assetsSrc, assetsDest, { recursive: true });
  console.log(`[copy-assets] copied ${assetsSrc} → ${assetsDest}`);
}

const scriptsSrc = resolve(packageRoot, "scripts");
const scriptsDest = resolve(distDir, "scripts");
const ghWrapperSrc = resolve(scriptsSrc, "gh-hint-wrapper.sh");
const ghWrapperDest = resolve(scriptsDest, "gh-hint-wrapper.sh");
if (existsSync(ghWrapperSrc)) {
  mkdirSync(scriptsDest, { recursive: true });
  cpSync(ghWrapperSrc, ghWrapperDest);
  console.log(`[copy-assets] copied ${ghWrapperSrc} → ${ghWrapperDest}`);
}
