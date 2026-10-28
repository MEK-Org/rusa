import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import {
  androidApplicationIdProblem,
  deriveAndroidApplicationId,
} from "./android-application-id.js";
import {
  type AndroidBranding,
  escapeAndroidString,
  formatAndroidBuildReceipt,
  resolveAndroidBranding,
  writeAndroidBrandingResources,
} from "./android-branding.js";

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("fake-jpeg")]);
const FLUTTER_APP_DIR = "/app";

describe("Android application id", () => {
  it("accepts legal package names", () => {
    for (const id of ["com.siliconfamiliar.dashboard", "org.mek.rusa.dashboard", "a.b", "A1.b_2"]) {
      expect(androidApplicationIdProblem(id)).toBeNull();
    }
  });

  it("rejects illegal package names with a reason", () => {
    expect(androidApplicationIdProblem("dashboard")).toMatch(/two dot-separated segments/);
    expect(androidApplicationIdProblem("com.9lives.app")).toMatch(/start with a letter/);
    expect(androidApplicationIdProblem("com.silicon-familiar.app")).toMatch(/only letters/);
    expect(androidApplicationIdProblem("com..app")).toMatch(/segment ""/);
    expect(androidApplicationIdProblem("com.new.app")).toMatch(/Java reserved word/);
  });

  it("derives com.<handle with non-[A-Za-z0-9_] stripped>.dashboard", () => {
    expect(deriveAndroidApplicationId("silicon-familiar")).toBe("com.siliconfamiliar.dashboard");
    expect(deriveAndroidApplicationId("Ember_Familiar")).toBe("com.Ember_Familiar.dashboard");
  });

  it("fails loudly when the stripped handle is not a legal segment", () => {
    expect(() => deriveAndroidApplicationId("---")).toThrow(/rootActor.handle "---".*segment ""/);
    expect(() => deriveAndroidApplicationId("9-lives")).toThrow(/start with a letter/);
    expect(() => deriveAndroidApplicationId("new")).toThrow(/Java reserved word/);
  });
});

describe("resolveAndroidBranding", () => {
  let home: string;
  let originalHome: string | undefined;

  function writeConfig(overrides: Record<string, unknown> = {}): void {
    const { rootActor, ...rest } = overrides;
    writeFileSync(
      join(home, "config.yaml"),
      toYaml({
        github: { account: "CodeChopsBot" },
        providers: { codex: { cliCommand: "codex" } },
        rootActor: { provider: "codex", model: "gpt-5.6-sol", ...(rootActor as object) },
        ...rest,
      })
    );
  }

  beforeEach(() => {
    originalHome = process.env.RUSA_HOME;
    home = mkdtempSync(join(tmpdir(), "rusa-android-branding-"));
    process.env.RUSA_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.RUSA_HOME;
    else process.env.RUSA_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("names the app after the root handle and derives its id from it", () => {
    writeConfig({ rootActor: { handle: "silicon-familiar" } });

    expect(resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR })).toEqual({
      label: "Silicon Familiar",
      labelSource: 'rootActor.handle "silicon-familiar"',
      applicationId: "com.siliconfamiliar.dashboard",
      applicationIdSource: "derived from rootActor.handle",
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
    });
    expect(branding.label).toBe("Rusa Staging");
    expect(branding.applicationId).toBe("org.mek.rusa.dashboard");
    expect(branding.iconPath).toBe(
      resolve(FLUTTER_APP_DIR, "web/icons/staging/Icon-maskable-512.png")
    );
  });

  it("uses the uploaded root image, typed by its signature", () => {
    writeConfig({ rootActor: { handle: "silicon-familiar" } });
    mkdirSync(join(home, "avatars"));
    writeFileSync(join(home, "avatars", "root.png"), JPEG_BYTES);

    const branding = resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR });
    expect(branding.iconPath).toBe(join(home, "avatars", "root.png"));
    expect(branding.iconType).toBe("image/jpeg");
    expect(branding.iconSource).toBe("root image");
  });

  it("fails the build loudly on a handle with no legal derived id", () => {
    writeConfig({ rootActor: { handle: "9-lives" } });

    expect(() => resolveAndroidBranding({ flutterAppDir: FLUTTER_APP_DIR })).toThrow(
      /rootActor\.handle "9-lives" does not yield a legal Android application id \(com\.9lives\.dashboard\)/
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
    labelSource: 'rootActor.handle "silicon-familiar"',
    applicationId: "com.siliconfamiliar.dashboard",
    applicationIdSource: "derived from rootActor.handle",
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

  it("receipts the resolution and the reinstall note for a new id", () => {
    const receipt = formatAndroidBuildReceipt(branding(), "/out/app-release.apk");
    expect(receipt).toContain("label:          Silicon Familiar");
    expect(receipt).toContain("application id: com.siliconfamiliar.dashboard");
    expect(receipt).toContain("apk:            /out/app-release.apk");
    expect(receipt).toMatch(/uninstall that one by hand/);
    expect(receipt).toMatch(/registered in Firebase for com\.siliconfamiliar\.dashboard/);
  });

  it("omits the reinstall note when the id is unchanged", () => {
    const receipt = formatAndroidBuildReceipt(
      branding({ applicationId: "org.mek.rusa.dashboard" })
    );
    expect(receipt).not.toMatch(/uninstall/);
  });
});
