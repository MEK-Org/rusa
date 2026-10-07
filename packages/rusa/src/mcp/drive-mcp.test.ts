import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  type DriveClient,
  GoogleDriveClient,
  MAX_DRIVE_FILE_DOWNLOAD_BYTES,
  MAX_DRIVE_FILE_INLINE_BYTES,
} from "../drive/drive-client.js";
import { createDriveReadMcpServer, type DriveReadObservation } from "./drive-mcp.js";

function fakeDriveClient() {
  const calls: Array<{ method: string; id: string; recursive?: boolean; mimeType?: string }> = [];
  const client: DriveClient = {
    listChildren: async (folderId, recursive) => {
      calls.push({ method: "listChildren", id: folderId, recursive });
      if (folderId === "error-folder") throw new Error("Google API error");
      return [
        {
          id: "file-1",
          name: "Document 1",
          mimeType: "application/vnd.google-apps.document",
          parents: [folderId],
        },
        {
          id: "folder-2",
          name: "Subfolder 2",
          mimeType: "application/vnd.google-apps.folder",
          parents: [folderId],
        },
      ];
    },
    getFileMetadata: async (fileId) => {
      calls.push({ method: "getFileMetadata", id: fileId });
      if (fileId === "error-file") throw new Error("Google API error");
      if (fileId === "unauthorized-file") {
        return {
          id: fileId,
          name: "Secret Document",
          mimeType: "application/vnd.google-apps.document",
          parents: ["unauthorized-folder"],
        };
      }
      return {
        id: fileId,
        name: "Mock File",
        mimeType: "application/vnd.google-apps.document",
        parents: ["allowed-folder"],
      };
    },
    downloadFile: async (fileId) => {
      calls.push({ method: "downloadFile", id: fileId });
      if (fileId === "error-file") throw new Error("Google API error");
      return Buffer.from("mock-binary-data");
    },
    exportDoc: async (fileId, mimeType) => {
      calls.push({ method: "exportDoc", id: fileId, mimeType });
      if (fileId === "error-file") throw new Error("Google API error");
      return Buffer.from("mock-exported-pdf");
    },
  };
  return { client, calls };
}

