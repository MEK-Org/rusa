import { describe, expect, it } from "vitest";
import { buildSupportedVoiceCatalog, parseVoiceDefinitions } from "./voice-catalog.js";
import { googleVoiceConfig } from "./voice-config.js";

describe("shared voice catalog", () => {
  it("combines providers, overrides labels, and keeps provider identity distinct", () => {
    const configured = parseVoiceDefinitions([
      { label: "Custom Puck", voiceConfig: googleVoiceConfig("puck") },
      {
        label: "Christopher",
        voiceConfig: { schemaVersion: 1, provider: "elevenlabs", config: { voiceId: "Puck" } },
      },
    ]);
    const catalog = buildSupportedVoiceCatalog(configured);
    expect(catalog.filter((v) => v.voiceConfig.provider === "google")).toHaveLength(30);
    expect(catalog).toContainEqual({
      label: "Custom Puck",
      providerLabel: "Gemini",
      voiceConfig: googleVoiceConfig("Puck"),
    });
    expect(catalog).toContainEqual({ ...configured[1], providerLabel: "ElevenLabs" });
  });

  it("filters the catalog to available providers when specified", () => {
    const configured = parseVoiceDefinitions([
      { label: "Custom Puck", voiceConfig: googleVoiceConfig("puck") },
      {
        label: "Christopher",
        voiceConfig: { schemaVersion: 1, provider: "elevenlabs", config: { voiceId: "Puck" } },
      },
    ]);
    const elevenlabsOnly = buildSupportedVoiceCatalog(configured, {
      availableProviders: ["elevenlabs"],
    });
    expect(elevenlabsOnly).toEqual([{ ...configured[1], providerLabel: "ElevenLabs" }]);

    const googleOnly = buildSupportedVoiceCatalog(configured, {
      availableProviders: ["google"],
    });
    expect(googleOnly.filter((v) => v.voiceConfig.provider === "google")).toHaveLength(30);
    expect(googleOnly.some((v) => v.voiceConfig.provider === "elevenlabs")).toBe(false);
  });

  it("rejects duplicate normalized documents and unsupported Google voices", () => {
    expect(() =>
      parseVoiceDefinitions([
        { label: "One", voiceConfig: googleVoiceConfig("Puck") },
        { label: "Two", voiceConfig: googleVoiceConfig("puck") },
      ])
    ).toThrow(/duplicate/);
    expect(() =>
      parseVoiceDefinitions([{ label: "Unknown", voiceConfig: googleVoiceConfig("Unknown") }])
    ).toThrow(/supported/);
  });
});
