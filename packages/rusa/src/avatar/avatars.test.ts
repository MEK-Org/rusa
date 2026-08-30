import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHandle } from "../actor/handle-generator.js";
import {
  avatarCachePath,
  avatarsDir,
  backfillAvatars,
  configuredRootAvatarPath,
  generateAvatarForce,
  generateAvatarOnce,
  isPngSignature,
  isRootHandle,
  readAvatar,
  rootAvatarPath,
  rootBrandingImage,
  splitHandle,
  uploadAvatar,
} from "./avatars.js";

// A real UUID so generateHandle produces a `{adjective}-{animal}` handle.
const UUID = "aaaaaaaa-0000-4000-8000-000000000001";

// A minimal PNG-signed buffer (signature + arbitrary payload) — `uploadAvatar`
// verifies the signature, so plain text bytes no longer pass.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png-payload"),
]);

describe("splitHandle", () => {
  it("splits a simple adjective-animal handle", () => {
    expect(splitHandle("cloudy-porpoise")).toEqual({ adjective: "cloudy", animal: "porpoise" });
  });

  it("splits on the FIRST hyphen so multi-word animals stay intact", () => {
    // Adjectives never contain a hyphen; animals can (elephant-seal, dik-dik).
    expect(splitHandle("amber-elephant-seal")).toEqual({
      adjective: "amber",
      animal: "elephant-seal",
    });
    expect(splitHandle("misty-dik-dik")).toEqual({ adjective: "misty", animal: "dik-dik" });
  });

  it("maps a hyphenless handle to itself (defensive)", () => {
    expect(splitHandle("root")).toEqual({ adjective: "root", animal: "root" });
  });
});

describe("isRootHandle", () => {
  it("recognises the root by id and by display handle", () => {
    expect(isRootHandle("root")).toBe(true);
    // Resolves the root from its display handle too, not just the plumbing id.
    expect(isRootHandle("root-actor")).toBe(true);
    expect(isRootHandle(UUID)).toBe(false);
    expect(isRootHandle(generateHandle(UUID))).toBe(false);
  });

  it("still recognises the plumbing id and default handle when a root handle is configured ", () => {
    expect(isRootHandle("root", "ember-familiar")).toBe(true);
    expect(isRootHandle("root-actor", "ember-familiar")).toBe(true);
  });

  it("also recognises the configured display handle as root ", () => {
    expect(isRootHandle("ember-familiar", "ember-familiar")).toBe(true);
    // Without the configured handle passed in, it's just an ordinary string.
    expect(isRootHandle("ember-familiar")).toBe(false);
  });

  it("never lets a worker handle collide with the configured root handle", () => {
    expect(isRootHandle(generateHandle(UUID), "ember-familiar")).toBe(false);
  });
});

describe("rootAvatarPath", () => {
  it("resolves the bundled default robot avatar image", () => {
    const p = rootAvatarPath();
    expect(p).not.toBeNull();
    expect(existsSync(p as string)).toBe(true);
  });

  it("falls back to the bundled image when the configured path doesn't exist ", () => {
    const p = rootAvatarPath("/nonexistent/ember.jpg");
    expect(p).not.toBeNull();
    expect(p).toBe(rootAvatarPath());
  });
});

