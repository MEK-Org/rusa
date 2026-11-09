import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { generateHandle } from "../actor/handle-generator.js";
import { rootBrandingImage } from "../avatar/avatars.js";
import { resolveHome } from "../config/index.js";
import { resolveConfiguredActor } from "../db/configured-actor-import.js";
import { LegacyImportReceiptRepository } from "../db/repositories/legacy-import-receipt-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { resolveDashboardBranding } from "./branding.js";

/**
 * Android launcher branding for this instance (#1191).
 *
 * The web dashboard brands itself per request (see `branding.ts`), but an APK's
 * launcher label, launcher icon and application id are fixed when it is built.
 * So `pnpm --filter rusa run build:android` resolves the same identity the web
 * uses — the root handle names it, the root's own image is its icon, each half
 * falling back on its own to the built-in "Rusa" branding — writes it as a
 * generated Android resource directory, and hands Gradle that directory and
 * the application id.
 */
export interface AndroidBranding {
  label: string;
  labelSource: string;
  applicationId: string;
  applicationIdSource: string;
  /** Image file the launcher icon is generated from. */
  iconPath: string;
  /** Its sniffed type: aapt2 rejects a JPEG behind a `.png` name. */
  iconType: string;
  iconSource: string;
}

/** The id every build used before #1191; still the id of an unbranded build. */
export const LEGACY_ANDROID_APPLICATION_ID = "org.mek.rusa.dashboard";

/**
 * The application id for a root handle: `com.<handle>.dashboard` with every
 * character outside `[A-Za-z0-9_]` stripped, so `silicon-familiar` →
 * `com.siliconfamiliar.dashboard`. There is deliberately no config override.
 * Throws, naming the handle, when what remains is not a legal package segment
 * (empty or not starting with a letter): the build fails rather than guessing.
 */
export function deriveAndroidApplicationId(handle: string): string {
  const segment = handle.replace(/[^A-Za-z0-9_]/g, "");
  const id = `com.${segment}.dashboard`;
  if (!/^[A-Za-z]/.test(segment)) {
    throw new Error(
      `root handle "${handle}" does not yield a legal Android application id (${id}): ` +
        `"${segment}" must start with a letter`
    );
  }
  return id;
}

/** Built-in names per `RUSA_INSTANCE`, as `scripts/build-dashboard-ui.mjs` bakes them. */
const BUILT_IN_NAMES: Record<string, string> = { prod: "Rusa", staging: "Rusa Staging" };

/** Options for {@link resolveAndroidBranding}, which reads the durable root identity from `mesh.db` and any uploaded root image from `$RUSA_HOME`. */
export interface ResolveAndroidBrandingOptions {
  /** `RUSA_INSTANCE`, choosing the built-in name and bundled icon (default: prod). */
  instance?: string;
  /** The Flutter app whose bundled web icons are the fallback launcher image. */
  flutterAppDir: string;
  /** Explicit Rusa home directory override. */
  home?: string;
}

