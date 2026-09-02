import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const committedIconRoot = resolve(packageRoot, "flutter_dashboard/web/icons");
const generatedRoot = mkdtempSync(resolve(tmpdir(), "rusa-dashboard-icons-"));
const generatedIconRoot = resolve(generatedRoot, "flutter_dashboard/web/icons");

const generatedAssets = [
  "Icon-192.png",
  "Icon-512.png",
  "Icon-maskable-192.png",
  "Icon-maskable-512.png",
  "prod/Icon-192.png",
  "prod/Icon-512.png",
  "prod/Icon-maskable-192.png",
  "prod/Icon-maskable-512.png",
  "staging/Icon-192.png",
  "staging/Icon-512.png",
  "staging/Icon-maskable-192.png",
  "staging/Icon-maskable-512.png",
] as const;

function rgbaPixels(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return { width, height, pixels: inflateSync(Buffer.concat(idat)) };
}

function alphaAt(png: Buffer, x: number, y: number): number {
  const { width, pixels } = rgbaPixels(png);
  return pixels[y * (1 + width * 4) + 1 + x * 4 + 3] ?? -1;
}

beforeAll(() => {
  const scriptDir = resolve(generatedRoot, "scripts");
  mkdirSync(scriptDir, { recursive: true });
  const script = resolve(scriptDir, "generate-dashboard-icons.mjs");
  copyFileSync(resolve(packageRoot, "scripts/generate-dashboard-icons.mjs"), script);
  execFileSync(process.execPath, [script]);
}, 20_000);

afterAll(() => rmSync(generatedRoot, { recursive: true, force: true }));

describe("generated dashboard icon assets", () => {
  it("match the checked-in PNGs", () => {
    for (const asset of generatedAssets) {
      expect(readFileSync(resolve(committedIconRoot, asset))).toEqual(
        readFileSync(resolve(generatedIconRoot, asset))
      );
    }
  });

  it.each([
    "Icon-192.png",
    "Icon-512.png",
    "prod/Icon-192.png",
    "prod/Icon-512.png",
    "staging/Icon-192.png",
    "staging/Icon-512.png",
  ])("keeps %s fully opaque at every corner", (asset) => {
    const png = readFileSync(resolve(generatedIconRoot, asset));
    const { width, height } = rgbaPixels(png);
    expect([
      alphaAt(png, 0, 0),
      alphaAt(png, width - 1, 0),
      alphaAt(png, 0, height - 1),
      alphaAt(png, width - 1, height - 1),
    ]).toEqual([255, 255, 255, 255]);
  });
});
