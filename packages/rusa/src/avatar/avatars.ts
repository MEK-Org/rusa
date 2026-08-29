import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateHandle } from "../actor/handle-generator.js";
import { resolveHome } from "../config/index.js";

/**
 * Per-actor avatars (an issue). Each actor's handle (`{adjective}-{animal}`,
 * derived deterministically from its thread id) is a ready-made image prompt, so
 * we AI-generate a circular avatar for it and show it in the dashboard.
 *
 * Two hard rules, both about keeping the system calm and stable:
 *
 *  - **Strictly fire-and-forget.** Generation is an out-of-band side effect on
 *    spawn. It must NEVER block, delay, or break actor spawning, and it must NOT
 *    retry — a recent rate-limit storm came from self-continuing failures, so the
 *    avatar path is one shot: on any error we log and move on.
 *  - **Generate once, never regenerate.** Image generation is non-deterministic;
 *    the first image for a handle is cached to disk and kept stable across
 *    restarts. An existing cache file is never overwritten.
 *
 * The `root` actor is special-cased: it serves a fixed bundled default robot avatar image.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * The bundled root avatar (default robot image), committed as a repo asset and
 * copied into `dist/assets` at build time. The candidate list covers the bundled
 * runtime (cli is bundled to `dist/cli.js`, so `import.meta.url` resolves to
 * `dist/`) and the source/test layout (`src/avatar/avatars.ts`).
 */
const ROOT_AVATAR_CANDIDATES = [
  resolve(moduleDir, "assets/default-avatar.png"), // bundled: dist/assets
  resolve(moduleDir, "../assets/default-avatar.png"),
  resolve(moduleDir, "../../assets/default-avatar.png"), // source: packages/rusa/assets
];

/** Gemini image model — "nano banana" . Square via imageConfig.aspectRatio. */
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

/** Locked prompt/style, settled with Operator over many iterations on ISSUE_NUM. */
function buildPrompt(adjective: string, animal: string): string {
  return (
    `A charming, photorealistic head-and-shoulders HEADSHOT of a ${adjective} ${animal} ` +
    "with a friendly, playful, endearing expression and personality. Soft warm natural " +
    "lighting, a gentle whimsical fantasy touch, approachable and cute — light-hearted, " +
    "NOT intense or dramatic. SQUARE 1:1, subject centered and filling the frame, simple " +
    "soft pleasant background. No text, no border, no frame."
  );
}

/**
 * Split a `{adjective}-{animal}` handle. Adjectives never contain a hyphen, but
 * animals can (e.g. `elephant-seal`, `dik-dik`), so we split on the FIRST hyphen
 * only. A handle with no hyphen (defensive) maps both fields to itself.
 */
export function splitHandle(handle: string): { adjective: string; animal: string } {
  const dash = handle.indexOf("-");
  if (dash === -1) return { adjective: handle, animal: handle };
  return { adjective: handle.slice(0, dash), animal: handle.slice(dash + 1) };
}

/** The directory that holds cached worker avatars: `~/.rusa/avatars`. */
export function avatarsDir(): string {
  return join(resolveHome(), "avatars");
}

/**
 * Stable on-disk cache path for a worker's avatar, keyed by the **unique thread
 * id** — NOT the handle. `generateHandle` indexes 256-word lists off two hash
 * bytes, so its handle space is tiny and collision-prone (birthday collisions at
 * low tens of actors); the handle is a display label, not an identity. Keying by
 * id avoids two actors that hash to the same handle silently sharing one avatar
 * file (which the never-regenerate guard would make permanent). The handle is
 * used only for the generation prompt's subject and for display.
 */
export function avatarCachePath(id: string): string {
  return join(avatarsDir(), `${id}.png`);
}

/**
 * Absolute path to the configured root avatar override (`rootActor.avatar`) when
 * it resolves to a file that exists, else null. Split out of {@link
 * rootAvatarPath} because dashboard branding (#48) has to tell an image this
 * instance's operator actually chose apart from the bundled default that every
 * install shares — the latter is generic rusa artwork, not this root's face.
 */
export function configuredRootAvatarPath(configuredPath?: string): string | null {
  if (!configuredPath) return null;
  const resolved = resolve(configuredPath);
  return existsSync(resolved) ? resolved : null;
}

