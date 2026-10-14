# Slack wake coverage

Which Slack messages wake an actor is decided per conversation, from the exact
`slack:channels/<conversation-id>` event-source row (#1037). The owner of that
row sets it with `set_event_source_config` and reads it back with
`list_event_sources`, the same tools Google Chat wake mode uses:

```json
{ "version": 1, "slackWakeMode": "all" }
```

`slackWakeMode` is `"all"` or `"mentions"`. Other keys in the object are kept
as they are; setting the whole config to `null` restores the default. The mode
is read for every arriving event, so a change applies to the next message
without a restart. Only the exact conversation's row counts: a thread, a parent
source, or another conversation never lends it a policy. A missing, invalid or
unsupported-version config falls back to the default and never widens what
wakes.

## Defaults and modes

| Conversation | Unset (default) | `all` | `mentions` |
| --- | --- | --- | --- |
| One-to-one DM (`im`) | Every human message | Every human message | A direct mention of the bot |
| Public or private channel (`channel`, `group`) | `app_mention` only | Every human message, plus app mentions | App mentions, or a direct bot mention in an ordinary message |
| Group DM (`mpim`) | Ordinary messages ignored | Every human message | A direct bot mention |

The default is exactly the behavior before this setting existed; no existing
conversation is migrated. An `app_mention` event is admitted in every mode,
including when Slack omits `channel_type`. An ordinary message from any other
conversation type is ignored, even under `all`.

A mention means the installed bot's own user, encoded by Slack as `<@U…>`. A
display name, another user, a user group, `@here` and `@channel` are not. The
bot's identity comes from `auth.test` on the bot token, looked up when the first
event arrives and retried if it fails; until it is known, plain-text mentions go
undetected and only `app_mention` events count as mentions.

A thread reply follows its conversation's mode and keeps its `thread_ts`. Taking
part in a thread does not opt later replies into waking.

Messages from bots, from the installed bot itself, and edit, delete or other
subtype events never wake anyone.

## Delivery

One Slack message can arrive more than once: as both a `message` and an
`app_mention` event, each with its own event ID, and again on Slack's retries.
The inbox item is keyed by the conversation and message timestamp, so each owner
gets one item per message; the envelope's event ID is kept only in logs.

An admitted event is acknowledged only after the inbox durably accepts it, so a
failed insert leaves it for Slack to retry. An ignored event is acknowledged
straight away. The 👀 receipt is added only to a message the inbox accepted for
some owner, and a failed receipt never causes redelivery.

## Slack app access

Configuration filters the events Slack delivers. It cannot add scopes, channel
membership, or event subscriptions. A mode only takes effect for events the app
already receives:

| Event subscription | Scope | Covers |
| --- | --- | --- |
| [`app_mention`](https://docs.slack.dev/reference/events/app_mention/) | `app_mentions:read` | Mentions in channels the bot is in |
| [`message.im`](https://docs.slack.dev/reference/events/message/) | `im:history` | One-to-one DMs, including mentions there: Slack sends no `app_mention` for DMs |
| `message.channels` | `channels:history` | Ordinary public-channel messages, when enabled separately |
| `message.groups` | `groups:history` | Ordinary private-channel messages, when enabled separately |
| [`message.mpim`](https://docs.slack.dev/reference/events/message.mpim/) | `mpim:history` | Group-DM messages, when enabled separately |

When a conversation's mode asks for messages the app is not subscribed to,
those messages simply do not arrive. Changing the app's subscriptions, scopes or
memberships is a separate operator decision. This source serves the one
installation whose tokens it was started with.
