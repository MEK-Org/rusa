import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import { CONFIGURED_ACTOR_IMPORT_SOURCE } from "../db/configured-actor-import.js";
import { closeDb, initDb } from "../db/index.js";
import {
  type AndroidBranding,
  deriveAndroidApplicationId,
  escapeAndroidString,
  formatAndroidBuildReceipt,
  LEGACY_ANDROID_APPLICATION_ID,
  resolveAndroidBranding,
  writeAndroidBrandingResources,
} from "./android-branding.js";

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("fake-jpeg")]);
const FLUTTER_APP_DIR = "/app";

describe("Android application id", () => {
  it("derives com.<handle with non-[A-Za-z0-9_] stripped>.dashboard", () => {
    expect(deriveAndroidApplicationId("silicon-familiar")).toBe("com.siliconfamiliar.dashboard");
    expect(deriveAndroidApplicationId("Ember_Familiar")).toBe("com.Ember_Familiar.dashboard");
  });

  it("fails loudly when the stripped handle is not a legal segment", () => {
    expect(() => deriveAndroidApplicationId("---")).toThrow(
      /root handle "---".*"" must start with a letter/
    );
    expect(() => deriveAndroidApplicationId("9-lives")).toThrow(
      /"9lives" must start with a letter/
    );
  });
});