/**
 * Absolute path to the root avatar image: the configured override
 * (`rootActor.avatar`) if it resolves to a file that exists, else the bundled
 * System Root image, or null if neither can be found.
 */
export function rootAvatarPath(configuredPath?: string): string | null {
  return (
    configuredRootAvatarPath(configuredPath) ??
    ROOT_AVATAR_CANDIDATES.find((p) => existsSync(p)) ??
    null
  );
}

/**
 * True if this thread id / handle is the root (System Root, or a
 * configured instance's own root identity).
 *
 * Keys off root *identity* via {@link generateHandle}, NOT a literal display
 * string: the raw root id `"root"` maps to `"silicon-familiar"`, and the display
 * handle `"silicon-familiar"` passes through unchanged, so either form resolves
 * the root. No worker uuid can map to `"silicon-familiar"`, so renaming root's
 * display can't make a worker masquerade as root / steal the bundled dog image.
 *
 * `rootHandle` is the resolved configured handle (`resolveRootHandle(config)`,
 * ISSUE_NUM) — when a root is configured to present as e.g. `ember-familiar`,
 * that display handle must ALSO resolve to root, in addition to the
 * `"root"`/`"silicon-familiar"` default mapping above (which is unaffected by
 * config and always resolves the plumbing id).
 */
export function isRootHandle(handleOrId: string, rootHandle?: string): boolean {
  if (generateHandle(handleOrId) === generateHandle("root")) return true;
  return rootHandle !== undefined && handleOrId === rootHandle;
}

export interface AvatarGenDeps {
  /** Gemini API key (`config.geminiApiKey`). When empty, generation is skipped. */
  apiKey: string;
  log?: (msg: string) => void;
  /** Optional root handle override for root identity resolution. */
  rootHandle?: string;
  /** Durable root id, used when fresh installs no longer use the legacy literal id. */
  rootId?: string;
}

/**
 * Call the Gemini image API once and return the decoded PNG bytes. No retries —
 * a failure throws and the fire-and-forget caller logs it and moves on.
 */
async function callGeminiImage(apiKey: string, prompt: string): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // Native square 512x512 output (ISSUE_NUM, ISSUE_NUM): model renders 1:1 at 512 size.
      generationConfig: {
        imageConfig: {
          aspectRatio: "1:1",
          imageSize: "512",
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`gemini image API request failed (status ${res.status})`);
  }
  let json: {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
  };
  try {
    json = (await res.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
    };
  } catch {
    throw new Error("gemini image API returned a non-JSON body");
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (typeof data === "string" && data.length > 0) return Buffer.from(data, "base64");
  }
  throw new Error("gemini image API returned no inlineData image part");
}

/**
 * Generate and cache the avatar for one thread, exactly once. Skips the root
 * (fixed bundled image), a missing API key, and any id already cached. The file
 * is keyed by the unique thread **id** (see {@link avatarCachePath}); the handle
 * supplies only the prompt's adjective-animal subject. The write is staged
 * through a temp file + rename so a crash mid-download can never leave a
 * half-written PNG cached (which we'd then never regenerate).
 *
 * Throws on failure — callers should use {@link kickAvatarGeneration} so the
 * error stays isolated to a log line.
 */
export async function generateAvatarOnce(threadId: string, deps: AvatarGenDeps): Promise<void> {
  if (threadId === deps.rootId || isRootHandle(threadId)) return; // root uses the fixed bundled image
  if (!deps.apiKey) return; // no key configured → nothing to do
  const path = avatarCachePath(threadId); // keyed by id, not the handle
  if (existsSync(path)) return; // never regenerate — keep the first one stable

  // The handle is the prompt subject only (display name), never the identity.
  const { adjective, animal } = splitHandle(generateHandle(threadId));
  const png = await callGeminiImage(deps.apiKey, buildPrompt(adjective, animal));
  writeAvatarCacheFile(threadId, png);
  deps.log?.(`avatar generated for ${threadId} (${generateHandle(threadId)})`);
}

