import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import mime from "mime";
import { z } from "zod";
import { generateHandle } from "../actor/handle-generator.js";
import { isGchatThreadHead } from "../actor/inbox-hints.js";
import {
  type ChatClient,
  type ChatSpace,
  MAX_CHAT_ATTACHMENT_BYTES,
  MEDIA_TOKEN_RE,
  MESSAGE_ATTACHMENT_NAME_RE,
} from "../chat/types.js";
import type { Logger } from "../observability/logger.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { formatVisibleActorSignature } from "./actor-signature.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const CHAT_WRITE_MCP_NAME = "chat-write";
export const CHAT_READ_MCP_NAME = "chat-read";

export function inferChatMimeType(filename: string): string {
  return mime.getType(filename) ?? "application/octet-stream";
}

export interface ChatReadMcpOptions {
  allowedSpaces?: string[];
  isFenced?: () => boolean;
  maxAttachmentBytes?: number;
}

/** Read-only Google Chat tools, mounted for root or granted to space-scoped actors. */
export function createChatReadMcpServer(
  chatClient: ChatClient,
  options?: ChatReadMcpOptions
): McpServer {
  const server = createMcpServer(
    { name: CHAT_READ_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  const isAllowed = (spaceName: string) => {
    if (!options?.allowedSpaces || options.allowedSpaces.length === 0) return true;
    if (options.allowedSpaces.includes("*")) return true;
    return options.allowedSpaces.includes(spaceName);
  };

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
        const spaceMatch = /^spaces\/([^/]+)/.exec(messageName);
        const spaceName = spaceMatch ? `spaces/${spaceMatch[1]}` : "";
        if (!isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
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
            "Attachment resource name in format spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT"
          ),
      },
    },
    async ({ attachmentName }) => {
      try {
        if (!MESSAGE_ATTACHMENT_NAME_RE.test(attachmentName)) {
          throw new Error(
            "attachmentName must be in format spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT"
          );
        }
        const spaceMatch = /^spaces\/([^/]+)/.exec(attachmentName);
        const spaceName = spaceMatch ? `spaces/${spaceMatch[1]}` : "";
        if (spaceName && !isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
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
      description:
        "Download an attachment's raw bytes and return them as a base64-encoded string. For space-scoped actors, requires the attachment resource name (spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT); unscoped servers also accept opaque media tokens (media/...).",
      inputSchema: {
        resourceName: z
          .string()
          .describe(
            "Attachment resource name in format spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT (or media/... token for unscoped servers)"
          ),
      },
    },
    async ({ resourceName }) => {
      try {
        if (!MESSAGE_ATTACHMENT_NAME_RE.test(resourceName) && !MEDIA_TOKEN_RE.test(resourceName)) {
          throw new Error(
            "resourceName must be in format spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT or media/..."
          );
        }
        const isScoped =
          options?.allowedSpaces &&
          options.allowedSpaces.length > 0 &&
          !options.allowedSpaces.includes("*");
        if (isScoped && resourceName.startsWith("media/")) {
          throw new Error(
            "access denied: raw media/ tokens are not permitted for space-scoped chat-read; specify the attachment resource name (spaces/SPACE/messages/MESSAGE/attachments/ATTACHMENT)"
          );
        }
        const spaceMatch = /^spaces\/([^/]+)/.exec(resourceName);
        const spaceName = spaceMatch ? `spaces/${spaceMatch[1]}` : "";
        if (spaceName && !isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
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
        if (
          options?.allowedSpaces &&
          options.allowedSpaces.length > 0 &&
          !options.allowedSpaces.includes("*")
        ) {
          const matchedSpaces: ChatSpace[] = [];
          let currentToken = pageToken;
          do {
            const page = await chatClient.listSpaces({
              ...(pageSize !== undefined ? { pageSize } : {}),
              ...(currentToken ? { pageToken: currentToken } : {}),
            });
            for (const s of page.spaces ?? []) {
              if (isAllowed(s.name)) {
                matchedSpaces.push(s);
              }
            }
            currentToken = page.nextPageToken;
          } while (currentToken && matchedSpaces.length < options.allowedSpaces.length);
          return toolOk({
            spaces: matchedSpaces,
          });
        }
        const result = await chatClient.listSpaces({
          ...(pageSize !== undefined ? { pageSize } : {}),
          ...(pageToken ? { pageToken } : {}),
        });
        return toolOk(result);
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
        if (!isAllowed(spaceName)) {
          throw new Error(`access denied: space ${spaceName} is not in allowed spaces`);
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
  /** Display name for this actor's visible Chat footer. */
  actorHandle?: string;
  /** The exact normalized selection for the provider attempt currently writing. */
  getRunSelection?: () => RawProviderModelConfig | undefined;
  onWrite?: (actorId: string) => void;
  isFenced?: () => boolean;
  maxAttachmentBytes?: number;
  /** Directory attachment `filePath`s are confined to; defaults to `process.cwd()`. */
  workDir?: string;
  /** Currently selected inbox entries for this run, used to deterministically enforce reply routing (#611). */
  selectedInboxEntries?: readonly InboxEntry[] | (() => readonly InboxEntry[]);
  /** Optional structured logger for reply routing diagnostics. */
  logger?: Logger;
}

function extractChatSpace(entry: InboxEntry): string | undefined {
  const payload = entry.payload;
  if (typeof payload?.spaceName === "string" && payload.spaceName.trim().length > 0) {
    return payload.spaceName.trim();
  }
  if (typeof payload?.threadName === "string" && payload.threadName.includes("/threads/")) {
    return payload.threadName.trim().split("/threads/")[0];
  }
  if (typeof entry.source === "string" && entry.source.startsWith("chat_space:")) {
    return entry.source.slice("chat_space:".length).trim();
  }
  return undefined;
}

/**
 * Mechanically resolves outbound Google Chat thread placement based on the
 * actor's selected inbox work (#611).
 *
 * - A selected top-level Google Chat message replies top-level (omitting threadName)
 *   unless explicitly requested to create a thread via `createThread: true`.
 * - A selected reply in an existing thread responds in that same thread.
 * - Supplying a threadName that does not match any selected entry in this space is
 *   preserved as an intentional send to a different thread.
 * - When multiple chat entries in this space disagree or are mixed, omitting threadName
 *   leaves routing untouched rather than guessing.
 */
export function resolveChatReplyThreadName(
  spaceName: string,
  callerThreadName: string | undefined,
  createThread: boolean | undefined,
  selectedEntries: readonly InboxEntry[] | undefined,
  logger?: Logger
): string | undefined {
  if (!selectedEntries || selectedEntries.length === 0) {
    return callerThreadName;
  }

  // Find all selected chat entries belonging to spaceName
  const matchingEntries = selectedEntries.filter((entry) => {
    if (entry.payload?.type === "gchat.message" || entry.source?.startsWith("chat_space:")) {
      return extractChatSpace(entry) === spaceName;
    }
    return false;
  });

  if (matchingEntries.length === 0) {
    return callerThreadName;
  }

  const parsedEntries = matchingEntries.map((entry) => {
    const payload = entry.payload;
    const messageName =
      typeof payload?.messageName === "string" && payload.messageName.trim().length > 0
        ? payload.messageName.trim()
        : undefined;
    const threadName =
      typeof payload?.threadName === "string" && payload.threadName.trim().length > 0
        ? payload.threadName.trim()
        : undefined;
    const isExistingThread =
      typeof threadName === "string" &&
      threadName.length > 0 &&
      !isGchatThreadHead(messageName, threadName);
    const isThreadHead = !isExistingThread;
    return { entry, messageName, threadName, isThreadHead, isExistingThread };
  });

  const trimmedCallerThread =
    typeof callerThreadName === "string" && callerThreadName.trim().length > 0
      ? callerThreadName.trim()
      : undefined;

  // If caller explicitly requested to create a thread under a selected top-level message
  if (createThread === true) {
    const topLevelEntries = parsedEntries.filter((e) => e.isThreadHead && e.threadName);
    if (topLevelEntries.length === 1 && topLevelEntries[0]?.threadName) {
      const headThread = topLevelEntries[0].threadName;
      if (trimmedCallerThread && trimmedCallerThread !== headThread) {
        logger?.info("chat_reply_thread_overridden", {
          spaceName,
          callerThreadName: trimmedCallerThread,
          effectiveThreadName: headThread,
          reason: "create_thread_under_selected_head",
        });
      }
      return headThread;
    }
    if (topLevelEntries.length > 1) {
      const firstThread = topLevelEntries[0]?.threadName;
      if (firstThread && topLevelEntries.every((e) => e.threadName === firstThread)) {
        if (trimmedCallerThread && trimmedCallerThread !== firstThread) {
          logger?.info("chat_reply_thread_overridden", {
            spaceName,
            callerThreadName: trimmedCallerThread,
            effectiveThreadName: firstThread,
            reason: "create_thread_under_selected_head",
          });
        }
        return firstThread;
      }
      logger?.warn("chat_reply_ambiguous_create_thread", {
        spaceName,
        matchingCount: topLevelEntries.length,
      });
      return trimmedCallerThread;
    }
    return trimmedCallerThread;
  }

  // Case 1: Caller specified a threadName
  if (trimmedCallerThread !== undefined) {
    const matchingTargets = parsedEntries.filter((e) => e.threadName === trimmedCallerThread);
    // A selected top-level message and a later reply can share one thread
    // handle. For an explicit handle, retain the in-thread intent regardless
    // of selection order; only a head-only match replies top-level.
    const matchingTarget = matchingTargets.find((e) => e.isExistingThread) ?? matchingTargets[0];

    if (!matchingTarget) {
      // Caller deliberately targeted a different thread not in the current selection.
      // Preserve callerThreadName without overriding it.
      return trimmedCallerThread;
    }

    if (matchingTarget.isThreadHead) {
      // Caller passed the top-level message's thread handle without createThread: true.
      // Mechanically strip threadName to reply top-level (#611).
      logger?.info("chat_reply_thread_overridden", {
        spaceName,
        callerThreadName: trimmedCallerThread,
        effectiveThreadName: undefined,
        reason: "selected_toplevel_message",
      });
      return undefined;
    }

    // Selected entry is an existing thread reply and matches caller's thread.
    return matchingTarget.threadName;
  }

  // Case 2: Caller omitted threadName
  // All entries are top-level messages -> reply top-level (omit threadName)
  if (parsedEntries.every((e) => e.isThreadHead)) {
    return undefined;
  }

  // All entries are in the same existing thread -> reply in that thread
  const firstThread = parsedEntries[0]?.threadName;
  if (
    firstThread &&
    parsedEntries.every((e) => e.isExistingThread && e.threadName === firstThread)
  ) {
    logger?.info("chat_reply_assigned_thread", {
      spaceName,
      effectiveThreadName: firstThread,
      reason: "selected_thread_entry",
    });
    return firstThread;
  }

  // Ambiguous: mixed or disagreeing selected entries in this space.
  logger?.warn("chat_reply_ambiguous_selection", {
    spaceName,
    matchingCount: parsedEntries.length,
  });
  return undefined;
}

/** Add the terminal Chat footer unless the caller already supplied this exact one. */
function appendVisibleActorSignature(body: string, signature: string): string {
  const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailingSignature = new RegExp(`(?:^|\\r?\\n)${escapedSignature}[\\t ]*(?:\\r?\\n)?$`);
  return trailingSignature.test(body) ? body : body ? `${body}\n\n${signature}` : signature;
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

  const actorHandle = options.actorHandle ?? generateHandle(actorId);
  const signedText = (text: string) =>
    appendVisibleActorSignature(
      text,
      formatVisibleActorSignature(actorHandle, options.getRunSelection?.(), "google-chat")
    );
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
          .describe(
            "Thread resource name to reply within. If an inbox entry is selected for this space, reply routing automatically targets that message/thread: top-level entries reply top-level (threadName omitted), and in-thread entries reply in-thread (threadName filled in). Supplying a different existing thread targets that thread."
          ),
        createThread: z
          .boolean()
          .optional()
          .describe(
            "When replying to a selected top-level message, set to true to explicitly create a new thread under it instead of replying top-level. Has no effect if no top-level message is selected."
          ),
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
    async ({ spaceName, text, threadName, createThread, attachments }) => {
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
        const selectedEntries =
          typeof options.selectedInboxEntries === "function"
            ? options.selectedInboxEntries()
            : options.selectedInboxEntries;
        const effectiveThreadName = resolveChatReplyThreadName(
          spaceName,
          threadName,
          createThread,
          selectedEntries,
          options.logger
        );
        const res = await chatClient.send(spaceName, signedText(text), {
          ...(effectiveThreadName ? { threadName: effectiveThreadName } : {}),
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
