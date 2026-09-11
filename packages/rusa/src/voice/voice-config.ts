import { z } from "zod";

/** The V1 document branch for the currently wired Google synthesizer. */
const googleVoiceConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("google"),
    config: z
      .object({
        voiceName: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Strict durable voice-setting contract. Adding a synthesizer extends this
 * provider union in one place; API ingress, actor records, and storage all
 * consume this same schema and inferred type.
 */
export const voiceConfigSchema = z.discriminatedUnion("provider", [googleVoiceConfigSchema]);

export type VoiceConfigDocument = z.infer<typeof voiceConfigSchema>;

/** Construct the current Google branch without repeating its wire shape. */
export function googleVoiceConfig(voiceName: string): VoiceConfigDocument {
  return voiceConfigSchema.parse({
    schemaVersion: 1,
    provider: "google",
    config: { voiceName },
  });
}
