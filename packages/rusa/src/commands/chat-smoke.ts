import { GchatClient, loadGchatIdentity } from "../chat/gchat-client.js";
import { PubsubChatSource } from "../chat/pubsub-source.js";
import { loadConfig, resolveHome } from "../config/index.js";

/**
 * Standalone smoke test for the Google Chat inbound puller. Loads config, runs a
 * {@link PubsubChatSource}, logs every delivered message, and 👀-reacts to
 * DMs/@mentions — exactly like the production wiring in `runStart`, but without
 * binding ports or starting the orchestrator. Runs until Ctrl-C.
 */
export async function runChatSmoke(): Promise<void> {
  const config = loadConfig(resolveHome());
  if (!config.chat) {
    console.error("config.chat is not set in config.yaml — nothing to smoke-test.");
    process.exit(1);
  }

  const gchatDir = config.chat.gchatConfigDir;
  const chatClient = new GchatClient(gchatDir);
  const identity = loadGchatIdentity(gchatDir);
  console.log(`[chat-smoke] self = ${identity.email ?? identity.userId}`);

  const source = new PubsubChatSource({
    projectId: config.chat.projectId,
    subscription: config.chat.subscription,
    keyFilename: config.chat.pubsubKeyPath,
    selfUserId: identity.userId,
    resolveSpaceType: (space) => chatClient.getSpaceType(space),
    listSpaceMembers: (space, options) => chatClient.listSpaceMembers(space, options),
    log: (m) => console.log(`[chat-smoke] ${m}`),
  });

  await source.start(async (msg) => {
    const trigger = msg.isDirectMessage || msg.mentionsSelf;
    console.log(
      `[chat-smoke] ${trigger ? "▶ trigger" : "·"} [${msg.spaceType}] ${msg.spaceName} ` +
        `from ${msg.senderDisplayName ?? msg.senderName}: ${JSON.stringify(msg.text)}`
    );
    if (!trigger) return;
    try {
      await chatClient.react(msg.name);
      console.log("[chat-smoke] 👀 reacted");
    } catch (err) {
      console.warn(
        `[chat-smoke] react failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  console.log("[chat-smoke] listening — send a DM to the bot. Ctrl-C to stop.");
  await new Promise<void>((resolve) => {
    const stop = () => void source.close().then(resolve);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
