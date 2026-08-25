/**
 * Production wiring for walkie-talkie mode : build the voice service
 * from config, and bridge actor replies from the mesh-event emitter to the
 * `voice` SSE channel. Kept apart from the service/routes so tests exercise
 * those with injected fakes and only this file touches real config/Gemini.
 */

import type { VoiceConfig } from "../config/types.js";
import type { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import { createGeminiSpeechClient } from "./gemini-speech.js";
import { toFrame, type VoiceAnnouncementFrame, VoiceService } from "./voice-service.js";

/** Build the production voice service (Gemini speech + `$RUSA_HOME` storage). */
export function createVoiceService(options: {
  home: string;
  apiKey: string;
  voice?: VoiceConfig;
}): VoiceService {
  return new VoiceService({
    home: options.home,
    speech: createGeminiSpeechClient({
      apiKey: options.apiKey,
      transcriptionModel: options.voice?.transcriptionModel,
      ttsModel: options.voice?.ttsModel,
      voiceName: options.voice?.voiceName,
    }),
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
  hub: { pushVoice(frame: VoiceAnnouncementFrame): void }
): () => void {
  return emitter.onMeshEvent((event) => {
    void service
      .handleMeshEvent(event)
      .then((announcement) => {
        if (announcement) hub.pushVoice(toFrame(announcement));
      })
      .catch((err) => {
        console.warn(
          `[voice] reply TTS failed for ${event.actorId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
  });
}
