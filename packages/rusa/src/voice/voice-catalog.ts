import { z } from "zod";
import { canonicalSupportedVoiceName, SUPPORTED_TTS_VOICES } from "./tts-voices.js";
import { googleVoiceConfig, type VoiceConfigDocument, voiceConfigSchema } from "./voice-config.js";

/** Configured voice choices reuse the same document used by actors and synthesis. */
export const voiceDefinitionSchema = z
  .object({
    label: z.string().trim().min(1),
    voiceConfig: voiceConfigSchema,
  })
  .strict();
export type VoiceDefinition = z.infer<typeof voiceDefinitionSchema>;
export interface SupportedVoice extends VoiceDefinition {
  providerLabel: string;
}

const PROVIDER_LABELS: Record<VoiceConfigDocument["provider"], string> = {
  google: "Gemini",
  elevenlabs: "ElevenLabs",
};

/** Validate and canonicalize before duplicate detection or storing a configured pool. */
export function parseVoiceDefinitions(value: unknown): VoiceDefinition[] {
  const voices = z.array(voiceDefinitionSchema).parse(value);
  const seen = new Set<string>();
  for (const voice of voices) {
    if (voice.voiceConfig.provider === "google") {
      const name = canonicalSupportedVoiceName(voice.voiceConfig.config.voiceName);
      if (!name) throw new Error("Google voiceName must name a supported TTS voice");
      voice.voiceConfig = googleVoiceConfig(name);
    }
    const key = JSON.stringify(voice.voiceConfig);
    if (seen.has(key)) throw new Error("duplicate voice configuration");
    seen.add(key);
  }
  return voices;
}

/** Built-ins plus configured choices. A configured label overrides the built-in label. */
export function buildSupportedVoiceCatalog(
  configured: readonly VoiceDefinition[] = [],
  options?: {
    availableProviders?: readonly VoiceConfigDocument["provider"][];
  }
): SupportedVoice[] {
  const available = options?.availableProviders ? new Set(options.availableProviders) : null;
  const entries = new Map<string, SupportedVoice>();
  const builtins =
    available === null || available.has("google")
      ? SUPPORTED_TTS_VOICES.map((name) => ({
          label: name,
          voiceConfig: googleVoiceConfig(name),
        }))
      : [];
  for (const voice of [...builtins, ...configured]) {
    if (available !== null && !available.has(voice.voiceConfig.provider)) {
      continue;
    }
    entries.set(JSON.stringify(voice.voiceConfig), {
      ...voice,
      providerLabel: PROVIDER_LABELS[voice.voiceConfig.provider],
    });
  }
  return [...entries.values()];
}

/** Filter configured voice choices to those whose provider credentials are available. */
export function filterConfiguredVoices(
  configured: readonly VoiceDefinition[] | undefined,
  options?: {
    availableProviders?: readonly VoiceConfigDocument["provider"][];
  }
): VoiceDefinition[] | undefined {
  if (!configured) return undefined;
  if (!options?.availableProviders) return [...configured];
  const available = new Set(options.availableProviders);
  return configured.filter((v) => available.has(v.voiceConfig.provider));
}

/** The picker's display text for a catalog entry, e.g. "Puck (Gemini)". */
function voiceChoiceLabel(voice: SupportedVoice): string {
  return `${voice.label} (${voice.providerLabel})`;
}

/**
 * The picker text plus the provider's voice name, e.g. "Alex (ElevenLabs, abc123)".
 * An entry is its provider and voice name, so this text names exactly one entry.
 */
function qualifiedVoiceChoiceLabel(voice: SupportedVoice): string {
  const config = voice.voiceConfig;
  const name = config.provider === "google" ? config.config.voiceName : config.config.voiceId;
  return `${voice.label} (${voice.providerLabel}, ${name})`;
}

export type VoiceChoiceResolution =
  | { ok: true; voice: SupportedVoice }
  | { ok: false; error: string };

function matchVoiceChoice(catalog: readonly SupportedVoice[], choice: string): SupportedVoice[] {
  const wanted = choice.trim();
  const qualified = catalog.filter((voice) => qualifiedVoiceChoiceLabel(voice) === wanted);
  if (qualified.length === 1) return qualified;
  const folded = wanted.toLowerCase();
  const googleName = canonicalSupportedVoiceName(wanted);
  return catalog.filter(
    (voice) =>
      voice.label.toLowerCase() === folded ||
      voiceChoiceLabel(voice).toLowerCase() === folded ||
      (voice.voiceConfig.provider === "google"
        ? voice.voiceConfig.config.voiceName === googleName
        : voice.voiceConfig.config.voiceId === wanted)
  );
}

/**
 * The choice text to offer for an entry (#817): the picker text, or the
 * qualified text when the picker text alone would not resolve to this entry,
 * as when two configured voices share a label.
 */
export function voiceChoiceText(catalog: readonly SupportedVoice[], voice: SupportedVoice): string {
  const label = voiceChoiceLabel(voice);
  const matches = matchVoiceChoice(catalog, label);
  return matches.length === 1 && matches[0] === voice ? label : qualifiedVoiceChoiceLabel(voice);
}

/**
 * Resolve a typed or spoken choice to exactly one catalog entry (#817). It may
 * name a label, the picker's "label (provider)" text, the offered choice text,
 * a Google voice name in any case, or an ElevenLabs voice id. A choice that
 * names more than one entry is ambiguous rather than first-wins, and the error
 * lists choice text that resolves to each candidate.
 */
export function resolveVoiceChoice(
  catalog: readonly SupportedVoice[],
  choice: string
): VoiceChoiceResolution {
  const wanted = choice.trim();
  const matches = matchVoiceChoice(catalog, wanted);
  if (matches.length === 1) return { ok: true, voice: matches[0] };
  if (catalog.length === 0) return { ok: false, error: "no voices are available" };
  const problem = matches.length > 1 ? "is ambiguous" : "is not an available voice";
  const choices = (matches.length > 1 ? matches : catalog)
    .map((voice) => voiceChoiceText(catalog, voice))
    .join(", ");
  return { ok: false, error: `voice '${wanted}' ${problem}; choose one of: ${choices}` };
}
