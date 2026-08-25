import { type Message, PubSub, type Subscription } from "@google-cloud/pubsub";
import { parseChatMessageData, toChatMessage } from "./normalize.js";
import type {
  ChatMessage,
  ChatSource,
  ChatSpaceMember,
  ChatSpaceMemberPage,
  ListChatSpaceMembersOptions,
} from "./types.js";

const CHAT_MESSAGE_CREATED = "google.workspace.chat.message.v1.created";

export interface PubsubChatSourceOptions {
  /** GCP project hosting the subscription. */
  projectId: string;
  /** Pull subscription id receiving Workspace Events chat messages. */
  subscription: string;
  /** Path to the service-account key JSON used for Pub/Sub auth. */
  keyFilename: string;
  /** Authenticated user resource name (`users/{id}`); self-authored messages are skipped. */
  selfUserId: string;
  /** Resolve a space's type (e.g. via the Chat REST API); results are cached. */
  resolveSpaceType: (spaceName: string) => Promise<string>;
  /** List the current members of a space. Called per room message; deliberately uncached. */
  listSpaceMembers: (
    spaceName: string,
    options?: ListChatSpaceMembersOptions
  ) => Promise<ChatSpaceMemberPage>;
  log?: (msg: string) => void;
}

/**
 * Inbound {@link ChatSource} backed by a Pub/Sub streaming-pull subscription.
 * The subscription is fed by a Workspace Events subscription on the gchat user's
 * spaces, so this delivers (near) real-time chat messages without any public
 * HTTP endpoint. Self-authored and bot messages are dropped; everything else is
 * normalized and handed to the consumer, which decides whether to act.
 */
export class PubsubChatSource implements ChatSource {
  private readonly opts: PubsubChatSourceOptions;
  private readonly log: (msg: string) => void;
  private readonly spaceTypeCache = new Map<string, string>();
  private pubsub: PubSub | null = null;
  private subscription: Subscription | null = null;

  constructor(opts: PubsubChatSourceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async start(onMessage: (msg: ChatMessage) => void | Promise<void>): Promise<void> {
    this.pubsub = new PubSub({
      projectId: this.opts.projectId,
      keyFilename: this.opts.keyFilename,
    });
    const sub = this.pubsub.subscription(this.opts.subscription);
    this.subscription = sub;
    sub.on("message", (message: Message) => {
      void this.handle(message, onMessage);
    });
    sub.on("error", (err: unknown) => {
      this.log(`subscription error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.log(`listening on ${this.opts.subscription} (project ${this.opts.projectId})`);
  }

  private async handle(
    message: Message,
    onMessage: (msg: ChatMessage) => void | Promise<void>
  ): Promise<void> {
    try {
      const ceType = message.attributes?.["ce-type"];
      if (ceType && ceType !== CHAT_MESSAGE_CREATED) {
        message.ack();
        return;
      }
      const parsed = parseChatMessageData(message.data.toString("utf-8"));
      if (!parsed) {
        message.ack();
        return;
      }
      // Drop our own messages and other bots — only humans trigger.
      if (parsed.senderName === this.opts.selfUserId || parsed.senderType === "BOT") {
        message.ack();
        return;
      }
      const spaceType = await this.resolveSpaceType(parsed.spaceName, parsed.spaceType);
      const spaceMembers =
        spaceType === "DIRECT_MESSAGE" ? [] : await this.resolveSpaceMembers(parsed.spaceName);
      const chatMessage = toChatMessage(parsed, this.opts.selfUserId, spaceType, spaceMembers);
      await onMessage(chatMessage);
      message.ack();
    } catch (err) {
      this.log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
      // Leave the message un-acked so Pub/Sub redelivers it.
      message.nack();
    }
  }

  private async resolveSpaceMembers(spaceName: string): Promise<ChatSpaceMember[]> {
    const members: ChatSpaceMember[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const page = await this.opts.listSpaceMembers(spaceName, { pageSize: 1000, pageToken });
        members.push(...page.members);
        if (members.length > 2) return members;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      this.log(
        `space membership lookup failed for ${spaceName}: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
    return members;
  }

  private async resolveSpaceType(spaceName: string, fromPayload?: string): Promise<string> {
    if (fromPayload) return fromPayload;
    const cached = this.spaceTypeCache.get(spaceName);
    if (cached) return cached;
    let resolved = "UNKNOWN";
    try {
      resolved = await this.opts.resolveSpaceType(spaceName);
    } catch (err) {
      this.log(
        `space type lookup failed for ${spaceName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.spaceTypeCache.set(spaceName, resolved);
    return resolved;
  }

  async close(): Promise<void> {
    if (this.subscription) {
      await this.subscription.close();
      this.subscription = null;
    }
    if (this.pubsub) {
      await this.pubsub.close();
      this.pubsub = null;
    }
  }
}