describe("with an isolated RUSA_HOME", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.RUSA_HOME;
    home = mkdtempSync(join(tmpdir(), "mc-avatars-"));
    process.env.RUSA_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RUSA_HOME;
    else process.env.RUSA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("keys the cache path by the unique thread id, NOT the handle", () => {
    // The fix for the elder's collision flag: the file is identified by id.
    expect(avatarCachePath(UUID)).toBe(join(home, "avatars", `${UUID}.png`));
    // Two actors that hashed to the same handle must NOT share a file: the path
    // is the id's, never the (collision-prone) handle's.
    expect(avatarCachePath(UUID)).not.toBe(avatarCachePath(generateHandle(UUID)));
  });

  it("readAvatar returns the bundled png for root", () => {
    const served = readAvatar("root");
    expect(served).not.toBeNull();
    expect(served?.contentType).toBe("image/png");
    expect(served?.body.length ?? 0).toBeGreaterThan(0);
  });

  it("readAvatar returns null for a worker with no cached file yet", () => {
    expect(readAvatar(UUID)).toBeNull();
  });

  it("readAvatar serves the configured avatar override for root ", () => {
    const overridePath = join(home, "ember.jpg");
    writeFileSync(overridePath, Buffer.from([0xff, 0xd8, 0xff]));

    const served = readAvatar("root", { avatarPath: overridePath });
    expect(served?.contentType).toBe("image/jpeg");
    expect(served?.body.toString()).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString());
  });

  it("readAvatar resolves root by its configured display handle too ", () => {
    const served = readAvatar("ember-familiar", { handle: "ember-familiar" });
    expect(served).not.toBeNull();
    expect(served?.contentType).toBe("image/png");
    // Without the configured handle passed in, that key is just an ordinary
    // (uncached) worker id, not root.
    expect(readAvatar("ember-familiar")).toBeNull();
  });

  it("readAvatar serves a cached worker png by id (the handle is not a file key)", () => {
    mkdirSync(avatarsDir(), { recursive: true });
    writeFileSync(avatarCachePath(UUID), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const byId = readAvatar(UUID);
    expect(byId?.contentType).toBe("image/png");
    expect(byId?.body.length).toBe(4);
    // The handle is a display label, not a file key — it resolves nothing.
    expect(readAvatar(generateHandle(UUID))).toBeNull();
  });

  it("generateAvatarOnce is a no-op for root (no network)", async () => {
    await expect(generateAvatarOnce("root", { apiKey: "key" })).resolves.toBeUndefined();
    // root never writes into the cache dir.
    expect(existsSync(avatarsDir())).toBe(false);
  });

  it("generateAvatarOnce is a no-op without an API key (no network)", async () => {
    await expect(generateAvatarOnce(UUID, { apiKey: "" })).resolves.toBeUndefined();
    expect(existsSync(avatarCachePath(UUID))).toBe(false);
  });

  it("generateAvatarOnce never regenerates an existing cache file (no network)", async () => {
    mkdirSync(avatarsDir(), { recursive: true });
    const path = avatarCachePath(UUID);
    writeFileSync(path, Buffer.from("original"));
    // apiKey set but file exists → must short-circuit before any fetch.
    await expect(generateAvatarOnce(UUID, { apiKey: "key" })).resolves.toBeUndefined();
    expect(readAvatar(UUID)?.body.toString()).toBe("original");
  });

  it("uploadAvatar writes bytes for a worker id", () => {
    uploadAvatar(UUID, PNG_BYTES);
    expect(readAvatar(UUID)?.body.equals(PNG_BYTES)).toBe(true);
  });

  it("uploadAvatar canonicalizes a generated root id to the stable root cache key", () => {
    uploadAvatar(UUID, PNG_BYTES, UUID);
    expect(readAvatar(UUID, { id: UUID })?.body.equals(PNG_BYTES)).toBe(true);
    expect(existsSync(avatarCachePath(UUID))).toBe(false);
    expect(existsSync(avatarCachePath("root"))).toBe(true);
  });

  it("uploadAvatar ALWAYS overwrites an existing cached file (an explicit action, unlike generation)", () => {
    mkdirSync(avatarsDir(), { recursive: true });
    writeFileSync(avatarCachePath(UUID), PNG_BYTES);
    const replacement = Buffer.concat([PNG_BYTES, Buffer.from("-replacement")]);
    uploadAvatar(UUID, replacement);
    expect(readAvatar(UUID)?.body.equals(replacement)).toBe(true);
  });

  it("uploadAvatar rejects bytes that aren't PNG-signed, and never writes them", () => {
    expect(() => uploadAvatar(UUID, Buffer.from("not-a-png"))).toThrow(/valid PNG/);
    expect(existsSync(avatarCachePath(UUID))).toBe(false);
  });

  it("uploadAvatar rejects a truncated buffer shorter than the PNG signature", () => {
    expect(() => uploadAvatar(UUID, Buffer.from([0x89, 0x50, 0x4e]))).toThrow(/valid PNG/);
  });

  it("isPngSignature accepts real signature bytes with trailing payload and rejects everything else", () => {
    expect(isPngSignature(PNG_BYTES)).toBe(true);
    expect(isPngSignature(Buffer.from("not-a-png"))).toBe(false);
    expect(isPngSignature(Buffer.alloc(0))).toBe(false);
  });

  it("generateAvatarForce supports root actor avatar generation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: PNG_BYTES.toString("base64") } }],
            },
          },
        ],
      }),
    } as unknown as Response);

    try {
      await generateAvatarForce("root", { apiKey: "key" });
      expect(readAvatar("root")?.body.equals(PNG_BYTES)).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("generateAvatarForce is a no-op without an API key (no network)", async () => {
    await expect(generateAvatarForce(UUID, { apiKey: "" })).resolves.toBeUndefined();
    expect(existsSync(avatarCachePath(UUID))).toBe(false);
  });

  it("generateAvatarForce ALWAYS overwrites an existing cached file, unlike generateAvatarOnce", async () => {
    mkdirSync(avatarsDir(), { recursive: true });
    writeFileSync(avatarCachePath(UUID), Buffer.from("original"));

    const regenerated = Buffer.concat([PNG_BYTES, Buffer.from("-regenerated")]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: regenerated.toString("base64") } }],
            },
          },
        ],
      }),
    } as unknown as Response);

    try {
      await generateAvatarForce(UUID, { apiKey: "key" });
      expect(fetchMock).toHaveBeenCalled();
      expect(readAvatar(UUID)?.body.equals(regenerated)).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("generateAvatarForce rejects a non-PNG response and preserves the existing cache", async () => {
    mkdirSync(avatarsDir(), { recursive: true });
    writeFileSync(avatarCachePath(UUID), Buffer.from("original"));

    // Gemini returned inlineData that decodes to bytes with no PNG signature —
    // e.g. a wrong-MIME or truncated/malformed response.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: Buffer.from("not-a-png").toString("base64") } }],
            },
          },
        ],
      }),
    } as unknown as Response);

    try {
      await expect(generateAvatarForce(UUID, { apiKey: "key" })).rejects.toThrow(/valid PNG/);
      expect(readAvatar(UUID)?.body.toString()).toBe("original");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("backfillAvatars never throws and skips root + cached (no network)", () => {
    mkdirSync(avatarsDir(), { recursive: true });
    writeFileSync(avatarCachePath(UUID), Buffer.from("cached"));
    // root (fixed image) and UUID (already cached) are both no-ops; an empty key
    // is harmless. No apiKey path is exercised for any uncached worker.
    expect(() => backfillAvatars(["root", UUID], { apiKey: "" })).not.toThrow();
  });

  it("generateAvatarOnce fetches with imageSize: '512' and aspectRatio: '1:1'", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: Buffer.from("fake-png-bytes").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    } as unknown as Response);

    try {
      await generateAvatarOnce(UUID, { apiKey: "key" });

      expect(fetchMock).toHaveBeenCalled();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("gemini-3.1-flash-image:generateContent");

      const body = JSON.parse(init?.body as string);
      expect(body.generationConfig.imageConfig).toEqual({
        aspectRatio: "1:1",
        imageSize: "512",
      });

      const cached = readAvatar(UUID);
      expect(cached).not.toBeNull();
      expect(cached?.contentType).toBe("image/png");
      expect(cached?.body.toString()).toBe("fake-png-bytes");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rootBrandingImage ignores the bundled default that readAvatar falls back to", () => {
    // The whole point of the branding accessor: `readAvatar` must always produce
    // something for root, but the bundled robot is generic rusa artwork shared by
    // every install, so it is not this root's face and must not brand the page.
    expect(readAvatar("root")).not.toBeNull();
    expect(rootBrandingImage()).toBeNull();
  });

  it("rootBrandingImage picks up an uploaded root image, with a stamp that tracks it", () => {
    uploadAvatar("root", PNG_BYTES);
    const first = rootBrandingImage();
    expect(first?.path).toBe(avatarCachePath("root"));
    expect(first?.contentType).toBe("image/png");

    uploadAvatar("root", Buffer.concat([PNG_BYTES, Buffer.from("-grown")]));
    expect(rootBrandingImage()?.version).not.toBe(first?.version);
  });

  it("rootBrandingImage sniffs a JPEG override without reading the whole file", () => {
    const overridePath = join(home, "ember.jpg");
    writeFileSync(overridePath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect(rootBrandingImage({ avatarPath: overridePath })?.contentType).toBe("image/jpeg");
  });

  it("configuredRootAvatarPath resolves only a path that exists", () => {
    const overridePath = join(home, "ember.png");
    expect(configuredRootAvatarPath(overridePath)).toBeNull();
    writeFileSync(overridePath, PNG_BYTES);
    expect(configuredRootAvatarPath(overridePath)).toBe(overridePath);
    expect(configuredRootAvatarPath(undefined)).toBeNull();
  });
});
