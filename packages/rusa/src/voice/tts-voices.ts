/**
 * The supported prebuilt Gemini TTS voices. The walkie-talkie reply path renders
 * with one `SpeechClient` whose instance-wide default comes from config; this
 * catalog is the authoritative list an actor's persisted voice may name. Kept
 * in one module so the spawn-time randomizer, the dashboard API validation,
 * and the UI dropdown all read the same source.
 *
 * The catalog is the 30 prebuilt voices documented for the Gemini TTS preview
 * models (`gemini-2.5-flash-preview-tts` family and the newer
 * `gemini-3.1-flash-tts-preview` this build defaults to). Voice names are
 * case-insensitive on the wire; this list stores the documented casing and
 * membership tests normalize.
 */

export const SUPPORTED_TTS_VOICES = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zubenelgenubi",
  "Zephyr",
] as const;

const SUPPORTED_TTS_VOICE_BY_NORMALIZED_NAME = new Map<string, string>(
  SUPPORTED_TTS_VOICES.map((voice) => [voice.toLowerCase(), voice])
);

/**
 * Resolve a supplied wire name to its documented spelling, or return
 * undefined when it is not in the supported prebuilt-voice catalog. Keeping
 * the persisted document canonical means its name can always be selected by
 * the dashboard dropdown (whose values use the documented spellings).
 */
export function canonicalSupportedVoiceName(name: string): string | undefined {
  return SUPPORTED_TTS_VOICE_BY_NORMALIZED_NAME.get(name.trim().toLowerCase());
}

/** True when `name` names one of the supported prebuilt Gemini TTS voices. */
export function isSupportedVoiceName(name: string): boolean {
  return canonicalSupportedVoiceName(name) !== undefined;
}

/**
 * Random supported voice for a newly spawned actor. Injectable `rng` (in
 * [0, 1)) keeps tests deterministic; production uses Math.random, which is
 * fine here — a voice pick carries no security stake.
 */
export function randomSupportedVoiceName(rng: () => number = Math.random): string {
  const index = Math.floor(rng() * SUPPORTED_TTS_VOICES.length);
  const clamped = Math.min(SUPPORTED_TTS_VOICES.length - 1, Math.max(0, index));
  return SUPPORTED_TTS_VOICES[clamped];
}