async function connect(
  driveClient: DriveClient,
  allowedFolders: string[],
  options: {
    onRead?: (actorId: string, observation: DriveReadObservation) => void;
    workDir?: string;
    fileToolsAvailable?: boolean | (() => boolean);
    maxDownloadBytes?: number;
  } = {}
) {
  const server = createDriveReadMcpServer("actor-1", driveClient, {
    allowedFolders,
    onRead: options.onRead,
    workDir: options.workDir,
    fileToolsAvailable: options.fileToolsAvailable,
    maxDownloadBytes: options.maxDownloadBytes,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("drive-read MCP server", () => {
  it("exposes all read-only drive tools", async () => {
    const fake = fakeDriveClient();
    const client = await connect(fake.client, []);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "download_file",
      "export_doc",
      "get_file_metadata",
      "list_children",
    ]);
  });

  it("handles the drive-wide happy path (empty allowedFolders)", async () => {
    const fake = fakeDriveClient();
    const onRead = vi.fn();
    const client = await connect(fake.client, [], { onRead });

    const listRes = (await client.callTool({
      name: "list_children",
      arguments: { folderId: "root-folder", recursive: true },
    })) as CallToolResult;

    const metaRes = (await client.callTool({
      name: "get_file_metadata",
      arguments: { fileId: "file-1" },
    })) as CallToolResult;

    const downloadRes = (await client.callTool({
      name: "download_file",
      arguments: { fileId: "file-1" },
    })) as CallToolResult;

    const exportRes = (await client.callTool({
      name: "export_doc",
      arguments: { fileId: "file-1", mimeType: "application/pdf" },
    })) as CallToolResult;

    expect(listRes.isError).toBeFalsy();
    expect(metaRes.isError).toBeFalsy();
    expect(downloadRes.isError).toBeFalsy();
    expect(exportRes.isError).toBeFalsy();

    expect(JSON.parse(textOf(listRes))).toHaveLength(2);
    expect(JSON.parse(textOf(metaRes)).name).toBe("Mock File");
    expect(textOf(downloadRes)).toBe(Buffer.from("mock-binary-data").toString("base64"));
    expect(textOf(exportRes)).toBe(Buffer.from("mock-exported-pdf").toString("base64"));

    expect(fake.calls).toEqual([
      { method: "listChildren", id: "root-folder", recursive: true },
      { method: "getFileMetadata", id: "file-1" },
      { method: "downloadFile", id: "file-1" },
      { method: "exportDoc", id: "file-1", mimeType: "application/pdf" },
    ]);

    expect(onRead.mock.calls).toEqual([
      ["actor-1", { operation: "list_children", folderId: "root-folder", recursive: true }],
      ["actor-1", { operation: "get_file_metadata", fileId: "file-1" }],
      ["actor-1", { operation: "download_file", fileId: "file-1" }],
      ["actor-1", { operation: "export_doc", fileId: "file-1", mimeType: "application/pdf" }],
    ]);
  });

  it("handles the drive-wide error paths", async () => {
    const fake = fakeDriveClient();
    const client = await connect(fake.client, []);

    const listRes = (await client.callTool({
      name: "list_children",
      arguments: { folderId: "error-folder" },
    })) as CallToolResult;

    const metaRes = (await client.callTool({
      name: "get_file_metadata",
      arguments: { fileId: "error-file" },
    })) as CallToolResult;

    expect(listRes.isError).toBeTruthy();
    expect(textOf(listRes)).toContain("Google API error");
    expect(metaRes.isError).toBeTruthy();
    expect(textOf(metaRes)).toContain("Google API error");
  });

  describe("capability-gated path-scoped access", () => {
    it("allows access to folder matching the allowed list", async () => {
      const fake = fakeDriveClient();
      const client = await connect(fake.client, ["allowed-folder"]);

      const listRes = (await client.callTool({
        name: "list_children",
        arguments: { folderId: "allowed-folder" },
      })) as CallToolResult;

      const metaRes = (await client.callTool({
        name: "get_file_metadata",
        arguments: { fileId: "file-1" },
      })) as CallToolResult;

      expect(listRes.isError).toBeFalsy();
      expect(metaRes.isError).toBeFalsy();
    });

    it("denies access to folder not in the allowed list", async () => {
      const fake = fakeDriveClient();
      const client = await connect(fake.client, ["allowed-folder"]);

      const listRes = (await client.callTool({
        name: "list_children",
        arguments: { folderId: "unauthorized-folder" },
      })) as CallToolResult;

      const metaRes = (await client.callTool({
        name: "get_file_metadata",
        arguments: { fileId: "unauthorized-file" },
      })) as CallToolResult;

      expect(listRes.isError).toBeTruthy();
      expect(textOf(listRes)).toContain("access denied");
      expect(metaRes.isError).toBeTruthy();
      expect(textOf(metaRes)).toContain("access denied");
    });
  });

  describe("oversized response size limit handling", () => {
    it("returns error on download when file size limit is exceeded", async () => {
      const fake = fakeDriveClient();
      fake.client.downloadFile = async (_fileId) => {
        throw new Error("file size limit exceeded: file is larger than 5 bytes");
      };
      const client = await connect(fake.client, []);

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1" },
      })) as CallToolResult;

      expect(result.isError).toBeTruthy();
      expect(textOf(result)).toContain("file size limit exceeded");
    });

    it("returns error on export when exported file size limit is exceeded", async () => {
      const fake = fakeDriveClient();
      fake.client.exportDoc = async (_fileId, _mimeType) => {
        throw new Error("file size limit exceeded: file is larger than 5 bytes");
      };
      const client = await connect(fake.client, []);

      const result = (await client.callTool({
        name: "export_doc",
        arguments: { fileId: "file-1", mimeType: "application/pdf" },
      })) as CallToolResult;

      expect(result.isError).toBeTruthy();
      expect(textOf(result)).toContain("file size limit exceeded");
    });

    it("bounds inline downloads at 50 MiB and directs larger ones to destinationPath", async () => {
      const fake = fakeDriveClient();
      let requested: number | undefined;
      fake.client.downloadFile = async (_fileId, maxBytes) => {
        requested = maxBytes;
        throw new Error(`file size limit exceeded: file is larger than ${maxBytes} bytes`);
      };
      const client = await connect(fake.client, []);

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1" },
      })) as CallToolResult;

      expect(requested).toBe(MAX_DRIVE_FILE_INLINE_BYTES);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("file size limit exceeded");
      expect(textOf(result)).toContain("specify destinationPath to download up to 1 GiB");
    });

    it("asks the client stream for the 1 GiB file-mode limit", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      fake.client.getFileMetadata = async (fileId) => ({
        id: fileId,
        name: "small.bin",
        mimeType: "application/octet-stream",
        size: "5",
      });
      let requested: number | undefined;
      fake.client.downloadFileStream = async (_fileId, maxBytes) => {
        requested = maxBytes;
        return new Response("hello", { status: 200 });
      };
      const client = await connect(fake.client, [], { workDir, fileToolsAvailable: true });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(requested).toBe(MAX_DRIVE_FILE_DOWNLOAD_BYTES);
      expect(JSON.parse(textOf(result))).toMatchObject({
        path: join(workDir, "out.bin"),
        bytes: 5,
        name: "small.bin",
      });
      rmSync(workDir, { recursive: true, force: true });
    });

    it("rejects download exceeding 1 GiB before writing when metadata declares over 1 GiB", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      fake.client.getFileMetadata = async (fileId) => ({
        id: fileId,
        name: "toolarge.bin",
        mimeType: "application/octet-stream",
        size: String(MAX_DRIVE_FILE_DOWNLOAD_BYTES + 1),
      });
      const downloadFileStream = vi.fn<NonNullable<DriveClient["downloadFileStream"]>>();
      fake.client.downloadFileStream = downloadFileStream;

      const client = await connect(fake.client, [], {
        workDir,
        fileToolsAvailable: true,
      });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("file size limit exceeded");
      expect(downloadFileStream).not.toHaveBeenCalled();
      expect(existsSync(join(workDir, "out.bin"))).toBe(false);
      rmSync(workDir, { recursive: true, force: true });
    });

    it("streams synthetic payload > 50 MiB through destinationPath and computes hash without full buffering", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      const chunkSize = 1024 * 1024; // 1 MiB
      const chunkCount = 55; // 55 MiB (> 50 MiB inline limit)
      const singleChunk = Buffer.alloc(chunkSize, "d");
      const hash = createHash("sha256");
      for (let i = 0; i < chunkCount; i++) {
        hash.update(singleChunk);
      }
      const expectedSha256 = hash.digest("hex");

      fake.client.getFileMetadata = async (fileId) => ({
        id: fileId,
        name: "synthetic.bin",
        mimeType: "application/octet-stream",
        size: String(chunkSize * chunkCount),
      });

      fake.client.downloadFileStream = async () => {
        async function* generate() {
          for (let i = 0; i < chunkCount; i++) {
            yield singleChunk;
          }
        }
        const stream = new ReadableStream({
          async start(controller) {
            for await (const chunk of generate()) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-length": String(chunkSize * chunkCount),
            "content-type": "application/octet-stream",
          },
        });
      };

      const client = await connect(fake.client, [], {
        workDir,
        fileToolsAvailable: true,
      });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "downloaded.bin" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(textOf(result));
      expect(data.path).toBe(join(workDir, "downloaded.bin"));
      expect(data.bytes).toBe(chunkSize * chunkCount);
      expect(data.sha256).toBe(expectedSha256);
      expect(data.name).toBe("synthetic.bin");
      expect(data.contentType).toBe("application/octet-stream");

      const stat = statSync(join(workDir, "downloaded.bin"));
      expect(stat.size).toBe(chunkSize * chunkCount);
      rmSync(workDir, { recursive: true, force: true });
    });

    it("stops an undeclared stream past the limit, cancels it, and removes the partial file", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      let cancelled = false;
      let sent = 0;
      fake.client.downloadFileStream = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent++ < 5) controller.enqueue(new Uint8Array(1024));
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        );
      const client = await connect(fake.client, [], {
        workDir,
        fileToolsAvailable: true,
        maxDownloadBytes: 3 * 1024,
      });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("file is larger than 3072 bytes");
      expect(cancelled).toBe(true);
      expect(existsSync(join(workDir, "out.bin"))).toBe(false);
      rmSync(workDir, { recursive: true, force: true });
    });

    it("refuses an existing destination, cancels the download, and keeps the original", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      writeFileSync(join(workDir, "out.bin"), "original");
      const fake = fakeDriveClient();
      let cancelled = false;
      fake.client.downloadFileStream = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        );
      const client = await connect(fake.client, [], { workDir, fileToolsAvailable: true });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(cancelled).toBe(true);
      expect(readFileSync(join(workDir, "out.bin"), "utf-8")).toBe("original");
      rmSync(workDir, { recursive: true, force: true });
    });

    it("requires a streaming client for destinationPath", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      const client = await connect(fake.client, [], { workDir, fileToolsAvailable: true });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("needs a Drive client that can stream downloads");
      expect(fake.calls.map((call) => call.method)).not.toContain("downloadFile");
      rmSync(workDir, { recursive: true, force: true });
    });

    it("keeps a lower GoogleDriveClient limit through file mode", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const configDir = mkdtempSync(join(tmpdir(), "drive-mcp-config-"));
      writeFileSync(
        join(configDir, "client.json"),
        JSON.stringify({ installed: { client_id: "client", client_secret: "secret" } })
      );
      writeFileSync(join(configDir, "drive-token.json"), JSON.stringify({ refresh_token: "r" }));
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "file-1", name: "f.bin", mimeType: "x/y" }), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(new Response(new Uint8Array(100), { status: 200 }));
      const drive = new GoogleDriveClient(configDir, fetchImpl, "drive-token.json", 80);
      const client = await connect(drive, [], { workDir, fileToolsAvailable: true });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("file is larger than 80 bytes");
      expect(existsSync(join(workDir, "out.bin"))).toBe(false);
      rmSync(workDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    });

    it("rejects destinationPath escaping workdir", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      const client = await connect(fake.client, [], {
        workDir,
        fileToolsAvailable: true,
      });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "../escape.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("escapes the actor workdir");
      rmSync(workDir, { recursive: true, force: true });
    });

    it("rejects destinationPath for follower-hosted actors", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "drive-mcp-download-"));
      const fake = fakeDriveClient();
      const client = await connect(fake.client, [], {
        workDir,
        fileToolsAvailable: false,
      });

      const result = (await client.callTool({
        name: "download_file",
        arguments: { fileId: "file-1", destinationPath: "out.bin" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        "Drive file tools are unavailable for follower-hosted actors"
      );
      rmSync(workDir, { recursive: true, force: true });
    });
  });
});
