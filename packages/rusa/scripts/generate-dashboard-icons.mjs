import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const thisDir = dirname(fileURLToPath(import.meta.url));
const iconRoot = resolve(thisDir, "../flutter_dashboard/web/icons");

const variants = {
  prod: {
    accent: [56, 189, 248, 255],
    link: [59, 130, 246, 166],
  },
  staging: {
    accent: [245, 158, 11, 255],
    link: [251, 191, 36, 178],
  },
};

const background = [27, 32, 48, 255];
const node = [226, 232, 240, 255];
const transparent = [0, 0, 0, 0];
const icons = [
  ["Icon-192.png", 192, false],
  ["Icon-512.png", 512, false],
  ["Icon-maskable-192.png", 192, true],
  ["Icon-maskable-512.png", 512, true],
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function blend(base, overlay, alpha) {
  const overlayAlpha = (overlay[3] / 255) * alpha;
  const baseAlpha = base[3] / 255;
  const outAlpha = overlayAlpha + baseAlpha * (1 - overlayAlpha);
  if (outAlpha === 0) return transparent;
  return [
    Math.round((overlay[0] * overlayAlpha + base[0] * baseAlpha * (1 - overlayAlpha)) / outAlpha),
    Math.round((overlay[1] * overlayAlpha + base[1] * baseAlpha * (1 - overlayAlpha)) / outAlpha),
    Math.round((overlay[2] * overlayAlpha + base[2] * baseAlpha * (1 - overlayAlpha)) / outAlpha),
    Math.round(outAlpha * 255),
  ];
}

function sampleMark(x, y, variant, maskable) {
  const scale = maskable ? 0.72 : 1;
  const offset = (1 - scale) / 2;
  const u = (x - offset) / scale;
  const v = (y - offset) / scale;
  // Both icon classes need an opaque edge-to-edge canvas. Standard launchers
  // apply their own corner treatment; only the dedicated maskable artwork
  // insets the mark into the adaptive-icon safe zone.
  let color = background;

  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
    const lines = [
      [16 / 32, 16 / 32, 8 / 32, 8 / 32],
      [16 / 32, 16 / 32, 25 / 32, 9 / 32],
      [16 / 32, 16 / 32, 21 / 32, 24 / 32],
    ];
    for (const [ax, ay, bx, by] of lines) {
      if (distanceToSegment(u, v, ax, ay, bx, by) <= 0.8 / 32) {
        color = blend(color, variant.link, 1);
      }
    }

    for (const [cx, cy, radius, fill] of [
      [8 / 32, 8 / 32, 2.6 / 32, node],
      [25 / 32, 9 / 32, 2.6 / 32, node],
      [21 / 32, 24 / 32, 2.6 / 32, node],
      [16 / 32, 16 / 32, 4.4 / 32, variant.accent],
    ]) {
      if ((u - cx) ** 2 + (v - cy) ** 2 <= radius ** 2) {
        color = blend(color, fill, 1);
      }
    }
  }

  return color;
}

function makePng(size, variant, maskable) {
  const channels = 4;
  const samples = 3;
  const stride = 1 + size * channels;
  const raw = Buffer.alloc(size * stride);

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      let color = transparent;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          color = blend(
            color,
            sampleMark(
              (x + (sx + 0.5) / samples) / size,
              (y + (sy + 0.5) / samples) / size,
              variant,
              maskable
            ),
            1 / (samples * samples)
          );
        }
      }
      const i = y * stride + 1 + x * channels;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
      raw[i + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [variantName, variant] of Object.entries(variants)) {
  const variantDir = resolve(iconRoot, variantName);
  mkdirSync(variantDir, { recursive: true });
  for (const [fileName, size, maskable] of icons) {
    const png = makePng(size, variant, maskable);
    writeFileSync(resolve(variantDir, fileName), png);
    if (variantName === "prod") {
      writeFileSync(resolve(iconRoot, fileName), png);
    }
  }
}
