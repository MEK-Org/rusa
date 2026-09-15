/**
 * Production wiring for walkie-talkie mode : build the voice service
 * from config, and bridge actor replies from the mesh-event emitter to the
 * `voice` SSE channel. Kept apart from the service/routes so tests exercise
 * those with injected fakes and only this file selects the configured providers.
 */

import type { VoiceConfig } from "../config/types.js";
import type { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import { type Logger, nullLogger } from "../observability/logger.js";
import { createElevenLabsSpeechClient } from "./elevenlabs-speech.js";
import { createGeminiSpeechClient } from "./gemini-speech.js";
import type { VoiceConfigDocument } from "./voice-config.js";
import { toFrame, type VoiceAnnouncementFrame, VoiceService } from "./voice-service.js";

/** Build the production voice service with host-only provider credentials. */
export function createVoiceService(options: {
  home: string;
  apiKey: string;
  elevenlabsApiKey?: string;
  voiceConfigFor?: (actorId: string) => VoiceConfigDocument | undefined;
  voice?: VoiceConfig;
  /**
   * Per-actor voice lookup, consulted before each reply's synthesis. The
   * caller resolves it against the actor repository; undefined keeps the
   * instance-wide configured default.
   */
  voiceNameFor?: (actorId: string) => string | undefined;
  onSessionEnded?: (actorId: string) => void;
  logger?: Logger;
}): VoiceService {
  const google = createGeminiSpeechClient({
    apiKey: options.apiKey,
    transcriptionModel:
      options.voice?.transcriptionProvider === "elevenlabs"
        ? undefined
        : options.voice?.transcriptionModel,
    ttsModel: options.voice?.ttsModel,
    voiceName: options.voice?.voiceName,
  });
  const elevenlabs = createElevenLabsSpeechClient({
    apiKey: options.elevenlabsApiKey ?? "",
    transcriptionModel:
      options.voice?.transcriptionProvider === "elevenlabs"
        ? options.voice?.transcriptionModel
        : undefined,
    ttsModel: options.voice?.elevenlabsTtsModel,
  });
  const transcription = options.voice?.transcriptionProvider === "elevenlabs" ? elevenlabs : google;
  return new VoiceService({
    home: options.home,
    speech: { ...google, transcribe: transcription.transcribe },
    speechFor: (actorId) => {
      const config = options.voiceConfigFor?.(actorId);
      if (config?.provider === "elevenlabs")
        return { speech: elevenlabs, voiceName: config.config.voiceId };
      if (!options.apiKey.trim())
        throw new Error(
          "Google TTS: geminiApiKey is not configured; select an ElevenLabs actor voice"
        );
      return { speech: google, voiceName: config?.config.voiceName };
    },
    voiceNameFor: options.voiceNameFor,
    onSessionEnded: options.onSessionEnded,
    logger: options.logger,
  });
}

/**
 * Subscribe the reply-TTS hook to the dashboard's mesh-event emitter: replies
 * to `human:operator` from actors with walkie presence get rendered and pushed
 * on the `voice` channel. Purely observational — never touches actor/mesh
 * code. Returns the unsubscribe function.
 */
export function attachVoiceOutbound(
  emitter: MeshEventEmitter,
  service: VoiceService,
  hub: { pushVoice(frame: VoiceAnnouncementFrame): void },
  logger: Logger = nullLogger
): () => void {
  return emitter.onMeshEvent((event) => {
    void service
      .handleMeshEvent(event, (announcement) => hub.pushVoice(toFrame(announcement)))
      .catch((err) => {
        logger.warn("voice_reply_tts_failed", { actorId: event.actorId, err });
      });
  });
}
