import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_NAME } from "./gemini-speech.js";
import {
  canonicalSupportedVoiceName,
  isSupportedVoiceName,
  randomSupportedVoiceName,
  SUPPORTED_TTS_VOICES,
} from "./tts-voices.js";

describe("SUPPORTED_TTS_VOICES", () => {
  it("lists the documented prebuilt Gemini voices with no duplicates", () => {
    expect(SUPPORTED_TTS_VOICES.length).toBeGreaterThan(0);
    expect(new Set(SUPPORTED_TTS_VOICES).size).toBe(SUPPORTED_TTS_VOICES.length);
  });

  it("includes the instance-wide default voice", () => {
    expect(SUPPORTED_TTS_VOICES).toContain(DEFAULT_VOICE_NAME);
  });
});

describe("isSupportedVoiceName", () => {
  it("accepts every cataloged voice", () => {
    for (const voice of SUPPORTED_TTS_VOICES) {
      expect(isSupportedVoiceName(voice)).toBe(true);
    }
  });

  it("is case-insensitive like the wire API", () => {
    expect(isSupportedVoiceName("kore")).toBe(true);
    expect(isSupportedVoiceName(" KORE ")).toBe(true);
  });

  it("rejects unknown and empty names", () => {
    expect(isSupportedVoiceName("GLaDOS")).toBe(false);
    expect(isSupportedVoiceName("")).toBe(false);
    expect(isSupportedVoiceName("Laomedeia2")).toBe(false);
  });
});

describe("canonicalSupportedVoiceName", () => {
  it("uses the documented spelling for case-insensitive wire input", () => {
    expect(canonicalSupportedVoiceName(" kore ")).toBe("Kore");
    expect(canonicalSupportedVoiceName("not-a-voice")).toBeUndefined();
  });
});

describe("randomSupportedVoiceName", () => {
  it("always returns a cataloged voice across the rng range", () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999999, 1]) {
      const voice = randomSupportedVoiceName(() => r);
      expect(SUPPORTED_TTS_VOICES).toContain(voice);
    }
  });

  it("spreads picks across the catalog", () => {
    const picks = new Set(
      SUPPORTED_TTS_VOICES.map((_, i) =>
        randomSupportedVoiceName(() => (i + 0.5) / SUPPORTED_TTS_VOICES.length)
      )
    );
    expect(picks.size).toBe(SUPPORTED_TTS_VOICES.length);
  });
});
