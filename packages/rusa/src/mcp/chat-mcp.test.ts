import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FakeChatClient } from "../chat/fake.js";
import { createChatReadMcpServer, createChatWriteMcpServer } from "./chat-mcp.js";

async function connect(server: McpServer): Promise<Client> {
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

describe("chat MCP server", () => {
  it("exposes source-backed reads separately from scoped writes", async () => {
    const client = await connect(createChatReadMcpServer(new FakeChatClient()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "download_attachment",
      "get_attachment",
      "get_message",
      "list_messages",
      "list_spaces",
    ]);
  });

  it("lists the spaces this identity is a member of, paginating", async () => {
    const fake = new FakeChatClient();
    fake.spaces.push(
      { name: "spaces/A", spaceType: "SPACE", displayName: "org" },
      { name: "spaces/DM", spaceType: "DIRECT_MESSAGE" }
    );
    const client = await connect(createChatReadMcpServer(fake));

    const first = (await client.callTool({
      name: "list_spaces",
      arguments: { pageSize: 1 },
    })) as CallToolResult;
    const firstPage = JSON.parse(textOf(first)) as {
      spaces: { name: string }[];
      nextPageToken?: string;
    };
    expect(firstPage.spaces.map((s) => s.name)).toEqual(["spaces/A"]);
    expect(firstPage.nextPageToken).toBeTruthy();

    const second = (await client.callTool({
      name: "list_spaces",
      arguments: { pageSize: 1, pageToken: firstPage.nextPageToken },
    })) as CallToolResult;
    const secondPage = JSON.parse(textOf(second)) as {
      spaces: { name: string }[];
      nextPageToken?: string;
    };
    // A DM is in the membership — the caller decides per message what belongs in
    // a durable node, and no space is excluded before it has been looked at.
    expect(secondPage.spaces.map((s) => s.name)).toEqual(["spaces/DM"]);
    // The last page carries no token, which is how a caller knows the walk is
    // the membership rather than a prefix of it.
    expect(secondPage.nextPageToken).toBeUndefined();
  });

  it("reports a failed enumeration as an error, never as an empty membership", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatReadMcpServer(
        Object.assign(fake, {
          listSpaces: async () => {
            throw new Error("403 caller lacks chat.spaces.readonly");
          },
        })
      )
    );

    const result = (await client.callTool({
      name: "list_spaces",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("chat.spaces.readonly");
  });

  it("gets an exact message by resource name", async () => {
    const fake = new FakeChatClient();
    fake.messages.push({
      name: "spaces/A/messages/M1",
      text: "the original body",
      sender: { name: "users/U1", displayName: "Operator" },
      createTime: "2026-07-26T10:00:00Z",
    });
    const client = await connect(createChatReadMcpServer(fake));

    const result = (await client.callTool({
      name: "get_message",
      arguments: { messageName: "spaces/A/messages/M1" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({
      name: "spaces/A/messages/M1",
      text: "the original body",
    });
  });

  it("gets an attachment and downloads attachment bytes", async () => {
    const fake = new FakeChatClient();
    const sampleBytes = Buffer.from("sample binary file content");
    fake.attachments.set("spaces/A/messages/M1/attachments/ATT1", {
      metadata: {
        name: "spaces/A/messages/M1/attachments/ATT1",
        contentName: "spec.pdf",
        contentType: "application/pdf",
        source: "UPLOADED_CONTENT",
      },
      data: sampleBytes,
    });
    const client = await connect(createChatReadMcpServer(fake));

    const metaRes = (await client.callTool({
      name: "get_attachment",
      arguments: { attachmentName: "spaces/A/messages/M1/attachments/ATT1" },
    })) as CallToolResult;
    expect(metaRes.isError).toBeFalsy();
    expect(JSON.parse(textOf(metaRes))).toMatchObject({
      name: "spaces/A/messages/M1/attachments/ATT1",
      contentName: "spec.pdf",
      contentType: "application/pdf",
    });

    const dlRes = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "spaces/A/messages/M1/attachments/ATT1" },
    })) as CallToolResult;
    expect(dlRes.isError).toBeFalsy();
    expect(textOf(dlRes)).toBe(sampleBytes.toString("base64"));
  });

  it("lists a paginated thread without crossing spaces", async () => {
    const fake = new FakeChatClient();
    fake.messages.push(
      {
        name: "spaces/A/messages/M1",
        text: "older",
        thread: { name: "spaces/A/threads/T1" },
        createTime: "2026-07-26T10:00:00Z",
      },
      {
        name: "spaces/A/messages/M2",
        text: "newer",
        thread: { name: "spaces/A/threads/T1" },
        createTime: "2026-07-26T11:00:00Z",
      },
      {
        name: "spaces/B/messages/M3",
        text: "other space",
        thread: { name: "spaces/B/threads/T1" },
        createTime: "2026-07-26T12:00:00Z",
      }
    );
    const client = await connect(createChatReadMcpServer(fake));

    const result = (await client.callTool({
      name: "list_messages",
      arguments: {
        spaceName: "spaces/A",
        threadName: "spaces/A/threads/T1",
        orderBy: "DESC",
        pageSize: 1,
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      messages: [
        {
          name: "spaces/A/messages/M2",
          text: "newer",
          thread: { name: "spaces/A/threads/T1" },
          createTime: "2026-07-26T11:00:00Z",
        },
      ],
      nextPageToken: "1",
    });
  });

  it("rejects malformed or cross-space read resource names before calling Chat", async () => {
    const fake = new FakeChatClient();
    const client = await connect(createChatReadMcpServer(fake));

    const malformed = (await client.callTool({
      name: "get_message",
      arguments: { messageName: "not-a-message" },
    })) as CallToolResult;
    expect(malformed.isError).toBeTruthy();

    const crossSpaceThread = (await client.callTool({
      name: "list_messages",
      arguments: {
        spaceName: "spaces/A",
        threadName: "spaces/B/threads/T1",
      },
    })) as CallToolResult;
    expect(crossSpaceThread.isError).toBeTruthy();
  });

  it("filters messages by time bounds using createdAfter and createdBefore", async () => {
    const fake = new FakeChatClient();
    fake.messages.push(
      {
        name: "spaces/A/messages/M1",
        text: "oldest",
        createTime: "2026-07-26T10:00:00Z",
      },
      {
        name: "spaces/A/messages/M2",
        text: "middle",
        createTime: "2026-07-26T11:00:00Z",
      },
      {
        name: "spaces/A/messages/M3",
        text: "newest",
        createTime: "2026-07-26T12:00:00Z",
      }
    );
    const client = await connect(createChatReadMcpServer(fake));

    const result = (await client.callTool({
      name: "list_messages",
      arguments: {
        spaceName: "spaces/A",
        createdAfter: "2026-07-26T10:30:00Z",
        createdBefore: "2026-07-26T11:30:00Z",
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).messages).toEqual([
      {
        name: "spaces/A/messages/M2",
        text: "middle",
        createTime: "2026-07-26T11:00:00Z",
      },
    ]);
  });

  it("exposes the outbound ChatClient surface as tools in the write server", async () => {
    const client = await connect(
      createChatWriteMcpServer("test", new FakeChatClient(), { allowedSpaces: ["*"] })
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["react", "send_message", "upload_attachment"]);
  });

  it("routes send_message to the backend and returns the created name", async () => {
    const fake = new FakeChatClient();
    const client = await connect(createChatWriteMcpServer("test", fake, { allowedSpaces: ["*"] }));
    const res = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi", threadName: "spaces/A/threads/T" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(fake.sent).toEqual([
      { spaceName: "spaces/A", text: "hi", threadName: "spaces/A/threads/T" },
    ]);
    expect(JSON.parse(textOf(res)).name).toContain("spaces/A/messages/");
  });

  it("uploads an attachment and sends a message referencing it", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"] })
    );
    const uploadRes = (await client.callTool({
      name: "upload_attachment",
      arguments: {
        spaceName: "spaces/A",
        filename: "doc.txt",
        contentBase64: Buffer.from("hello world").toString("base64"),
        mimeType: "text/plain",
      },
    })) as CallToolResult;
    expect(uploadRes.isError).toBeFalsy();
    const uploadData = JSON.parse(textOf(uploadRes)) as {
      attachmentDataRef: { resourceName: string };
    };
    expect(uploadData.attachmentDataRef.resourceName).toContain("spaces/A/attachments/");

    const sendRes = (await client.callTool({
      name: "send_message",
      arguments: {
        spaceName: "spaces/A",
        text: "here is the file",
        attachments: [{ attachmentDataRef: uploadData.attachmentDataRef }],
      },
    })) as CallToolResult;
    expect(sendRes.isError).toBeFalsy();
    expect(fake.sent[0]?.attachments).toEqual([
      { attachmentDataRef: uploadData.attachmentDataRef },
    ]);
  });

  it("rejects malformed or loose attachment resource names on download_attachment", async () => {
    const fake = new FakeChatClient();
    const client = await connect(createChatReadMcpServer(fake));

    for (const invalid of [
      "not-a-resource",
      "spaces/A",
      "spaces/A/messages/M1",
      "spaces/A/attachments",
      "spaces/A/attachments/",
      "spaces/A/invalid/attachments/ATT1",
    ]) {
      const res = (await client.callTool({
        name: "download_attachment",
        arguments: { resourceName: invalid },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("resourceName must be in format");
    }
  });

  it("rejects oversized downloads in download_attachment", async () => {
    const fake = new FakeChatClient();
    const largeBytes = Buffer.alloc(100, "a");
    fake.attachments.set("spaces/A/attachments/ATT1", {
      metadata: {
        name: "spaces/A/attachments/ATT1",
        contentName: "large.bin",
        contentType: "application/octet-stream",
      },
      data: largeBytes,
    });
    const client = await connect(createChatReadMcpServer(fake, { maxAttachmentBytes: 50 }));

    const res = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "spaces/A/attachments/ATT1" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("attachment size limit exceeded");
  });

  it("supports inline contentBase64 uploads in send_message", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"] })
    );

    const sendRes = (await client.callTool({
      name: "send_message",
      arguments: {
        spaceName: "spaces/A",
        text: "inline base64 upload",
        attachments: [
          {
            contentBase64: Buffer.from("content in base64").toString("base64"),
            filename: "inline-doc.txt",
            mimeType: "text/plain",
          },
        ],
      },
    })) as CallToolResult;
    expect(sendRes.isError).toBeFalsy();
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0]?.text).toBe("inline base64 upload");
    expect(fake.sent[0]?.attachments?.length).toBe(1);
    expect(fake.uploadedAttachments.length).toBe(1);
    expect(fake.uploadedAttachments[0]?.filename).toBe("inline-doc.txt");
    expect(fake.uploadedAttachments[0]?.content.toString("utf8")).toBe("content in base64");
  });

  it("rejects oversized uploads in upload_attachment and send_message", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, {
        allowedSpaces: ["spaces/A"],
        maxAttachmentBytes: 20,
      })
    );

    const oversizedBase64 = Buffer.alloc(50, "x").toString("base64");

    const uploadRes = (await client.callTool({
      name: "upload_attachment",
      arguments: {
        spaceName: "spaces/A",
        filename: "oversize.txt",
        contentBase64: oversizedBase64,
      },
    })) as CallToolResult;
    expect(uploadRes.isError).toBe(true);
    expect(textOf(uploadRes)).toContain("attachment size limit exceeded");

    const sendRes = (await client.callTool({
      name: "send_message",
      arguments: {
        spaceName: "spaces/A",
        text: "oversized inline",
        attachments: [
          {
            contentBase64: oversizedBase64,
            filename: "oversize.txt",
          },
        ],
      },
    })) as CallToolResult;
    expect(sendRes.isError).toBe(true);
    expect(textOf(sendRes)).toContain("attachment size limit exceeded");
  });

  it("rejects upload_attachment when neither filePath nor contentBase64 is provided", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"] })
    );

    const res = (await client.callTool({
      name: "upload_attachment",
      arguments: {
        spaceName: "spaces/A",
        filename: "test.txt",
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Either filePath or contentBase64 must be provided");
  });

  it("uploads an attachment from a filePath in upload_attachment and preserves binary payload integrity", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const binaryData = Buffer.from([
        0x00, 0xff, 0x50, 0x4b, 0x03, 0x04, 0x12, 0x34, 0xfe, 0xed, 0xfa, 0xce,
      ]);
      const filePath = join(tmpDir, "archive.zip");
      writeFileSync(filePath, binaryData);

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir: tmpDir })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath,
        },
      })) as CallToolResult;

      expect(uploadRes.isError).toBeFalsy();
      const uploadData = JSON.parse(textOf(uploadRes)) as {
        attachmentDataRef: { resourceName: string };
      };
      expect(uploadData.attachmentDataRef.resourceName).toContain("spaces/A/attachments/");
      expect(fake.uploadedAttachments.length).toBe(1);
      expect(fake.uploadedAttachments[0]?.filename).toBe("archive.zip");
      expect(fake.uploadedAttachments[0]?.mimeType).toBe("application/zip");
      expect(fake.uploadedAttachments[0]?.content).toEqual(binaryData);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports explicit filename and mimeType override with filePath in upload_attachment", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const filePath = join(tmpDir, "temp_data.bin");
      writeFileSync(filePath, "test content");

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir: tmpDir })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath,
          filename: "custom-name.txt",
          mimeType: "text/plain",
        },
      })) as CallToolResult;

      expect(uploadRes.isError).toBeFalsy();
      expect(fake.uploadedAttachments.length).toBe(1);
      expect(fake.uploadedAttachments[0]?.filename).toBe("custom-name.txt");
      expect(fake.uploadedAttachments[0]?.mimeType).toBe("text/plain");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports filePath in send_message attachments and uploads binary payload directly from disk", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const binaryData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      ]);
      const filePath = join(tmpDir, "image.png");
      writeFileSync(filePath, binaryData);

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir: tmpDir })
      );

      const sendRes = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "here is an image from disk",
          attachments: [
            {
              filePath,
            },
          ],
        },
      })) as CallToolResult;

      expect(sendRes.isError).toBeFalsy();
      expect(fake.sent.length).toBe(1);
      expect(fake.sent[0]?.text).toBe("here is an image from disk");
      expect(fake.sent[0]?.attachments?.length).toBe(1);
      expect(fake.uploadedAttachments.length).toBe(1);
      expect(fake.uploadedAttachments[0]?.filename).toBe("image.png");
      expect(fake.uploadedAttachments[0]?.mimeType).toBe("image/png");
      expect(fake.uploadedAttachments[0]?.content).toEqual(binaryData);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-existent filePath in upload_attachment and send_message", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir: tmpDir })
      );

      const nonExistentPath = join(tmpDir, "non-existent-chat-file-12345.dat");

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath: nonExistentPath,
        },
      })) as CallToolResult;
      expect(uploadRes.isError).toBe(true);
      expect(textOf(uploadRes)).toContain("ENOENT");

      const sendRes = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "bad file",
          attachments: [
            {
              filePath: nonExistentPath,
            },
          ],
        },
      })) as CallToolResult;
      expect(sendRes.isError).toBe(true);
      expect(textOf(sendRes)).toContain("ENOENT");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized uploads from filePath in upload_attachment and send_message", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const filePath = join(tmpDir, "oversized.bin");
      writeFileSync(filePath, Buffer.alloc(100, "z"));

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          maxAttachmentBytes: 20,
          workDir: tmpDir,
        })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath,
        },
      })) as CallToolResult;
      expect(uploadRes.isError).toBe(true);
      expect(textOf(uploadRes)).toContain("attachment size limit exceeded");

      const sendRes = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "oversized file from disk",
          attachments: [
            {
              filePath,
            },
          ],
        },
      })) as CallToolResult;
      expect(sendRes.isError).toBe(true);
      expect(textOf(sendRes)).toContain("attachment size limit exceeded");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a filePath outside the workdir in upload_attachment and send_message", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const workDir = join(tmpDir, "workdir");
      mkdirSync(workDir);
      const outsidePath = join(tmpDir, "outside-secret.txt");
      writeFileSync(outsidePath, "secret host file");

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath: outsidePath,
        },
      })) as CallToolResult;
      expect(uploadRes.isError).toBe(true);
      expect(textOf(uploadRes)).toContain("escapes the actor workdir");

      const sendRes = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "exfiltration attempt",
          attachments: [
            {
              filePath: outsidePath,
            },
          ],
        },
      })) as CallToolResult;
      expect(sendRes.isError).toBe(true);
      expect(textOf(sendRes)).toContain("escapes the actor workdir");
      expect(fake.uploadedAttachments.length).toBe(0);
      expect(fake.sent.length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a filePath escaping the workdir via .. traversal", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const workDir = join(tmpDir, "workdir");
      mkdirSync(workDir);
      writeFileSync(join(tmpDir, "outside-secret.txt"), "secret host file");
      // Keep the literal ".." segment — join() would normalize it away before
      // the server ever saw a traversal path.
      const traversalPath = `${workDir}/../outside-secret.txt`;

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath: traversalPath,
        },
      })) as CallToolResult;
      expect(uploadRes.isError).toBe(true);
      expect(textOf(uploadRes)).toContain("escapes the actor workdir");

      const relativeTraversalRes = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "relative traversal",
          attachments: [
            {
              filePath: join("..", "outside-secret.txt"),
            },
          ],
        },
      })) as CallToolResult;
      expect(relativeTraversalRes.isError).toBe(true);
      expect(textOf(relativeTraversalRes)).toContain("escapes the actor workdir");
      expect(fake.uploadedAttachments.length).toBe(0);
      expect(fake.sent.length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a filePath that is a symlink pointing outside the workdir", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      const workDir = join(tmpDir, "workdir");
      mkdirSync(workDir);
      const outsidePath = join(tmpDir, "outside-secret.txt");
      writeFileSync(outsidePath, "secret host file");
      const linkPath = join(workDir, "innocent-looking.txt");
      symlinkSync(outsidePath, linkPath);

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath: linkPath,
        },
      })) as CallToolResult;
      expect(uploadRes.isError).toBe(true);
      expect(textOf(uploadRes)).toContain("resolves outside the actor workdir");

      const sendRes = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "symlink escape",
          attachments: [
            {
              filePath: linkPath,
            },
          ],
        },
      })) as CallToolResult;
      expect(sendRes.isError).toBe(true);
      expect(textOf(sendRes)).toContain("resolves outside the actor workdir");
      expect(fake.uploadedAttachments.length).toBe(0);
      expect(fake.sent.length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts a filePath given relative to the workdir", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-test-")));
    try {
      writeFileSync(join(tmpDir, "report.txt"), "inside the workdir");

      const fake = new FakeChatClient();
      const client = await connect(
        createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/A"], workDir: tmpDir })
      );

      const uploadRes = (await client.callTool({
        name: "upload_attachment",
        arguments: {
          spaceName: "spaces/A",
          filePath: "report.txt",
        },
      })) as CallToolResult;
      expect(uploadRes.isError).toBeFalsy();
      expect(fake.uploadedAttachments.length).toBe(1);
      expect(fake.uploadedAttachments[0]?.filename).toBe("report.txt");
      expect(fake.uploadedAttachments[0]?.content).toEqual(Buffer.from("inside the workdir"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("routes react to the backend with the given emoji", async () => {
    const fake = new FakeChatClient();
    const client = await connect(createChatWriteMcpServer("test", fake, { allowedSpaces: ["*"] }));
    await client.callTool({
      name: "react",
      arguments: { messageName: "spaces/A/messages/B", emoji: "✅" },
    });
    expect(fake.reactions).toEqual([{ messageName: "spaces/A/messages/B", emoji: "✅" }]);
  });

  it("rejects send_message, upload_attachment, and react if space is not allowed", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, { allowedSpaces: ["spaces/B"] })
    );

    const res1 = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi" },
    })) as CallToolResult;
    expect(res1.isError).toBeTruthy();
    expect(textOf(res1)).toContain("access denied");

    const res2 = (await client.callTool({
      name: "react",
      arguments: { messageName: "spaces/A/messages/B", emoji: "✅" },
    })) as CallToolResult;
    expect(res2.isError).toBeTruthy();
    expect(textOf(res2)).toContain("access denied");

    const res3 = (await client.callTool({
      name: "upload_attachment",
      arguments: {
        spaceName: "spaces/A",
        filename: "test.txt",
        contentBase64: Buffer.from("data").toString("base64"),
      },
    })) as CallToolResult;
    expect(res3.isError).toBeTruthy();
    expect(textOf(res3)).toContain("access denied");

    expect(fake.sent.length).toBe(0);
    expect(fake.reactions.length).toBe(0);
  });
});
