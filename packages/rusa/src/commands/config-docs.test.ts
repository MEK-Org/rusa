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

  it("documents the quickstart profile", () => {
    expect(CONFIG_DOCS).toContain("profile: quickstart");
    expect(CONFIG_DOCS).toContain("local git bridge delivery");
  });

  it("documents disk-alert routing as implicit instead of a system eventSources knob", () => {
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

  it("documents chat, eventSources, and multi-instance staging recipe ", () => {
    expect(CONFIG_DOCS).toContain("chat:");
    expect(CONFIG_DOCS).toContain("eventSources:");
    expect(CONFIG_DOCS).toContain("chat_space");
    expect(CONFIG_DOCS).toContain("excludedSpaces");
    expect(CONFIG_DOCS).toContain("Multi-instance staging recipe:");
    expect(CONFIG_DOCS).toContain("spaces/AAAA_STAGING");
  });
});