/**
 * Stage a write through a temp file + rename, so a crash mid-write can never
 * leave a half-written file cached. Shared by every writer of the avatar
 * cache — {@link generateAvatarOnce}'s never-regenerate path, {@link
 * generateAvatarForce}'s explicit-regenerate path, and the dashboard's manual
 * {@link uploadAvatar} — each of which decides separately whether an existing
 * file may be overwritten.
 */
function writeAvatarCacheFile(id: string, bytes: Buffer): void {
  const path = avatarCachePath(id);
  mkdirSync(avatarsDir(), { recursive: true });
  // A per-write random suffix (not just the pid) so two writes for the same id
  // racing within this process never share a temp path — the loser's rename
  // would otherwise hit ENOENT after the winner's rename already moved it.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/** The 8-byte PNG file signature (`\x89PNG\r\n\x1a\n`). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True if `bytes` starts with the PNG file signature. */
export function isPngSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

/** True if `bytes` starts with the JPEG file signature (`\xFF\xD8\xFF`). */
export function isJpegSignature(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** True if `bytes` starts with either a PNG or JPEG file signature. */
export function isValidImageSignature(bytes: Buffer): boolean {
  return isPngSignature(bytes) || isJpegSignature(bytes);
}

/**
 * Generate and cache the avatar for one thread, **always** overwriting any
 * existing cached file. This is the explicit-user-action counterpart to
 * {@link generateAvatarOnce}: that function's "never regenerate" guard exists
 * to keep a fire-and-forget, non-deterministic spawn-time generation stable
 * across restarts, but a dashboard "Generate" button click is a deliberate,
 * one-shot request that must always take effect. Root and a missing API key
 * still short-circuit as no-ops. Throws on failure (e.g. the Gemini call) —
 * callers (the dashboard API route) report the error directly rather than
 * swallowing it, unlike the fire-and-forget {@link kickAvatarGeneration}.
 */
export async function generateAvatarForce(threadId: string, deps: AvatarGenDeps): Promise<void> {
  if (!deps.apiKey) return; // no key configured → nothing to do

  const isRoot = threadId === deps.rootId || isRootHandle(threadId, deps.rootHandle);
  const handle = isRoot ? (deps.rootHandle ?? "root-actor") : generateHandle(threadId);
  const { adjective, animal } = splitHandle(handle);
  const imageBytes = await callGeminiImage(deps.apiKey, buildPrompt(adjective, animal));
  // Validate before writing so an unexpected Gemini response (wrong MIME,
  // truncated/malformed base64) throws instead of silently clobbering a working cached avatar.
  if (!isValidImageSignature(imageBytes)) {
    throw new Error("gemini image API returned bytes that are not a valid PNG or JPEG");
  }
  const targetId = isRoot ? "root" : threadId;
  writeAvatarCacheFile(targetId, imageBytes);
  deps.log?.(`avatar force-generated for ${targetId} (${handle})`);
}

/**
 * Cache a manually-uploaded avatar image for one thread, **always**
 * overwriting any existing cached file — an explicit upload is a deliberate
 * user action, unlike AI generation's non-deterministic first-write-wins
 * default (see {@link generateAvatarOnce}). Callers (the dashboard API route)
 * are responsible for validating the size before calling this; this function
 * itself verifies `bytes` is actually PNG or JPEG-signed.
 * When `rootId` is supplied, that generated durable identity is canonicalized
 * to the grandfathered `root` cache key used by {@link readAvatar}.
 */
export function uploadAvatar(id: string, bytes: Buffer, rootId?: string): void {
  if (!isValidImageSignature(bytes)) {
    throw new Error("uploaded avatar bytes are not a valid PNG or JPEG");
  }
  writeAvatarCacheFile(id === rootId ? "root" : id, bytes);
}

/**
 * Fire-and-forget avatar generation for one thread. NEVER throws and NEVER
 * blocks the caller — this is the only entry point the spawn path and backfill
 * should use. A single attempt; on any error we log and move on (no retries).
 */
export function kickAvatarGeneration(threadId: string, deps: AvatarGenDeps): void {
  void generateAvatarOnce(threadId, deps).catch((err) => {
    deps.log?.(
      `avatar gen for ${threadId} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

/**
 * One-time backfill: kick generation for every currently-live actor that lacks a
 * cached avatar, so existing actors (root, elder, stewards) get an avatar without
 * waiting to respawn. Same fire-and-forget path as on-spawn; root and already
 * cached ids are no-ops inside {@link generateAvatarOnce}.
 */
export function backfillAvatars(threadIds: Iterable<string>, deps: AvatarGenDeps): void {
  for (const id of threadIds) kickAvatarGeneration(id, deps);
}

/** A resolved avatar ready to serve: file bytes plus its content type. */
export interface ServedAvatar {
  body: Buffer;
  contentType: string;
}

/** The configured root identity's avatar-relevant fields , both optional. */
export interface RootAvatarIdentity {
  /** The durable root thread id; generated for fresh installs. */
  id?: string;
  /** The resolved display handle (`resolveRootHandle(config)`), if configured. */
  handle?: string;
  /** `rootActor.avatar` — an override image path, if configured. */
  avatarPath?: string;
}

/**
 * Resolve the avatar to serve for a request key, the **thread id** (with any
 * file extension already stripped). Worker files are keyed by id, so the UI
 * requests by id; the root is served an uploaded image if available, else its fixed
 * bundled image (or the configured override, see {@link RootAvatarIdentity}).
 */
export function readAvatar(id: string, rootIdentity?: RootAvatarIdentity): ServedAvatar | null {
  const isRoot = id === rootIdentity?.id || isRootHandle(id, rootIdentity?.handle);
  const targetId = isRoot ? "root" : id;
  const p = avatarCachePath(targetId);
  if (existsSync(p)) {
    const body = readFileSync(p);
    const contentType = isJpegSignature(body) ? "image/jpeg" : "image/png";
    return { body, contentType };
  }

  if (isRoot) {
    const rootPath = rootAvatarPath(rootIdentity?.avatarPath);
    if (!rootPath) return null;
    return {
      body: readFileSync(rootPath),
      contentType: rootPath.endsWith(".png") ? "image/png" : "image/jpeg",
    };
  }
  return null;
}

/**
 * Sniff an image file's content type from its first bytes, without loading the
 * whole file. Only PNG and JPEG are ever cached (see {@link
 * isValidImageSignature}), so anything not JPEG-signed is reported as PNG — the
 * same rule {@link readAvatar} applies to bytes it has already read.
 */
function sniffImageContentType(path: string): string {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(8);
    const read = readSync(fd, head, 0, head.length, 0);
    return isJpegSignature(head.subarray(0, read)) ? "image/jpeg" : "image/png";
  } finally {
    closeSync(fd);
  }
}

/** A root image this instance's operator chose, ready to brand the dashboard with. */
export interface RootBrandingImage {
  /** Absolute path of the image on disk. */
  path: string;
  /** `image/png` or `image/jpeg`, sniffed from the file's signature. */
  contentType: string;
  /** Cache-busting stamp; changes whenever the file is replaced. */
  version: string;
}

/**
 * The root actor's *own* image, or null when this instance is still showing the
 * bundled default.
 *
 * Deliberately narrower than {@link readAvatar}: that one always resolves to
 * something for the root (falling back to the bundled robot) because the
 * dashboard needs an avatar to draw. Branding is the opposite — the bundled
 * robot is generic rusa artwork shared by every install, so falling back to it
 * would replace the crafted actor-mesh favicon with an equally generic but worse
 * one. Only an uploaded/generated root image, or a configured `rootActor.avatar`,
 * counts. Never throws: a missing or racing file just means "no branding image".
 */
export function rootBrandingImage(rootIdentity?: RootAvatarIdentity): RootBrandingImage | null {
  try {
    // Root images always cache under the literal `root` key — `uploadAvatar` and
    // `generateAvatarForce` both canonicalize the durable root id to it.
    const uploaded = avatarCachePath("root");
    const path = existsSync(uploaded)
      ? uploaded
      : configuredRootAvatarPath(rootIdentity?.avatarPath);
    if (!path) return null;
    const stats = statSync(path);
    return {
      path,
      contentType: sniffImageContentType(path),
      version: `${Math.trunc(stats.mtimeMs)}-${stats.size}`,
    };
  } catch {
    return null;
  }
}
