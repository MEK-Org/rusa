import type { ChatWakeMode } from "../chat/wake-mode.js";
import { parseReference } from "../references/reference.js";

/** The conversation kinds an ordinary Slack message can wake from. */
export type SlackConversationKind = "im" | "channel" | "mpim";

/** What an arriving Slack event says about itself, before any wake policy applies. */
export interface SlackWakeFacts {
  eventKind: "message" | "app_mention";
  /** Unset when Slack omitted or sent an unsupported `channel_type`. */
  conversationKind?: SlackConversationKind;
  /** Whether the text directly mentions the installed bot itself. */
  mentionsSelf: boolean;
}

/** Slack's `channel_type`, narrowed to the conversations this source supports. */
export function slackConversationKind(
  channelType: string | undefined
): SlackConversationKind | undefined {
  switch (channelType) {
    case "im":
      return "im";
    // Slack calls a private channel `group`; it follows the channel policy.
    case "channel":
    case "group":
      return "channel";
    case "mpim":
      return "mpim";
    default:
      return undefined;
  }
}

/**
 * Whether `text` directly mentions the Slack user `selfUserId`. Slack encodes a
 * user mention as `<@U123>` or `<@U123|name>`; a display name, another user, a
 * user group (`<!subteam^…>`), `@here` and `@channel` are not self mentions.
 */
export function mentionsSlackUser(text: string, selfUserId: string): boolean {
  if (text.includes(`<@${selfUserId}>`)) return true;
  // A labeled mention counts only as a closed token; Slack escapes `<` and `>`
  // in message text, so the label cannot contain either.
  return text
    .split(`<@${selfUserId}|`)
    .slice(1)
    .some((rest) => /^[^<>]*>/.test(rest));
}

/**
 * How one Slack conversation wakes its event-source owner (#1037).
 *
 * - `all`: every ordinary human message wakes, as do app mentions.
 * - `mentions`: only a message that directly mentions the installed bot wakes.
 *
 * A conversation with no stored mode keeps the compatibility default: a
 * one-to-one DM wakes on every message, and a channel or group DM wakes only
 * through Slack's `app_mention` event. The default is derived per event rather
 * than written down, so conversations that existed before the setting keep
 * exactly the behavior they had; nothing is migrated.
 */
export function slackMessageWakes(msg: SlackWakeFacts, mode: ChatWakeMode | undefined): boolean {
  // Slack sends `app_mention` only for a direct mention of the app's bot user,
  // which every mode admits; when unset this is the long-standing channel path,
  // kept even when Slack omits `channel_type`.
  if (msg.eventKind === "app_mention") return true;
  if (msg.conversationKind === undefined) return false;
  const effective = mode ?? (msg.conversationKind === "im" ? "all" : undefined);
  // An unconfigured channel or group DM wakes only through `app_mention`, so an
  // ordinary message there is not admitted a second time.
  if (effective === undefined) return false;
  return effective === "all" || msg.mentionsSelf;
}

/**
 * The canonical `slack:channels/<id>` resource for one conversation id, or
 * `undefined` when the id cannot name exactly one conversation. Inbound
 * ingestion uses it, so an unexpected id falls back to the default rather than
 * throwing.
 */
export function trySlackConversationResource(channel: string): string | undefined {
  if (typeof channel !== "string" || !channel.trim() || channel.includes("/")) return undefined;
  try {
    const ref = parseReference(`slack:channels/${channel.trim()}`);
    return ref.segments.length === 2 ? ref.key : undefined;
  } catch {
    return undefined;
  }
}
