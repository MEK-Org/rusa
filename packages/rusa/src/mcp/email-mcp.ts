import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GmailClient } from "../email/gmail-client.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const EMAIL_SEND_MCP_NAME = "email-send";

export interface EmailDelivery {
  to: string;
  cc: string[];
}

/** Outbound-only Gmail tool with recipient authorization enforced in-tool. */
export function createEmailSendMcpServer(
  actorId: string,
  gmailClient: GmailClient,
  options: {
    allowedRecipients: string[];
    onSend: (actorId: string, delivery: EmailDelivery) => void;
    isFenced?: () => boolean;
  }
): McpServer {
  const server = createMcpServer(
    { name: EMAIL_SEND_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );

  const assertAllowed = (recipients: string[]) => {
    if (
      !options.allowedRecipients ||
      options.allowedRecipients.length === 0 ||
      recipients.some((recipient) => !options.allowedRecipients.includes(recipient))
    ) {
      throw new Error("access denied: every email recipient must be in allowed recipients");
    }
  };

  server.registerTool(
    "send_email",
    {
      title: "Send a plain-text email to allowed recipients",
      description:
        "Send one plain-text email as the authenticated bot account. Every To and Cc recipient must be explicitly granted.",
      inputSchema: {
        to: z.string().email(),
        subject: z
          .string()
          .refine(
            (value) => !value.includes("\r") && !value.includes("\n"),
            "subject cannot contain newlines"
          ),
        body: z.string(),
        cc: z.array(z.string().email()).optional(),
        html_body: z.string().optional(),
      },
    },
    async ({ to, subject, body, cc, html_body }) => {
      try {
        const ccRecipients = cc ?? [];
        assertAllowed([to, ...ccRecipients]);
        const result = await gmailClient.sendEmail({
          to,
          subject,
          body,
          ...(ccRecipients.length ? { cc: ccRecipients } : {}),
          ...(html_body !== undefined ? { html_body } : {}),
        });
        try {
          options.onSend(actorId, { to, cc: ccRecipients });
        } catch (err) {
          console.warn(
            `[email-send] failed to record completed send: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
