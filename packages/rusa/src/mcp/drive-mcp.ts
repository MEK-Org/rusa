import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DriveClient, DriveFileMetadata } from "../drive/drive-client.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";
import { resolveDownloadPath, streamNewFileInWorkdir } from "./workdir-path.js";

export const DRIVE_READ_MCP_NAME = "drive-read";

export interface DriveReadObservation {
  operation: "list_children" | "get_file_metadata" | "download_file" | "export_doc";
  folderId?: string;
  fileId?: string;
  recursive?: boolean;
  mimeType?: string;
}

export interface DriveReadMcpOptions {
  allowedFolders: string[];
  onRead?: (actorId: string, observation: DriveReadObservation) => void;
  workDir?: string;
  fileToolsAvailable?: boolean | (() => boolean);
}

function requireWorkDir(options: DriveReadMcpOptions): string {
  if (!options.workDir) throw new Error("Drive file tools need an actor workdir");
  return options.workDir;
}

function requireFileToolsAvailable(options: DriveReadMcpOptions): void {
  const available =
    typeof options.fileToolsAvailable === "function"
      ? options.fileToolsAvailable()
      : options.fileToolsAvailable;
  if (available === false) {
    throw new Error("Drive file tools are unavailable for follower-hosted actors (see #812)");
  }
}

/** Read-only Google Drive tools whose authorization is enforced at the server boundary. */
export function createDriveReadMcpServer(
  actorId: string,
  client: DriveClient,
  options: DriveReadMcpOptions
): McpServer {
  const server = createMcpServer({ name: DRIVE_READ_MCP_NAME, version: "0.1.0" });

  const checkFolderAccess = (folderId: string) => {
    if (!options.allowedFolders || options.allowedFolders.length === 0) return;
    if (!options.allowedFolders.includes(folderId)) {
      throw new Error(`access denied: folder ${folderId} is not in allowed folders`);
    }
  };

  const checkFileAccess = async (fileId: string): Promise<DriveFileMetadata | undefined> => {
    if (!options.allowedFolders || options.allowedFolders.length === 0) return undefined;
    const meta = await client.getFileMetadata(fileId);
    const parents = meta.parents ?? [];
    const isAllowed = parents.some((p) => options.allowedFolders.includes(p));
    if (!isAllowed) {
      throw new Error(`access denied: file ${fileId} does not belong to allowed folders`);
    }
    return meta;
  };

  server.registerTool(
    "list_children",
    {
      title: "List children of a folder",
      description:
        "Enumerate every file and folder that is a direct child of the specified folder ID. Set recursive=true to recursively list subfolders.",
      inputSchema: {
        folderId: z.string().describe("The ID of the folder to list"),
        recursive: z.boolean().optional().describe("Whether to walk child folders recursively"),
      },
    },
    async ({ folderId, recursive }) => {
      try {
        checkFolderAccess(folderId);
        const result = await client.listChildren(folderId, recursive);
        options.onRead?.(actorId, { operation: "list_children", folderId, recursive });
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_file_metadata",
    {
      title: "Get file metadata",
      description: "Read metadata for one file or folder by its Google Drive ID.",
      inputSchema: {
        fileId: z.string().describe("The ID of the file or folder to inspect"),
      },
    },
    async ({ fileId }) => {
      try {
        await checkFileAccess(fileId);
        const result = await client.getFileMetadata(fileId);
        options.onRead?.(actorId, { operation: "get_file_metadata", fileId });
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "download_file",
    {
      title: "Download a file's binary contents",
      description:
        "Stream a file to destinationPath inside your working directory (up to 1 GiB) and return its path, byte count, SHA-256, content type, and name.",
      inputSchema: {
        fileId: z.string().describe("The ID of the file to download"),
        destinationPath: z
          .string()
          .describe(
            "New file path inside your working directory for the streamed file. Unavailable for follower-hosted actors (see #812)."
          ),
      },
    },
    async ({ fileId, destinationPath }) => {
      try {
        const authorizedMeta = await checkFileAccess(fileId);

        requireFileToolsAvailable(options);
        const workDir = requireWorkDir(options);
        const target = await resolveDownloadPath(workDir, destinationPath);
        const meta = authorizedMeta ?? (await client.getFileMetadata(fileId));
        const resp = await client.downloadFileStream(fileId);
        const { bytes, sha256 } = await streamNewFileInWorkdir(workDir, target, resp.body);
        options.onRead?.(actorId, { operation: "download_file", fileId });
        return toolOk({
          path: target,
          bytes,
          sha256,
          contentType:
            meta.mimeType || resp.headers.get("content-type") || "application/octet-stream",
          name: meta.name,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "export_doc",
    {
      title: "Export a Google Docs editor file to a portable format",
      description:
        "Export a Google-native document (Doc, Sheet, or Slide) to a specified MIME type (e.g. application/pdf, text/plain, text/csv) and return the contents as a base64-encoded string.",
      inputSchema: {
        fileId: z.string().describe("The ID of the Google-native document to export"),
        mimeType: z
          .string()
          .describe("The target MIME type (e.g., application/pdf, text/csv, text/plain)"),
      },
    },
    async ({ fileId, mimeType }) => {
      try {
        await checkFileAccess(fileId);
        const result = await client.exportDoc(fileId, mimeType);
        options.onRead?.(actorId, { operation: "export_doc", fileId, mimeType });
        return toolOk(result.toString("base64"));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
