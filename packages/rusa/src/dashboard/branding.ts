import { generateHandle } from "../actor/handle-generator.js";
import { type RootAvatarIdentity, rootBrandingImage } from "../avatar/avatars.js";

/**
 * Dashboard branding from this instance's configured root actor.
 *
 * The shipped UI is branded "Rusa" (or "Rusa Staging") at build time by
 * `scripts/build-dashboard-ui.mjs`, which is the right default for an instance
 * that has not been given its own identity. But `rootActor.handle` /
 * `rootActor.avatar` already name and picture *this* instance's root everywhere
 * else — the GitHub signing byline, the actor tree, the commitment ledger — and
 * a bookmarked tab or an installed PWA reading "Rusa" is exactly the surface
 * where that identity matters most. So when a root actor has been configured,
 * its name titles the page and the PWA, and its own image becomes the favicon
 * and the app icon.
 *
 * Both halves are independent and each falls back to the built-in branding on
 * its own: a named root with no image keeps the bundled actor-mesh mark, and an
 * uploaded image on an unnamed root keeps the built "Rusa" name.
 */
export interface DashboardBranding {
  /** Display name for the tab title and PWA app name, or null to keep the built-in name. */
  name: string | null;
  /** URL of the root's own image, or null to keep the bundled icons. */
  iconUrl: string | null;
  /** MIME type of the image at {@link iconUrl}; null whenever `iconUrl` is null. */
  iconType: string | null;
}

/** Nothing configured — every surface keeps what the build baked in. */
const NO_BRANDING: DashboardBranding = { name: null, iconUrl: null, iconType: null };

/** True when at least one surface should be rewritten. */
export function hasBranding(branding: DashboardBranding): boolean {
  return branding.name !== null || branding.iconUrl !== null;
}

/**
 * Turn a root handle into an app name: `ember-familiar` → `Ember Familiar`.
 *
 * Handles are lowercase `{adjective}-{animal}` slugs, which read as an id in the
 * actor tree (where they stay verbatim) but as a typo in a browser tab or under
 * a home-screen icon. Only word boundaries and casing change, so an operator who
 * configures a handle that is already a name (`Ember`) gets it back untouched.
 */
export function formatBrandName(handle: string): string {
  return handle
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Resolve the branding for one request from the root identity the server was
 * wired with (`rootActor.handle` / `rootActor.avatar` plus any uploaded image).
 *
 * Called per request rather than once at startup: an operator can upload or
 * regenerate the root's image from the dashboard while the server runs, and the
 * `version` stamp in `iconUrl` is what makes the browser pick the new one up.
 */
export function resolveDashboardBranding(rootIdentity?: RootAvatarIdentity): DashboardBranding {
  // An unset `rootActor.handle` resolves to the default `root-actor`, which is
  // the plumbing name for "no identity configured" — not a name to brand with.
  const handle = rootIdentity?.handle;
  const name = handle && handle !== generateHandle("root") ? formatBrandName(handle) : null;

  const image = rootBrandingImage(rootIdentity);
  if (!image) return name === null ? NO_BRANDING : { ...NO_BRANDING, name };

  // Reuse the existing avatar route rather than adding a second way to serve the
  // same bytes; it resolves the root by id or handle and is served even without a
  // live mesh. The extension only has to satisfy the route's suffix strip — the
  // response's own content type comes from the file's signature either way.
  const extension = image.contentType === "image/jpeg" ? "jpg" : "png";
  return {
    name,
    iconUrl: `/api/mesh/avatar/root.${extension}?v=${encodeURIComponent(image.version)}`,
    iconType: image.contentType,
  };
}

/** Escape a string for use inside an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Rewrite the built `index.html` shell for this instance.
 *
 * Every replacement is a no-op when its tag is absent, so a shell built by a
 * future Flutter version that drops one of them degrades to "unbranded" instead
 * of breaking. The icon links are replaced as a group: the bundled `favicon.svg`
 * outranks the PNG in every browser, so pointing only the PNG at the root image
 * would leave the mesh mark on screen.
 */
export function applyBrandingToHtml(html: string, branding: DashboardBranding): string {
  let out = html;

  if (branding.name !== null) {
    const name = escapeHtml(branding.name);
    out = out.replace(/<title>[^<]*<\/title>/i, `<title>${name}</title>`);
    out = out.replace(
      /<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="apple-mobile-web-app-title" content="${name}">`
    );
  }

  // Only swap the icons when there is a `</head>` to re-anchor them to, so a
  // shell we cannot rebuild is never left with no favicon at all.
  if (branding.iconUrl !== null && /<\/head>/i.test(out)) {
    const href = escapeHtml(branding.iconUrl);
    const type = escapeHtml(branding.iconType ?? "image/png");
    out = out
      .replace(/[ \t]*<link\s+rel="icon"[^>]*>\n?/gi, "")
      .replace(/[ \t]*<link\s+rel="apple-touch-icon"[^>]*>\n?/gi, "")
      .replace(
        /<\/head>/i,
        `  <link rel="icon" type="${type}" href="${href}"/>\n` +
          `  <link rel="apple-touch-icon" href="${href}">\n</head>`
      );
  }

  return out;
}

/**
 * Rewrite the built `manifest.json` for this instance: the installed PWA's name
 * and, when the root has its own image, its icon.
 *
 * The bundled icon entries are dropped rather than kept as extra sizes — a
 * browser picking the closest declared size would otherwise still install the
 * generic mark. The root image is declared `sizes: "any"` because an uploaded
 * file has no size we can promise (generated ones are 512×512, uploads are
 * whatever the operator picked), and "any" is what the spec has for exactly that.
 *
 * A manifest we cannot parse is passed through untouched.
 */
export function applyBrandingToManifest(manifestJson: string, branding: DashboardBranding): string {
  if (!hasBranding(branding)) return manifestJson;

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifestJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return manifestJson;
    manifest = parsed as Record<string, unknown>;
  } catch {
    return manifestJson;
  }

  if (branding.name !== null) {
    manifest.name = branding.name;
    manifest.short_name = branding.name;
  }
  if (branding.iconUrl !== null) {
    manifest.icons = [
      { src: branding.iconUrl, sizes: "any", type: branding.iconType ?? "image/png" },
    ];
  }

  return `${JSON.stringify(manifest, null, 2)}\n`;
}
