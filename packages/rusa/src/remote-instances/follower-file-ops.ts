import { existsSync } from "node:fs";
import { join } from "node:path";
import { GchatClient } from "../chat/gchat-client.js";
import {
  type ChatClient,
  MAX_CHAT_ATTACHMENT_DOWNLOAD_BYTES,
  MEDIA_TOKEN_RE,
  MESSAGE_ATTACHMENT_NAME_RE,
} from "../chat/types.js";
import { type DriveClient, GoogleDriveClient } from "../drive/drive-client.js";
import { resolveDownloadPath, streamNewFileInWorkdir } from "../mcp/workdir-path.js";
import type { FollowerFileOps } from "./follower-instance.js";
import type { FollowerFileOperation, FollowerFileOperationResult } from "./protocol.js";

export interface FollowerFileOpsOptions {
  /** This follower's own Google OAuth directory (client.json, token.json, drive-token.json). */
  credentialDir: string;
  chatClient?: (credentialDir: string) => Pick<ChatClient, "downloadAttachmentStream">;
  driveClient?: (credentialDir: string) => Pick<DriveClient, "downloadFileStream">;
}

const CHAT_CREDENTIALS = ["client.json", "token.json"];
const DRIVE_CREDENTIALS = ["client.json", "drive-token.json"];

function requireCredentials(credentialDir: string, provider: string, files: string[]): void {
  const missing = files.filter((file) => !existsSync(join(credentialDir, file)));
  if (missing.length) {
    throw new Error(
      `this follower has no Google ${provider} credentials: missing ${missing.join(", ")}`
    );
  }
}

/**
 * The follower half of #1013: run a download the leader has authorized with
 * this follower's own credentials, writing a new file inside the actor's
 * working directory. The leader's operation is re-validated here, since this
 * process writes the bytes; a missing credential is an explicit refusal.
 */
export function createFollowerFileOps(options: FollowerFileOpsOptions): FollowerFileOps {
  const chatClient = options.chatClient ?? ((dir) => new GchatClient(dir));
  const driveClient = options.driveClient ?? ((dir) => new GoogleDriveClient(dir));
  return async (
    workDir,
    operation: FollowerFileOperation
  ): Promise<FollowerFileOperationResult> => {
    if (typeof operation?.destinationPath !== "string") throw new Error("invalid destinationPath");
    switch (operation.kind) {
      case "chatAttachmentDownload": {
        const { resourceName, destinationPath, maxBytes } = operation;
        if (
          typeof resourceName !== "string" ||
          (!MESSAGE_ATTACHMENT_NAME_RE.test(resourceName) && !MEDIA_TOKEN_RE.test(resourceName))
        ) {
          throw new Error("invalid Chat attachment resource name");
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
          throw new Error("invalid Chat attachment byte limit");
        }
        requireCredentials(options.credentialDir, "Chat", CHAT_CREDENTIALS);
        const target = await resolveDownloadPath(workDir, destinationPath);
        const { resp, name, contentType } = await chatClient(
          options.credentialDir
        ).downloadAttachmentStream(
          resourceName,
          Math.min(maxBytes, MAX_CHAT_ATTACHMENT_DOWNLOAD_BYTES)
        );
        const { bytes, sha256 } = await streamNewFileInWorkdir(workDir, target, resp.body);
        return { path: target, bytes, sha256, name, contentType };
      }
      case "driveFileDownload": {
        const { fileId, destinationPath } = operation;
        if (typeof fileId !== "string" || !fileId) throw new Error("invalid Drive file ID");
        requireCredentials(options.credentialDir, "Drive", DRIVE_CREDENTIALS);
        const target = await resolveDownloadPath(workDir, destinationPath);
        const resp = await driveClient(options.credentialDir).downloadFileStream(fileId);
        const { bytes, sha256 } = await streamNewFileInWorkdir(workDir, target, resp.body);
        const contentType = resp.headers.get("content-type");
        return { path: target, bytes, sha256, ...(contentType ? { contentType } : {}) };
      }
      default:
        throw new Error("unsupported file operation");
    }
  };
}