describe("resolveAndroidBranding", () => {
  let home: string;
  let originalHome: string | undefined;

  function writeConfig(overrides: Record<string, unknown> = {}): void {
    writeFileSync(
      join(home, "config.yaml"),
      toYaml({
        github: { account: "CodeChopsBot" },
        providers: { codex: { cliCommand: "codex" } },
        ...overrides,
      })
    );
  }

  function seedFixtureDb(opts: {
    receiptActorId?: string;
    actor?: { id: string; displayHandle?: string; parentId?: string | null };
  }): void {
    mkdirSync(join(home, "data"), { recursive: true });
    const db = initDb(home);
    const now = new Date().toISOString();
    if (opts.actor) {
      const execConfig = JSON.stringify({ schemaVersion: 1, unsandboxed: false });
      db.prepare(
        `INSERT INTO actors (id, charter, parent_id, created_at, execution_config, display_handle)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        opts.actor.id,
        "charter",
        opts.actor.parentId ?? null,
        now,
        execConfig,
        opts.actor.displayHandle ?? null
      );
    }
    if (opts.receiptActorId !== undefined) {
      db.prepare(
        `INSERT INTO legacy_import_receipts (source, imported_at, row_count, actor_id)
         VALUES (?, ?, ?, ?)`
      ).run(CONFIGURED_ACTOR_IMPORT_SOURCE, now, 1, opts.receiptActorId);
    }
    closeDb();
  }

  beforeEach(() => {
    originalHome = process.env.RUSA_HOME;
    home = mkdtempSync(join(tmpdir(), "rusa-android-branding-"));
    process.env.RUSA_HOME = home;
  });

  afterEach(() => {
    closeDb();
    if (originalHome === undefined) delete process.env.RUSA_HOME;
    else process.env.RUSA_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("names the app after the imported root handle and derives its id from it", () => {
    writeConfig();
    seedFixtureDb({
      receiptActorId: "actor-sf",
      actor: { id: "actor-sf", displayHandle: "silicon-familiar", parentId: null },
    });

    expect(resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR, home })).toEqual({
      label: "Silicon Familiar",
      labelSource: 'imported root handle "silicon-familiar"',
      applicationId: "com.siliconfamiliar.dashboard",
      applicationIdSource: "derived from imported root handle",
      iconPath: resolve(FLUTTER_APP_DIR, "web/icons/prod/Icon-maskable-512.png"),
      iconType: "image/png",
      iconSource: "bundled prod dashboard icon",
    });
  });

  it("keeps the built-in name, id and instance icon when no root handle is configured", () => {
    writeConfig();

    const branding = resolveAndroidBranding({
      flutterAppDir: FLUTTER_APP_DIR,
      instance: "staging",
      home,
    });
    expect(branding.label).toBe("Rusa Staging");
    expect(branding.applicationId).toBe("org.mek.rusa.dashboard");
    expect(branding.iconPath).toBe(
      resolve(FLUTTER_APP_DIR, "web/icons/staging/Icon-maskable-512.png")
    );
  });

  it("treats the default root-actor handle as unbranded for both label and id", () => {
    writeConfig();
    seedFixtureDb({
      receiptActorId: "actor-root",
      actor: { id: "actor-root", displayHandle: "root-actor", parentId: null },
    });

    const branding = resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR, home });
    expect(branding.label).toBe("Rusa");
    expect(branding.labelSource).toBe("built-in prod name");
    expect(branding.applicationId).toBe(LEGACY_ANDROID_APPLICATION_ID);
    expect(branding.applicationIdSource).toBe("built-in default (no root handle)");
  });

  it("uses the uploaded root image, typed by its signature", () => {
    writeConfig();
    mkdirSync(join(home, "avatars"));
    writeFileSync(join(home, "avatars", "root.png"), JPEG_BYTES);

    const branding = resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR, home });
    expect(branding.iconPath).toBe(join(home, "avatars", "root.png"));
    expect(branding.iconType).toBe("image/jpeg");
    expect(branding.iconSource).toBe("root image");
  });

  it("fails the build loudly on a handle with no legal derived id", () => {
    writeConfig();
    seedFixtureDb({
      receiptActorId: "actor-bad",
      actor: { id: "actor-bad", displayHandle: "9-lives", parentId: null },
    });

    expect(() => resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR, home })).toThrow(
      /root handle "9-lives" does not yield a legal Android application id \(com\.9lives\.dashboard\)/
    );
  });

  it("produces byte-identical applicationId, label, and launcher icon for an imported installation from a fixture database (#1261 acceptance)", () => {
    writeConfig();
    mkdirSync(join(home, "data"), { recursive: true });
    mkdirSync(join(home, "avatars"), { recursive: true });
    writeFileSync(join(home, "avatars", "root.png"), JPEG_BYTES);

    const db = initDb(home);
    const now = new Date().toISOString();
    const execConfig = JSON.stringify({ schemaVersion: 1, unsandboxed: false });
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, created_at, execution_config, display_handle)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("actor-sf", "charter", null, now, execConfig, "silicon-familiar");
    db.prepare(
      `INSERT INTO legacy_import_receipts (source, imported_at, row_count, actor_id)
       VALUES (?, ?, ?, ?)`
    ).run(CONFIGURED_ACTOR_IMPORT_SOURCE, now, 1, "actor-sf");

    const branding = resolveAndroidBranding({
      flutterAppDir: FLUTTER_APP_DIR,
      home,
    });

    expect(branding).toEqual({
      label: "Silicon Familiar",
      labelSource: 'imported root handle "silicon-familiar"',
      applicationId: "com.siliconfamiliar.dashboard",
      applicationIdSource: "derived from imported root handle",
      iconPath: join(home, "avatars", "root.png"),
      iconType: "image/jpeg",
      iconSource: "root image",
    });

    const resDir = join(home, "res");
    writeAndroidBrandingResources(branding, resDir);
    expect(readFileSync(join(resDir, "drawable-nodpi", "rusa_launcher_image.jpg"))).toEqual(
      JPEG_BYTES
    );
    expect(readFileSync(join(resDir, "values", "rusa_branding.xml"), "utf8")).toContain(
      '<string name="rusa_app_label">Silicon Familiar</string>'
    );
  });
});

describe("Android branding resources", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rusa-android-res-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const branding = (overrides: Partial<AndroidBranding> = {}): AndroidBranding => ({
    label: "Silicon Familiar",
    labelSource: 'imported root handle "silicon-familiar"',
    applicationId: "com.siliconfamiliar.dashboard",
    applicationIdSource: "derived from imported root handle",
    iconPath: join(dir, "source.img"),
    iconType: "image/jpeg",
    iconSource: "root image",
    ...overrides,
  });

  it("escapes labels for a string resource", () => {
    expect(escapeAndroidString(`Kit's <"A&B">`)).toBe(`Kit\\'s &lt;\\"A&amp;B\\"&gt;`);
    expect(escapeAndroidString("@home")).toBe("\\@home");
  });

  it("writes rusa_* label and adaptive icon resources from the source image", () => {
    writeFileSync(join(dir, "source.img"), JPEG_BYTES);
    const resDir = join(dir, "res");
    mkdirSync(join(resDir, "stale"), { recursive: true });

    writeAndroidBrandingResources(branding(), resDir);

    expect(existsSync(join(resDir, "stale"))).toBe(false);
    expect(readFileSync(join(resDir, "drawable-nodpi", "rusa_launcher_image.jpg"))).toEqual(
      JPEG_BYTES
    );
    expect(readFileSync(join(resDir, "values", "rusa_branding.xml"), "utf8")).toContain(
      '<string name="rusa_app_label">Silicon Familiar</string>'
    );
    const icon = readFileSync(join(resDir, "mipmap-anydpi-v26", "rusa_launcher.xml"), "utf8");
    expect(icon).toContain("<adaptive-icon");
    expect(icon).toContain('android:drawable="@drawable/rusa_launcher_image"');
  });

  it("receipts the resolution, and the reinstall note only for a new id", () => {
    const receipt = formatAndroidBuildReceipt(branding(), "/out/flutter-apk");
    expect(receipt).toContain("label:          Silicon Familiar");
    expect(receipt).toContain("application id: com.siliconfamiliar.dashboard");
    expect(receipt).toContain("apk output:     /out/flutter-apk");
    expect(receipt).toMatch(/uninstall that one by hand/);
    expect(receipt).toMatch(/registered in Firebase for com\.siliconfamiliar\.dashboard/);

    const unchanged = formatAndroidBuildReceipt(
      branding({ applicationId: "org.mek.rusa.dashboard" })
    );
    expect(unchanged).not.toMatch(/uninstall/);
  });
});
