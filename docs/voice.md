# Walkie-talkie speech providers

Transcription is selected instance-wide. Actor reply voices are selected independently.
Existing configurations continue using Google for both.

To try ElevenLabs STT, put your API key in `$RUSA_HOME/secrets/elevenlabs-api-key`
(the file takes precedence over the optional `elevenlabsApiKey` config field), then set:

```yaml
voice:
  transcriptionProvider: elevenlabs
  # transcriptionModel: scribe_v2
```

Restart rusa after changing instance config. Remove an existing Google
`transcriptionModel` override when switching, or replace it with an ElevenLabs model.
Set `transcriptionProvider: google` to switch back. Only the selected STT provider
receives each memo; transcript comparison is deferred.

For actor TTS, configure the voice pool:

```yaml
voice:
  supportedVoices:
    - label: Christopher
      voiceConfig:
        schemaVersion: 1
        provider: elevenlabs
        config:
          voiceId: YOUR_VOICE_ID_1
    - label: Valentino
      voiceConfig:
        schemaVersion: 1
        provider: elevenlabs
        config:
          voiceId: YOUR_VOICE_ID_2
    # The same pool can contain Gemini voices:
    # - label: Achernar
    #   voiceConfig:
    #     schemaVersion: 1
    #     provider: google
    #     config:
    #       voiceName: Achernar
```

These labels appear in the actor's **Info → Voice** dropdown. When configured, new
actors randomly receive a voice from this pool, restricting spawn selection to the
configured roster so that newly spawned actors only receive voices matching available
credentials. Existing actors retain their current settings; choosing another voice
takes effect on the next reply. An omitted or empty pool keeps Google's existing random
assignment across built-in voices. In the dashboard dropdown, configured choices appear
alongside built-in voices for available credentials (and **Instance default**).
Previously saved IDs remain displayed even if removed from the pool.

The dashboard snapshot has one `supportedVoices` catalog for all providers. Each
entry contains `label`, `providerLabel`, and `voiceConfig`. Built-in Gemini voices
are included automatically when Google credentials are configured; a configured entry
for the same document overrides its label. Actor selections and PATCH requests use
that `voiceConfig` document unchanged, so labels are never used as provider voice IDs.
Adding a provider requires its voice schema, display label, and speech adapter; the
dashboard API, store, dropdown, and actor assignment do not need additional provider
fields. The instance default is Google; on an ElevenLabs-only instance without
`geminiApiKey`, reply synthesis falls back to the configured ElevenLabs voice pool.

Optional TTS model override:

```yaml
voice:
  transcriptionProvider: elevenlabs
  elevenlabsTtsModel: eleven_multilingual_v2
```

The actor voice API also accepts `PATCH /api/mesh/actors/<actorId>/voice`:

```json
{"voiceConfig":{"schemaVersion":1,"provider":"elevenlabs","config":{"voiceId":"YOUR_VOICE_ID"}}}
```

Send `{"voiceConfig":null}` to restore the Google instance default.
Keys stay on the host and are included in log secret redaction.

The adapters use ElevenLabs' [transcription API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
and [speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