export function resolveAndroidBranding(options: ResolveAndroidBrandingOptions): AndroidBranding {
  const mcHome = options.home ?? resolveHome();
  const instance =
    options.instance && options.instance in BUILT_IN_NAMES ? options.instance : "prod";
  const dbPath = join(mcHome, "data", "mesh.db");

  let rootHandle: string | undefined;

  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const hasReceipts =
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_import_receipts'"
          )
          .get() !== undefined;
      const hasActors =
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actors'").get() !==
        undefined;
      if (hasReceipts && hasActors) {
        const receiptRepo = new LegacyImportReceiptRepository(db);
        const actorRepo = new SqliteActorRepository(db);
        const rootActor = resolveConfiguredActor({ receipts: receiptRepo, actors: actorRepo });
        rootHandle = rootActor?.displayHandle;
      }
    } finally {
      db.close();
    }
  }

  const rootIdentity = rootHandle ? { handle: rootHandle } : undefined;
  const { name } = resolveDashboardBranding(rootIdentity);
  const label = name ?? BUILT_IN_NAMES[instance];
  const labelSource =
    name === null ? `built-in ${instance} name` : `imported root handle "${rootHandle}"`;

  const isCustomHandle = Boolean(rootHandle && rootHandle !== generateHandle("root"));
  const applicationId =
    isCustomHandle && rootHandle
      ? deriveAndroidApplicationId(rootHandle)
      : LEGACY_ANDROID_APPLICATION_ID;
  const applicationIdSource = isCustomHandle
    ? "derived from imported root handle"
    : "built-in default (no root handle)";

  const image = rootBrandingImage(rootIdentity);
  const iconPath =
    image?.path ?? resolve(options.flutterAppDir, "web/icons", instance, "Icon-maskable-512.png");
  const iconType = image?.contentType ?? "image/png";
  const iconSource = image ? "root image" : `bundled ${instance} dashboard icon`;

  return {
    label,
    labelSource,
    applicationId,
    applicationIdSource,
    iconPath,
    iconType,
    iconSource,
  };
}

/** Escape a string for an Android `<string>` resource. */
export function escapeAndroidString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/^([@?])/, "\\$1");
}

/**
 * Write the generated resource directory Gradle adds to the app (`rusaBrandingRes`).
 *
 * Every resource is named `rusa_*` so it can never collide with the checked-in
 * scaffold resources it overrides through the manifest placeholders. The icon is
 * one adaptive icon (minSdk 29 is above the API 26 that introduced them) rather
 * than a raster per density: the launcher scales the source image itself. Its
 * foreground is inset so the whole image fills the 72dp visible viewport, the
 * same full-bleed treatment the web manifest asks for with `purpose: maskable`.
 */
export function writeAndroidBrandingResources(branding: AndroidBranding, resDir: string): void {
  rmSync(resDir, { recursive: true, force: true });
  const extension = branding.iconType === "image/jpeg" ? "jpg" : "png";
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(resDir, path)), { recursive: true });
    writeFileSync(join(resDir, path), content);
  };
  mkdirSync(join(resDir, "drawable-nodpi"), { recursive: true });
  copyFileSync(
    branding.iconPath,
    join(resDir, "drawable-nodpi", `rusa_launcher_image.${extension}`)
  );
  write(
    "values/rusa_branding.xml",
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n` +
      `    <string name="rusa_app_label">${escapeAndroidString(branding.label)}</string>\n` +
      `</resources>\n`
  );
  write(
    "mipmap-anydpi-v26/rusa_launcher.xml",
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n` +
      `    <background android:drawable="@android:color/black" />\n` +
      `    <foreground>\n` +
      `        <inset android:drawable="@drawable/rusa_launcher_image" android:inset="16.667%" />\n` +
      `    </foreground>\n` +
      `</adaptive-icon>\n`
  );
}

/** The build's receipt: what it resolved, and what changing the id costs. */
export function formatAndroidBuildReceipt(branding: AndroidBranding, outputDir?: string): string {
  const lines = [
    "Android dashboard branding",
    `  label:          ${branding.label} (${branding.labelSource})`,
    `  application id: ${branding.applicationId} (${branding.applicationIdSource})`,
    `  launcher icon:  ${branding.iconPath} (${branding.iconSource})`,
  ];
  if (outputDir) lines.push(`  apk output:     ${outputDir}`);
  if (branding.applicationId !== LEGACY_ANDROID_APPLICATION_ID) {
    lines.push(
      "",
      `Note: Android installs ${branding.applicationId} as a separate app from an earlier ` +
        `${LEGACY_ANDROID_APPLICATION_ID} build; uninstall that one by hand.`,
      `Native Google sign-in needs an Android app registered in Firebase for ${branding.applicationId} ` +
        "(with the signing key's SHA fingerprints), and that app's id as RUSA_FIREBASE_ANDROID_APP_ID."
    );
  }
  return `${lines.join("\n")}\n`;
}
