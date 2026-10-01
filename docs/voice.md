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
takes effect on the next reply. An omitted pool keeps Google's existing random
assignment across built-in voices when Google credentials are configured; an explicitly
configured roster must contain at least one voice matching available provider credentials.
In the dashboard dropdown, configured choices appear
alongside built-in voices for available credentials (and **Instance default**).
Previously saved IDs remain displayed even if removed from the pool.

The dashboard snapshot has one `supportedVoices` catalog for all providers. Each
entry contains `label`, `providerLabel`, and `voiceConfig`. Built-in Gemini voices
are included automatically when Google credentials are configured; a configured entry
for the same document overrides its label. Actor selections and PATCH requests use
that `voiceConfig` document unchanged, so labels are never used as provider voice IDs.
Adding a provider requires its voice schema, display label, and speech adapter; the
dashboard API, store, dropdown, and actor assignment do not need additional provider
fields. The instance default is Google; actors requiring Google TTS require
`geminiApiKey` (or an explicit ElevenLabs actor voice selection from the configured pool).

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

## Chat Room

The dashboard's top-level **Chat Room** is one mesh-wide room. Root is always
a participant. Its roster is stored in `mesh.db`, so every dashboard, and a
reload, shows the same room. Only the actor holding the host-global
`room-admin` capability (the configured root, seeded at boot) changes it, with
the `add_room_participant`, `remove_room_participant` and
`list_room_participants` mesh tools. Human principals and aliases such as
`root` or `parent` cannot be added. The dashboard reads the roster from
`GET /api/mesh/chat-room`, re-reading it every 10 seconds while the room is
open, and has no add or remove control of its own.

The room is separate from the single-actor walkie screen: it listens to the
existing multi-actor voice presence and backlog routes, while the single-actor
screen retains its leased-session behavior.

An avatar is a tap-to-record/tap-to-send control. The first tap captures that
avatar as the recipient; tapping a different avatar while recording cannot
redirect the clip. Tap the captured avatar again to send it, or use **Cancel
recording** to discard it. Incoming replies from every room participant join
one FIFO queue, so only one voice plays at a time. Starting a recording pauses
the current reply without acknowledging it; after send or cancel, that reply
resumes before later queued replies. The speaking actor has a highlighted ring.

Adding a participant keeps the room's voices distinct. When root adds an actor
whose voice another participant already uses (including two actors that both
fall back to the instance default), the actor is given the first unused voice
from the supported catalog, saved as its ordinary per-actor voice setting. The
add result reports the voice it assigned and the one it replaced. Removing an
actor leaves its voice as it is. Each room tile names the actor's voice. A voice
changed later from **Info → Voice** is not re-checked against the room.

The adapters use ElevenLabs' [transcription API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
and [speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
