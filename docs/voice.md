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
  elevenlabsVoices:
    - voiceId: G17SuINrv2H9FC6nvetn
      label: Christopher
    - voiceId: SMRMz7WpPUV6i2myuniv
      label: Valentino
```

These labels appear in the actor's **Info → Voice** dropdown. New actors randomly
receive a voice from this pool. Existing actors retain their current settings;
choosing another voice takes effect on the next reply. An omitted or empty pool
keeps Google's existing random assignment. Google voices and **Instance default**
remain available in the dropdown. Previously saved IDs remain displayed even if
removed from the pool. Legacy `elevenlabsVoiceIds` lists still work, using IDs as
labels; when both fields exist, `elevenlabsVoices` takes precedence.
The instance default is Google, so it still requires `geminiApiKey`; with only an
ElevenLabs key, select an ElevenLabs voice for each actor you speak with.

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
