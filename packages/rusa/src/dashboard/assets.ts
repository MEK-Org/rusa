import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const dirsToTry = [
  resolve(moduleDir, "./dashboard-ui-app"),
  resolve(moduleDir, "../../dist/dashboard-ui-app"),
  resolve(moduleDir, "../dashboard-ui-app"),
  "/app/packages/rusa/dist/dashboard-ui-app", // Fallback for container environments
];

const dashboardAssetDir =
  dirsToTry.find((dir) => {
    try {
      return existsSync(resolve(dir, "index.html"));
    } catch {
      return false;
    }
  }) || resolve(moduleDir, "../dashboard-ui-app");

const textCache = new Map<string, string>();
const bufferCache = new Map<string, Buffer>();
const cacheDisabled = process.env.RUSA_DISABLE_DASHBOARD_CACHE === "1";

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
]);

function readDashboardTextAsset(assetName: string): string {
  if (!cacheDisabled) {
    const cached = textCache.get(assetName);
    if (cached !== undefined) return cached;
  }

  const fullPath = resolve(dashboardAssetDir, assetName);
  try {
    const content = readFileSync(fullPath, "utf8");
    if (!cacheDisabled) textCache.set(assetName, content);
    return content;
  } catch (error) {
    throw new Error(
      `Missing dashboard asset ${assetName} at ${fullPath}. Run "pnpm --filter @thkp-eng/rusa build:dashboard-ui".`,
      { cause: error }
    );
  }
}

function readDashboardBinaryAsset(assetName: string): Buffer {
  if (!cacheDisabled) {
    const cached = bufferCache.get(assetName);
    if (cached) return cached;
  }
  const fullPath = resolve(dashboardAssetDir, assetName);
  const content = readFileSync(fullPath);
  if (!cacheDisabled) bufferCache.set(assetName, content);
  return content;
}

function normalizeAssetPath(pathname: string): string | null {
  const noQuery = pathname.split("?")[0] ?? pathname;
  const trimmed = noQuery.replace(/^\/+/, "");
  if (!trimmed) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

function contentTypeFor(assetPath: string): string {
  const dot = assetPath.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = assetPath.slice(dot).toLowerCase();
  return CONTENT_TYPES.get(ext) ?? "application/octet-stream";
}

export function hasDashboardAsset(assetName: string): boolean {
  return existsSync(resolve(dashboardAssetDir, assetName));
}

export function getDashboardAssetDir(): string {
  return dashboardAssetDir;
}

export function getDashboardHtml(): string {
  return readDashboardTextAsset("index.html");
}

export function getDashboardAsset(pathname: string): { body: Buffer; contentType: string } | null {
  const assetPath = normalizeAssetPath(pathname);
  if (!assetPath) return null;

  const fullPath = resolve(dashboardAssetDir, assetPath);
  if (!fullPath.startsWith(dashboardAssetDir)) return null;
  if (!existsSync(fullPath)) return null;

  try {
    if (statSync(fullPath).isDirectory()) return null;
  } catch {
    return null;
  }

  return {
    body: readDashboardBinaryAsset(assetPath),
    contentType: contentTypeFor(assetPath),
  };
}
