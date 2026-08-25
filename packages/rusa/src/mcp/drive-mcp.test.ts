import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { DriveClient } from "../drive/drive-client.js";
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
  } = {}
) {
  const server = createDriveReadMcpServer("actor-1", driveClient, {
    allowedFolders,
    onRead: options.onRead,
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
  });
});
