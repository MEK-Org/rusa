import type { PushDeviceTokenRepository } from "../db/repositories/push-device-token-repository.js";
import { type Logger, nullLogger } from "../observability/logger.js";

export const REPLY_NOTIFICATION_CLICK_ACTION = "org.mek.rusa.dashboard.OPEN_REPLY";

export interface VoicePush {
  actorId: string;
  announcementId: string;
  recipientId: string;
}

/** Delivery boundary kept small enough to fake without Firebase in unit tests. */
export interface VoicePushDelivery {
  deliver(push: VoicePush): Promise<void>;
}

export interface FcmMessageSender {
  send(message: {
    token: string;
    data: Record<string, string>;
    notification: { title: string };
    android: { priority: "high"; notification: { clickAction: string } };
  }): Promise<string>;
}

/** FCM codes that authoritatively mean this registration must not be retried. */
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

/**
 * Sends a content-free notification with only the durable reply lookup keys.
 * Message text and registration tokens never enter the FCM payload logs.
 */
export class FcmVoicePushDelivery implements VoicePushDelivery {
  constructor(
    private readonly tokens: Pick<PushDeviceTokenRepository, "listForPrincipal" | "remove">,
    private readonly sender: FcmMessageSender,
    private readonly logger: Logger = nullLogger
  ) {}

  async deliver(push: VoicePush): Promise<void> {
    const registrations = this.tokens.listForPrincipal(push.recipientId);
    await Promise.all(
      registrations.map(async ({ token }) => {
        try {
          await this.sender.send({
            token,
            // These two identifiers are the minimum needed for an authenticated
            // client to recover the one reply; no body or account identifier is
            // sent through the platform notification service.
            data: { actorId: push.actorId, announcementId: push.announcementId },
            notification: { title: "New reply" },
            android: {
              priority: "high",
              notification: { clickAction: REPLY_NOTIFICATION_CLICK_ACTION },
            },
          });
        } catch (error) {
          const code = errorCode(error);
          if (code && INVALID_TOKEN_CODES.has(code)) {
            this.tokens.remove(token);
            this.logger.info("voice_push_invalid_token_removed", { code });
            return;
          }
          this.logger.warn("voice_push_delivery_failed", { code: code ?? "unknown" });
        }
      })
    );
  }
}

/**
 * Build the server's FCM sender from the already-required dashboard Firebase
 * service account. It introduces no project, credential, or provider setting:
 * deployments without dashboard auth simply do not construct a sender.
 */
export function createFcmVoicePushDelivery(options: {
  firebase: DashboardAuthConfig["firebase"];
  tokens: Pick<PushDeviceTokenRepository, "listForPrincipal" | "remove">;
  logger?: Logger;
}): { delivery: FcmVoicePushDelivery; close: () => Promise<void> } {
  const { projectId, serviceAccountKeyPath } = options.firebase;
  let credential: unknown;
  try {
    credential = JSON.parse(readFileSync(serviceAccountKeyPath, "utf8"));
  } catch (error) {
    throw new Error("Could not initialize FCM reply delivery credentials", { cause: error });
  }
  if (
    typeof credential !== "object" ||
    credential === null ||
    (credential as { project_id?: unknown }).project_id !== projectId
  ) {
    throw new Error(
      "FCM reply delivery service-account project does not match dashboard Firebase project"
    );
  }
  const app = initializeApp(
    { projectId, credential: cert(credential as ServiceAccount) },
    `rusa-reply-push-${randomUUID()}`
  );
  const messaging = getMessaging(app);
  const sender: FcmMessageSender = { send: (message) => messaging.send(message) };
  return {
    delivery: new FcmVoicePushDelivery(options.tokens, sender, options.logger),
    close: () => deleteApp(app),
  };
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cert, deleteApp, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { DashboardAuthConfig } from "../config/types.js";
