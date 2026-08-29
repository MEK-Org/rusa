import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyBrandingToHtml,
  applyBrandingToManifest,
  type DashboardBranding,
  formatBrandName,
  hasBranding,
  resolveDashboardBranding,
} from "./branding.js";

/** A PNG-signed buffer — `rootBrandingImage` sniffs the signature for the type. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png-payload"),
]);

/** A JPEG-signed buffer, to pin the `.jpg` branch of the icon URL. */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from("fake-jpeg-payload"),
]);

/** The shape `flutter build web` emits, after the build script's rewrite. */
const BUILT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <base href="/">
  <meta charset="UTF-8">
  <meta name="description" content="Rusa actor mesh dashboard.">
  <meta name="theme-color" content="#38bdf8">
  <meta name="apple-mobile-web-app-title" content="Rusa">
  <link rel="apple-touch-icon" href="icons/Icon-192.png">
  <link rel="icon" type="image/svg+xml" href="favicon.svg"/>
  <link rel="icon" type="image/png" href="favicon.png"/>
  <title>Rusa</title>
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
`;

const BUILT_MANIFEST = JSON.stringify(
  {
    name: "Rusa",
    short_name: "Rusa",
    start_url: ".",
    display: "standalone",
    theme_color: "#38bdf8",
    icons: [
      { src: "icons/Icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "icons/Icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  null,
  2
);

describe("formatBrandName", () => {
  it("turns an adjective-animal handle into an app name", () => {
    expect(formatBrandName("ember-familiar")).toBe("Ember Familiar");
    expect(formatBrandName("misty-dik-dik")).toBe("Misty Dik Dik");
  });

  it("leaves a handle that is already a name alone", () => {
    expect(formatBrandName("Ember")).toBe("Ember");
  });

  it("ignores empty segments from stray separators", () => {
    expect(formatBrandName("ember--familiar")).toBe("Ember Familiar");
    expect(formatBrandName("ember_familiar")).toBe("Ember Familiar");
  });
});

describe("resolveDashboardBranding", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-branding-"));
    prevHome = process.env.RUSA_HOME;
    process.env.RUSA_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RUSA_HOME;
    else process.env.RUSA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Write an image to the root's avatar cache slot, as an upload would. */
  function cacheRootAvatar(bytes: Buffer): void {
    mkdirSync(join(home, "avatars"), { recursive: true });
    writeFileSync(join(home, "avatars", "root.png"), bytes);
  }

  it("brands nothing when no root identity is wired", () => {
    const branding = resolveDashboardBranding();
    expect(branding).toEqual({ name: null, iconUrl: null, iconType: null });
    expect(hasBranding(branding)).toBe(false);
  });

  it("treats the default root-actor handle as 'no name configured'", () => {
    // `resolveRootHandle` returns `root-actor` when `rootActor.handle` is unset,
    // so an unconfigured instance must keep the built-in "Rusa" branding.
    expect(resolveDashboardBranding({ handle: "root-actor" }).name).toBeNull();
  });

  it("names the page after a configured root handle", () => {
    const branding = resolveDashboardBranding({ handle: "ember-familiar" });
    expect(branding.name).toBe("Ember Familiar");
    expect(branding.iconUrl).toBeNull();
    expect(hasBranding(branding)).toBe(true);
  });

  it("keeps the bundled icons when the root still shows the bundled default", () => {
    // Nothing uploaded and no `rootActor.avatar`: the only image available is the
    // generic bundled one, which is not this root's face.
    expect(resolveDashboardBranding({ handle: "ember-familiar" }).iconUrl).toBeNull();
  });

  it("points the icon at the uploaded root image, cache-busted", () => {
    cacheRootAvatar(PNG_BYTES);
    const branding = resolveDashboardBranding({ handle: "ember-familiar" });
    expect(branding.iconType).toBe("image/png");
    expect(branding.iconUrl).toMatch(/^\/api\/mesh\/avatar\/root\.png\?v=[^&]+$/);
  });

  it("re-stamps the icon URL when the image is replaced", () => {
    cacheRootAvatar(PNG_BYTES);
    const first = resolveDashboardBranding({ handle: "ember-familiar" }).iconUrl;
    cacheRootAvatar(Buffer.concat([PNG_BYTES, Buffer.from("-longer")]));
    expect(resolveDashboardBranding({ handle: "ember-familiar" }).iconUrl).not.toBe(first);
  });

  it("uses the .jpg route suffix for a JPEG root image", () => {
    cacheRootAvatar(JPEG_BYTES);
    const branding = resolveDashboardBranding({ handle: "ember-familiar" });
    expect(branding.iconType).toBe("image/jpeg");
    expect(branding.iconUrl).toContain("/api/mesh/avatar/root.jpg?v=");
  });

  it("uses a configured rootActor.avatar when nothing has been uploaded", () => {
    const configured = join(home, "custom-root.png");
    writeFileSync(configured, PNG_BYTES);
    const branding = resolveDashboardBranding({ avatarPath: configured });
    expect(branding.iconUrl).toContain("/api/mesh/avatar/root.png?v=");
    // Image without a name: the built-in "Rusa" name stays.
    expect(branding.name).toBeNull();
  });

  it("ignores a rootActor.avatar path that does not exist", () => {
    expect(resolveDashboardBranding({ avatarPath: join(home, "missing.png") }).iconUrl).toBeNull();
  });
});

describe("applyBrandingToHtml", () => {
  const named: DashboardBranding = { name: "Ember Familiar", iconUrl: null, iconType: null };
  const iconed: DashboardBranding = {
    name: null,
    iconUrl: "/api/mesh/avatar/root.png?v=7-16",
    iconType: "image/png",
  };

  it("leaves the shell untouched when nothing is branded", () => {
    const unbranded: DashboardBranding = { name: null, iconUrl: null, iconType: null };
    expect(applyBrandingToHtml(BUILT_INDEX_HTML, unbranded)).toBe(BUILT_INDEX_HTML);
  });

  it("retitles the page and the iOS home-screen label", () => {
    const html = applyBrandingToHtml(BUILT_INDEX_HTML, named);
    expect(html).toContain("<title>Ember Familiar</title>");
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Ember Familiar">');
    expect(html).not.toContain("<title>Rusa</title>");
  });

  it("escapes a name that would otherwise break out of the markup", () => {
    const html = applyBrandingToHtml(BUILT_INDEX_HTML, {
      ...named,
      name: '<script>"x"',
    });
    expect(html).toContain("<title>&lt;script&gt;&quot;x&quot;</title>");
    expect(html).not.toContain('<script>"x"</title>');
  });

  it("replaces every icon link, including the SVG that would outrank the PNG", () => {
    const html = applyBrandingToHtml(BUILT_INDEX_HTML, iconed);
    expect(html).not.toContain("favicon.svg");
    expect(html).not.toContain("favicon.png");
    expect(html).not.toContain("icons/Icon-192.png");
    expect(html).toContain(
      '<link rel="icon" type="image/png" href="/api/mesh/avatar/root.png?v=7-16"/>'
    );
    expect(html).toContain('<link rel="apple-touch-icon" href="/api/mesh/avatar/root.png?v=7-16">');
    // The manifest link is not an icon link and must survive.
    expect(html).toContain('<link rel="manifest" href="manifest.json">');
  });

  it("keeps the bundled icons when the shell has no head to re-anchor them to", () => {
    const headless = '<link rel="icon" type="image/png" href="favicon.png"/>';
    expect(applyBrandingToHtml(headless, iconed)).toBe(headless);
  });

  it("is a no-op for tags a future Flutter shell no longer emits", () => {
    const minimal = "<html><head></head><body></body></html>";
    expect(applyBrandingToHtml(minimal, named)).toBe(minimal);
  });
});

describe("applyBrandingToManifest", () => {
  it("returns the manifest untouched when nothing is branded", () => {
    const unbranded: DashboardBranding = { name: null, iconUrl: null, iconType: null };
    expect(applyBrandingToManifest(BUILT_MANIFEST, unbranded)).toBe(BUILT_MANIFEST);
  });

  it("renames the installed app", () => {
    const manifest = JSON.parse(
      applyBrandingToManifest(BUILT_MANIFEST, {
        name: "Ember Familiar",
        iconUrl: null,
        iconType: null,
      })
    );
    expect(manifest.name).toBe("Ember Familiar");
    expect(manifest.short_name).toBe("Ember Familiar");
    // Untouched fields survive the round trip.
    expect(manifest.theme_color).toBe("#38bdf8");
    expect(manifest.icons).toHaveLength(2);
  });

  it("replaces the bundled icons with the root image alone", () => {
    const manifest = JSON.parse(
      applyBrandingToManifest(BUILT_MANIFEST, {
        name: null,
        iconUrl: "/api/mesh/avatar/root.png?v=7-16",
        iconType: "image/png",
      })
    );
    // Left alongside the bundled entries, a browser matching on declared size
    // would still install the generic mark.
    expect(manifest.icons).toEqual([
      { src: "/api/mesh/avatar/root.png?v=7-16", sizes: "any", type: "image/png" },
    ]);
    expect(manifest.name).toBe("Rusa");
  });

  it("passes through a manifest it cannot parse", () => {
    const broken = "{not json";
    expect(applyBrandingToManifest(broken, { name: "Ember", iconUrl: null, iconType: null })).toBe(
      broken
    );
  });
});
