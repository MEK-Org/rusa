import { describe, expect, it } from "vitest";
import {
  buildSupportedVoiceCatalog,
  filterConfiguredVoices,
  parseVoiceDefinitions,
  resolveVoiceChoice,
  voiceChoiceText,
} from "./voice-catalog.js";
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

    expect(filterConfiguredVoices(configured, { availableProviders: ["elevenlabs"] })).toEqual([
      configured[1],
    ]);
    expect(filterConfiguredVoices(configured, { availableProviders: ["google"] })).toEqual([
      configured[0],
    ]);
    expect(filterConfiguredVoices(undefined)).toBeUndefined();
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

  describe("resolving a spoken or typed voice choice (#817)", () => {
    const configured = parseVoiceDefinitions([
      { label: "Custom Puck", voiceConfig: googleVoiceConfig("puck") },
      {
        label: "Christopher",
        voiceConfig: { schemaVersion: 1, provider: "elevenlabs", config: { voiceId: "Puck" } },
      },
    ]);
    const catalog = buildSupportedVoiceCatalog(configured, {
      availableProviders: ["google", "elevenlabs"],
    });
    const configOf = (choice: string) => {
      const result = resolveVoiceChoice(catalog, choice);
      return result.ok ? result.voice.voiceConfig : result.error;
    };

    it("resolves labels, picker labels, canonical Google names and voice ids", () => {
      const christopher = configured[1].voiceConfig;
      expect(configOf("Christopher")).toEqual(christopher);
      expect(configOf("  christopher (elevenlabs) ")).toEqual(christopher);
      expect(configOf("custom puck")).toEqual(googleVoiceConfig("Puck"));
      expect(configOf("Custom Puck (Gemini)")).toEqual(googleVoiceConfig("Puck"));
      expect(configOf("kore")).toEqual(googleVoiceConfig("Kore"));
    });

    it("rejects an ambiguous choice and names only the candidates", () => {
      // The Google name Puck and the ElevenLabs voice id Puck are different voices.
      const result = resolveVoiceChoice(catalog, "Puck");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/ambiguous/);
      expect(result.error).toContain("Custom Puck (Gemini)");
      expect(result.error).toContain("Christopher (ElevenLabs)");
      expect(result.error).not.toContain("Kore");
      // ElevenLabs ids are case-sensitive; Google names are not.
      expect(configOf("puck")).toEqual(googleVoiceConfig("Puck"));
    });

    it("offers each entry choice text that resolves to it, qualifying a shared label", () => {
      // Two configurations may share a label. One id also collides with a Google name.
      const eleven = (voiceId: string) =>
        ({ schemaVersion: 1, provider: "elevenlabs", config: { voiceId } }) as const;
      const twins = buildSupportedVoiceCatalog(
        parseVoiceDefinitions([
          { label: "Alex", voiceConfig: eleven("Puck") },
          { label: "Alex", voiceConfig: eleven("alex-2") },
        ]),
        { availableProviders: ["google", "elevenlabs"] }
      );
      const texts = twins.map((voice) => voiceChoiceText(twins, voice));
      expect(texts).toContain("Alex (ElevenLabs, Puck)");
      expect(texts).toContain("Alex (ElevenLabs, alex-2)");
      expect(texts).toContain("Puck (Gemini)");
      for (const voice of twins) {
        expect(resolveVoiceChoice(twins, voiceChoiceText(twins, voice))).toEqual({
          ok: true,
          voice,
        });
      }
      expect(resolveVoiceChoice(twins, "Alex (ElevenLabs)")).toEqual({
        ok: false,
        error:
          "voice 'Alex (ElevenLabs)' is ambiguous; choose one of: Alex (ElevenLabs, Puck), Alex (ElevenLabs, alex-2)",
      });
    });

    it("rejects unknown and credential-unavailable choices with the valid choices", () => {
      const unknown = resolveVoiceChoice(catalog, "Nobody");
      expect(unknown).toMatchObject({ ok: false });
      if (!unknown.ok) {
        expect(unknown.error).toMatch(/not an available voice/);
        expect(unknown.error).toContain("Kore (Gemini)");
        expect(unknown.error).toContain("Christopher (ElevenLabs)");
      }
      const googleOnly = buildSupportedVoiceCatalog(configured, { availableProviders: ["google"] });
      expect(resolveVoiceChoice(googleOnly, "Christopher").ok).toBe(false);
      const elevenlabsOnly = buildSupportedVoiceCatalog(configured, {
        availableProviders: ["elevenlabs"],
      });
      const kore = resolveVoiceChoice(elevenlabsOnly, "Kore");
      expect(kore).toEqual({
        ok: false,
        error: "voice 'Kore' is not an available voice; choose one of: Christopher (ElevenLabs)",
      });
    });
  });
});
