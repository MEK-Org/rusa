import { describe, expect, it } from "vitest";
import { CONFIG_DOCS } from "./config-docs.js";

describe("config docs", () => {
  it("documents required config sections and invocation debug defaults", () => {
    expect(CONFIG_DOCS).toContain("github:");
    expect(CONFIG_DOCS).toContain("providers:");
    expect(CONFIG_DOCS).toContain("webhook:");
    expect(CONFIG_DOCS).toContain("invocationDebug:");
    expect(CONFIG_DOCS).toContain("retentionDays");
    expect(CONFIG_DOCS).toContain("maxBytesPerInvocation");
    expect(CONFIG_DOCS).toContain("209715200");
  });

  it("documents the configured root identity fields ", () => {
    expect(CONFIG_DOCS).toContain("rootActor:");
    expect(CONFIG_DOCS).toContain("handle");
    expect(CONFIG_DOCS).toContain("ember-familiar");
  });

  it("documents the application log level and where to read the log", () => {
    expect(CONFIG_DOCS).toContain("observability.logging:");
    expect(CONFIG_DOCS).toContain("RUSA_LOG_LEVEL");
    expect(CONFIG_DOCS).toContain("debug, info (default), warn, error, or silent");
    expect(CONFIG_DOCS).toContain("docs/logging.md");
  });

  it("documents how an interactive run stays readable", () => {
    expect(CONFIG_DOCS).toContain("RUSA_LOG_FORMAT");
    expect(CONFIG_DOCS).toContain("auto is pretty when stdout is a terminal");
  });

  it("documents the quickstart profile", () => {
    expect(CONFIG_DOCS).toContain("profile: quickstart");
    expect(CONFIG_DOCS).toContain("local git bridge delivery");
  });

  it("documents shared quota persistence and pacing", () => {
    expect(CONFIG_DOCS).toContain("quota:");
    expect(CONFIG_DOCS).toContain("databasePath");
    expect(CONFIG_DOCS).not.toContain("poolId");
    expect(CONFIG_DOCS).toContain("quota.throttle:");
    expect(CONFIG_DOCS).not.toContain("mesh.quotaThrottle:");
  });

  it("documents disk-alert routing as implicit instead of a separate config knob", () => {
    expect(CONFIG_DOCS).toContain(
      "Configuring this section implicitly subscribes root to responsive system.disk events"
    );
    expect(CONFIG_DOCS).not.toContain("kind: system");
  });

  it("documents understanding.glassGoals and legacy glassGoals section ", () => {
    expect(CONFIG_DOCS).toContain("understanding.glassGoals:");
    expect(CONFIG_DOCS).toContain("glassGoals:");
    expect(CONFIG_DOCS).toContain("Legacy top-level Integrated Understanding storage section");
  });

  it("documents chat and multi-instance staging recipe", () => {
    expect(CONFIG_DOCS).toContain("chat:");
    expect(CONFIG_DOCS).not.toContain("eventSources:");
    expect(CONFIG_DOCS).toContain("excludedSpaces");
    expect(CONFIG_DOCS).toContain("Multi-instance staging recipe:");
    expect(CONFIG_DOCS).toContain("spaces/AAAA_STAGING");
  });
});
