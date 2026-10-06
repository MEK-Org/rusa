import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type DriveClient,
  MAX_DRIVE_FILE_DOWNLOAD_BYTES,
  MAX_DRIVE_FILE_INLINE_BYTES,
} from "../drive/drive-client.js";
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
  maxDownloadBytes?: number;
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

  const checkFileAccess = async (fileId: string) => {
    if (!options.allowedFolders || options.allowedFolders.length === 0) return;
    const meta = await client.getFileMetadata(fileId);
    const parents = meta.parents ?? [];
    const isAllowed = parents.some((p) => options.allowedFolders.includes(p));
    if (!isAllowed) {
      throw new Error(`access denied: file ${fileId} does not belong to allowed folders`);
    }
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
        "Download a file's raw bytes. Returns base64 inline (up to 50 MiB), or streams to destinationPath inside your working directory (up to 1 GiB).",
      inputSchema: {
        fileId: z.string().describe("The ID of the file to download"),
        destinationPath: z
          .string()
          .optional()
          .describe(
            "Optional file path inside your working directory to stream the file to disk instead of returning base64. Required for files larger than 50 MiB (up to 1 GiB). Unavailable for follower-hosted actors (see #812)."
          ),
      },
    },
    async ({ fileId, destinationPath }) => {
      try {
        await checkFileAccess(fileId);

        const inlineLimit = Math.min(
          options.maxDownloadBytes ?? MAX_DRIVE_FILE_INLINE_BYTES,
          MAX_DRIVE_FILE_INLINE_BYTES
        );
        const fileLimit = Math.min(
          options.maxDownloadBytes ?? MAX_DRIVE_FILE_DOWNLOAD_BYTES,
          MAX_DRIVE_FILE_DOWNLOAD_BYTES
        );

        if (!destinationPath) {
          if (client.downloadFileStream) {
            const resp = await client.downloadFileStream(fileId);
            const contentLength = resp.headers.get("content-length");
            if (contentLength && parseInt(contentLength, 10) > inlineLimit) {
              await resp.body?.cancel().catch(() => {});
              throw new Error(
                `file size limit exceeded: file is larger than ${inlineLimit} bytes; specify destinationPath to download up to 1 GiB to a file in your workdir`
              );
            }
            try {
              const chunks: Uint8Array[] = [];
              let totalSize = 0;
              const body = resp.body;
              if (
                body &&
                typeof (body as unknown as AsyncIterable<Uint8Array | string>)[
                  Symbol.asyncIterator
                ] === "function"
              ) {
                for await (const chunk of body as unknown as AsyncIterable<Uint8Array | string>) {
                  const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                  totalSize += buf.byteLength;
                  if (totalSize > inlineLimit) {
                    await resp.body?.cancel().catch(() => {});
                    throw new Error(
                      `file size limit exceeded: file is larger than ${inlineLimit} bytes; specify destinationPath to download up to 1 GiB to a file in your workdir`
                    );
                  }
                  chunks.push(buf);
                }
              }
              const result = Buffer.concat(chunks);
              options.onRead?.(actorId, { operation: "download_file", fileId });
              return toolOk(result.toString("base64"));
            } catch (err: unknown) {
              await resp.body?.cancel().catch(() => {});
              if (err instanceof Error && err.message.includes("file size limit exceeded")) {
                throw new Error(
                  `file size limit exceeded: file is larger than ${inlineLimit} bytes; specify destinationPath to download up to 1 GiB to a file in your workdir`
                );
              }
              throw err;
            }
          } else {
            try {
              const result = await client.downloadFile(fileId, inlineLimit);
              if (result.length > inlineLimit) {
                throw new Error(
                  `file size limit exceeded: file is larger than ${inlineLimit} bytes; specify destinationPath to download up to 1 GiB to a file in your workdir`
                );
              }
              options.onRead?.(actorId, { operation: "download_file", fileId });
              return toolOk(result.toString("base64"));
            } catch (err: unknown) {
              if (err instanceof Error && err.message.includes("file size limit exceeded")) {
                throw new Error(
                  `file size limit exceeded: file is larger than ${inlineLimit} bytes; specify destinationPath to download up to 1 GiB to a file in your workdir`
                );
              }
              throw err;
            }
          }
        }

        requireFileToolsAvailable(options);
        const workDir = requireWorkDir(options);
        const target = await resolveDownloadPath(workDir, destinationPath);

        const meta = await client.getFileMetadata(fileId);
        if (meta.size && parseInt(meta.size, 10) > fileLimit) {
          throw new Error(`file size limit exceeded: file is larger than ${fileLimit} bytes`);
        }

        const name = meta.name;
        let contentType = meta.mimeType || "application/octet-stream";

        if (client.downloadFileStream) {
          const resp = await client.downloadFileStream(fileId);
          const contentLength = resp.headers.get("content-length");
          if (contentLength && parseInt(contentLength, 10) > fileLimit) {
            await resp.body?.cancel().catch(() => {});
            throw new Error(`file size limit exceeded: file is larger than ${fileLimit} bytes`);
          }
          const headerType = resp.headers.get("content-type");
          if (headerType) {
            contentType = meta.mimeType || headerType;
          }
          if (!resp.body) {
            throw new Error("response body is not readable");
          }
          const { bytes, sha256 } = await streamNewFileInWorkdir(
            workDir,
            target,
            resp.body,
            fileLimit,
            "file"
          );
          options.onRead?.(actorId, { operation: "download_file", fileId });
          return toolOk({
            path: target,
            bytes,
            sha256,
            contentType,
            name,
          });
        } else {
          const buf = await client.downloadFile(fileId, fileLimit);
          if (buf.length > fileLimit) {
            throw new Error(`file size limit exceeded: file is larger than ${fileLimit} bytes`);
          }
          const { bytes, sha256 } = await streamNewFileInWorkdir(
            workDir,
            target,
            [buf],
            fileLimit,
            "file"
          );
          options.onRead?.(actorId, { operation: "download_file", fileId });
          return toolOk({
            path: target,
            bytes,
            sha256,
            contentType: meta.mimeType || "application/octet-stream",
            name: meta.name,
          });
        }
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
