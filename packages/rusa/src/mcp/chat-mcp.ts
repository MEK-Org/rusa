import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import mime from "mime";
import { z } from "zod";
import { type ChatClient, MAX_CHAT_ATTACHMENT_BYTES } from "../chat/types.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const CHAT_WRITE_MCP_NAME = "chat-write";
export const CHAT_READ_MCP_NAME = "chat-read";

export const ATTACHMENT_RESOURCE_NAME_RE =
  /^spaces\/[^/]+(?:\/messages\/[^/]+)?\/attachments\/[^/]+$/;

export function inferChatMimeType(filename: string): string {
  return mime.getType(filename) ?? "application/octet-stream";
}

/** Read-only Google Chat tools, mounted for every actor when Chat is configured. */
export function createChatReadMcpServer(
  chatClient: ChatClient,
  options?: { isFenced?: () => boolean; maxAttachmentBytes?: number }
): McpServer {
  const server = createMcpServer(
    { name: CHAT_READ_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "get_message",
    {
      title: "Get a Google Chat message",
      description: "Read one message by its full Google Chat resource name.",
      inputSchema: {
        messageName: z.string().describe("Message resource name, e.g. spaces/A/messages/B"),
      },
    },
    async ({ messageName }) => {
      try {
        if (!/^spaces\/[^/]+\/messages\/[^/]+$/.test(messageName)) {
          throw new Error("messageName must be in format spaces/SPACE/messages/MESSAGE");
        }
        return toolOk(await chatClient.getMessage(messageName));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get Google Chat attachment metadata",
      description: "Read metadata for one attachment by its full Google Chat resource name.",
      inputSchema: {
        attachmentName: z
          .string()
          .describe(
            "Attachment resource name, e.g. spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT"
          ),
      },
    },
    async ({ attachmentName }) => {
      try {
        if (!ATTACHMENT_RESOURCE_NAME_RE.test(attachmentName)) {
          throw new Error(
            "attachmentName must be in format spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT or spaces/SPACE/attachments/ATTACHMENT"
          );
        }
        return toolOk(await chatClient.getAttachment(attachmentName));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "download_attachment",
    {
      title: "Download a Google Chat attachment's binary content",
      description: "Download an attachment's raw bytes and return them as a base64-encoded string.",
      inputSchema: {
        resourceName: z
          .string()
          .describe(
            "Attachment resource name or attachmentDataRef resourceName (e.g. spaces/SPACE/attachments/ATTACHMENT or spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT)"
          ),
      },
    },
    async ({ resourceName }) => {
      try {
        if (!ATTACHMENT_RESOURCE_NAME_RE.test(resourceName)) {
          throw new Error(
            "resourceName must be in format spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT or spaces/SPACE/attachments/ATTACHMENT"
          );
        }
        const result = await chatClient.downloadAttachment(resourceName);
        const maxBytes = options?.maxAttachmentBytes ?? MAX_CHAT_ATTACHMENT_BYTES;
        if (result.length > maxBytes) {
          throw new Error(
            `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
          );
        }
        return toolOk(result.toString("base64"));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_spaces",
    {
      title: "List the Google Chat spaces this identity is in",
      description:
        "List the spaces the authenticated Chat identity is a member of. This is the distiller's read set : membership is a measurement, so a space nobody remembered to configure is no longer a silent hole. Omit pageToken for the first page and follow nextPageToken until it is absent — a partial walk is not the membership.",
      inputSchema: {
        pageSize: z.number().int().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ pageSize, pageToken }) => {
      try {
        return toolOk(
          await chatClient.listSpaces({
            ...(pageSize !== undefined ? { pageSize } : {}),
            ...(pageToken ? { pageToken } : {}),
          })
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_messages",
    {
      title: "List Google Chat messages",
      description:
        "Read a page of messages from a space, optionally narrowed to one thread. Available to every actor.",
      inputSchema: {
        spaceName: z.string().describe("Space resource name, e.g. spaces/AAAA"),
        pageSize: z.number().int().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
        threadName: z.string().optional().describe("Only return messages in this thread resource"),
        orderBy: z.enum(["ASC", "DESC"]).optional(),
        createdAfter: z
          .string()
          .optional()
          .describe("Only return messages created after this timestamp"),
        createdBefore: z
          .string()
          .optional()
          .describe("Only return messages created before this timestamp"),
        showDeleted: z.boolean().optional(),
      },
    },
    async ({
      spaceName,
      pageSize,
      pageToken,
      threadName,
      orderBy,
      createdAfter,
      createdBefore,
      showDeleted,
    }) => {
      try {
        if (!/^spaces\/[^/]+$/.test(spaceName)) {
          throw new Error("spaceName must be in format spaces/SPACE");
        }
        if (threadName && !/^spaces\/[^/]+\/threads\/[^/]+$/.test(threadName)) {
          throw new Error("threadName must be in format spaces/SPACE/threads/THREAD");
        }
        if (threadName && !threadName.startsWith(`${spaceName}/threads/`)) {
          throw new Error("threadName must belong to spaceName");
        }
        return toolOk(
          await chatClient.listMessages(spaceName, {
            ...(pageSize !== undefined ? { pageSize } : {}),
            ...(pageToken ? { pageToken } : {}),
            ...(threadName ? { threadName } : {}),
            ...(orderBy ? { orderBy } : {}),
            ...(createdAfter ? { createdAfter } : {}),
            ...(createdBefore ? { createdBefore } : {}),
            ...(showDeleted !== undefined ? { showDeleted } : {}),
          })
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}

export interface ChatWriteMcpOptions {
  allowedSpaces: string[];
  onWrite?: (actorId: string) => void;
  isFenced?: () => boolean;
  maxAttachmentBytes?: number;
  /** Directory attachment `filePath`s are confined to; defaults to `process.cwd()`. */
  workDir?: string;
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve an attachment `filePath` and confine it to the calling actor's
 * workdir. Without this boundary, `chat-write` is a host-file read-and-exfiltrate
 * primitive: any path the server process can see could be uploaded to a chat
 * space. Both the workdir and the target are realpath'd so `..` traversal and
 * symlinks pointing outside the workdir are rejected, not just lexical escapes;
 * realpath on the target also surfaces ENOENT for nonexistent files.
 */
async function resolveAttachmentPath(workDir: string, filePath: string): Promise<string> {
  const realRoot = await realpath(workDir);
  const target = resolve(realRoot, filePath);
  if (!isContained(realRoot, target)) {
    throw new Error("access denied: filePath escapes the actor workdir");
  }
  const realTarget = await realpath(target);
  if (!isContained(realRoot, realTarget)) {
    throw new Error("access denied: filePath resolves outside the actor workdir");
  }
  return realTarget;
}

/**
 * In-process MCP server exposing outbound Google Chat actions (the
 * {@link ChatClient} seam) as tools. Production wires a `GchatClient`; the e2e
 * runner wires the `FakeChatClient`. Inbound chat is delivered via the
 * `ChatSource`→inbox path (the human-as-parent wrapper), not as a tool.
 */
export function createChatWriteMcpServer(
  actorId: string,
  chatClient: ChatClient,
  options: ChatWriteMcpOptions
): McpServer {
  const server = createMcpServer(
    { name: CHAT_WRITE_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );

  const isAllowed = (spaceName: string) => {
    if (!options.allowedSpaces || options.allowedSpaces.length === 0) return false;
    if (options.allowedSpaces.includes("*")) return true;
    return options.allowedSpaces.includes(spaceName);
  };

  const workDir = options.workDir ?? process.cwd();

  server.registerTool(
    "send_message",
    {
      title: "Send a Google Chat message",
      description:
        "Send a message to a space, optionally replying within an existing thread, with optional attachments (specified via filePath, attachmentDataRef, or inline base64).",
      inputSchema: {
        spaceName: z.string().describe("Space resource name, e.g. spaces/AAAA"),
        text: z.string(),
        threadName: z
          .string()
          .optional()
          .describe("Thread resource name to reply within; omit to start a new thread"),
        attachments: z
          .array(
            z.object({
              filePath: z
                .string()
                .optional()
                .describe(
                  "Path to a file inside your working directory to upload and attach, absolute or relative to it (preferred over contentBase64 to prevent corruption); paths outside the working directory are rejected"
                ),
              resourceName: z
                .string()
                .optional()
                .describe("Attachment resource name returned by upload_attachment"),
              attachmentDataRef: z
                .object({
                  resourceName: z.string(),
                })
                .optional()
                .describe("Attachment data ref object returned by upload_attachment"),
              contentBase64: z
                .string()
                .optional()
                .describe(
                  "Base64-encoded file contents to upload and attach inline (deprecated: prefer filePath)"
                ),
              filename: z
                .string()
                .optional()
                .describe(
                  "Filename for uploaded file (inferred from filePath if omitted, or defaults to attachment.bin)"
                ),
              mimeType: z
                .string()
                .optional()
                .describe("MIME type for uploaded file (inferred if omitted)"),
            })
          )
          .optional()
          .describe("Attachments to attach to this message"),
      },
    },
    async ({ spaceName, text, threadName, attachments }) => {
      try {
        if (!isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
        }
        const normalizedAttachments: Array<{
          attachmentDataRef: { resourceName: string };
          resourceName?: string;
        }> = [];
        if (attachments && attachments.length > 0) {
          for (const att of attachments) {
            if (att.attachmentDataRef?.resourceName) {
              normalizedAttachments.push({
                attachmentDataRef: { resourceName: att.attachmentDataRef.resourceName },
              });
            } else if (att.resourceName) {
              normalizedAttachments.push({
                attachmentDataRef: { resourceName: att.resourceName },
                resourceName: att.resourceName,
              });
            } else if (att.filePath) {
              const confinedPath = await resolveAttachmentPath(workDir, att.filePath);
              const maxBytes = options.maxAttachmentBytes ?? MAX_CHAT_ATTACHMENT_BYTES;
              const buf = await readFile(confinedPath);
              if (buf.length > maxBytes) {
                throw new Error(
                  `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
                );
              }
              const filename = att.filename || basename(att.filePath) || "attachment.bin";
              const mimeType = att.mimeType ?? inferChatMimeType(filename);
              const uploaded = await chatClient.uploadAttachment(
                spaceName,
                filename,
                buf,
                mimeType
              );
              normalizedAttachments.push(uploaded);
            } else if (att.contentBase64) {
              const maxBytes = options.maxAttachmentBytes ?? MAX_CHAT_ATTACHMENT_BYTES;
              const estimatedBytes = Math.ceil((att.contentBase64.length * 3) / 4);
              if (estimatedBytes > maxBytes + 4) {
                throw new Error(
                  `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
                );
              }
              const buf = Buffer.from(att.contentBase64, "base64");
              if (buf.length > maxBytes) {
                throw new Error(
                  `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
                );
              }
              const filename = att.filename || "attachment.bin";
              const mimeType = att.mimeType ?? inferChatMimeType(filename);
              const uploaded = await chatClient.uploadAttachment(
                spaceName,
                filename,
                buf,
                mimeType
              );
              normalizedAttachments.push(uploaded);
            }
          }
        }
        const res = await chatClient.send(spaceName, text, {
          ...(threadName ? { threadName } : {}),
          ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        });
        options.onWrite?.(actorId);
        return toolOk(res);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "upload_attachment",
    {
      title: "Upload a Google Chat attachment",
      description:
        "Upload a file as an attachment to an allowed space from disk (filePath, preferred) or inline base64 (contentBase64). Returns the attachmentDataRef to pass to send_message.",
      inputSchema: {
        spaceName: z.string().describe("Space resource name, e.g. spaces/AAAA"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Path to a file inside your working directory to upload, absolute or relative to it (preferred over contentBase64 to prevent corruption); paths outside the working directory are rejected"
          ),
        filename: z
          .string()
          .optional()
          .describe(
            "Filename for the attachment (e.g. report.pdf, output.png). Inferred from filePath if omitted."
          ),
        contentBase64: z
          .string()
          .optional()
          .describe("Base64-encoded file contents to upload (deprecated: prefer filePath)"),
        mimeType: z
          .string()
          .optional()
          .describe(
            "MIME type for the attachment (e.g. application/pdf, image/png). Inferred if omitted."
          ),
      },
    },
    async ({ spaceName, filePath, filename, contentBase64, mimeType }) => {
      try {
        if (!isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
        }
        const maxBytes = options.maxAttachmentBytes ?? MAX_CHAT_ATTACHMENT_BYTES;
        let contentBuffer: Buffer;
        let effectiveFilename: string;
        if (filePath) {
          const confinedPath = await resolveAttachmentPath(workDir, filePath);
          contentBuffer = await readFile(confinedPath);
          if (contentBuffer.length > maxBytes) {
            throw new Error(
              `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
            );
          }
          effectiveFilename = filename || basename(filePath) || "attachment.bin";
        } else if (contentBase64) {
          const estimatedBytes = Math.ceil((contentBase64.length * 3) / 4);
          if (estimatedBytes > maxBytes + 4) {
            throw new Error(
              `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
            );
          }
          contentBuffer = Buffer.from(contentBase64, "base64");
          if (contentBuffer.length > maxBytes) {
            throw new Error(
              `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
            );
          }
          effectiveFilename = filename || "attachment.bin";
        } else {
          throw new Error("Either filePath or contentBase64 must be provided");
        }

        const effectiveMime = mimeType ?? inferChatMimeType(effectiveFilename);
        const res = await chatClient.uploadAttachment(
          spaceName,
          effectiveFilename,
          contentBuffer,
          effectiveMime
        );
        options.onWrite?.(actorId);
        return toolOk(res);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "react",
    {
      title: "React to a Google Chat message",
      description: "Add an emoji reaction (default 👀) to a message.",
      inputSchema: {
        messageName: z.string().describe("Message resource name, e.g. spaces/A/messages/B"),
        emoji: z.string().optional().describe("Unicode emoji; defaults to 👀"),
      },
    },
    async ({ messageName, emoji }) => {
      try {
        const match = /^spaces\/([^/]+)/.exec(messageName);
        if (!match) {
          throw new Error("access denied: messageName must be in format spaces/SPACE/messages/MSG");
        }
        const spaceName = `spaces/${match[1]}`;
        if (!isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
        }
        await chatClient.react(messageName, emoji);
        options.onWrite?.(actorId);
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
