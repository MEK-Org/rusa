import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FakeChatClient } from "../chat/fake.js";
import type { Logger } from "../observability/logger.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import {
  createChatReadMcpServer,
  createChatWriteMcpServer,
  resolveChatReplyThreadName,
} from "./chat-mcp.js";

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

  it("signs unsigned top-level messages at the Chat write boundary", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, {
        allowedSpaces: ["*"],
        actorHandle: "actor-handle",
        getRunSelection: () => ({ provider: "test", model: "test-model", effort: "high" }),
      })
    );
    const res = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(fake.sent).toEqual([
      {
        spaceName: "spaces/A",
        text: "hi\n\n_actor-handle (test-model, high)_",
        threadName: undefined,
      },
    ]);
    expect(fake.sent[0]?.text).not.toContain("mesh:author");
  });

  it("signs threaded messages without changing their thread target", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, {
        allowedSpaces: ["*"],
        actorHandle: "actor-handle",
        getRunSelection: () => ({ provider: "test", model: "test-model", effort: "high" }),
      })
    );
    const res = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi", threadName: "spaces/A/threads/T" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(fake.sent).toEqual([
      {
        spaceName: "spaces/A",
        text: "hi\n\n_actor-handle (test-model, high)_",
        threadName: "spaces/A/threads/T",
      },
    ]);
    expect(JSON.parse(textOf(res)).name).toContain("spaces/A/messages/");
  });

  it("does not duplicate a caller-supplied matching signature", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, {
        allowedSpaces: ["*"],
        actorHandle: "actor-handle",
        getRunSelection: () => ({ provider: "test", model: "test-model", effort: "high" }),
      })
    );
    const signedText = "hi\n\n_actor-handle (test-model, high)_";
    const res = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: signedText },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(fake.sent[0]?.text).toBe(signedText);
  });

  it("uploads an attachment and sends a signed attachment-only message", async () => {
    const fake = new FakeChatClient();
    const client = await connect(
      createChatWriteMcpServer("test", fake, {
        allowedSpaces: ["spaces/A"],
        actorHandle: "actor-handle",
      })
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
        text: "",
        attachments: [{ attachmentDataRef: uploadData.attachmentDataRef }],
      },
    })) as CallToolResult;
    expect(sendRes.isError).toBeFalsy();
    expect(fake.sent[0]).toEqual({
      spaceName: "spaces/A",
      text: "_actor-handle_",
      attachments: [{ attachmentDataRef: uploadData.attachmentDataRef }],
      threadName: undefined,
    });
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
    fake.attachments.set("spaces/A/messages/M1/attachments/ATT1", {
      metadata: {
        name: "spaces/A/messages/M1/attachments/ATT1",
        contentName: "large.bin",
        contentType: "application/octet-stream",
      },
      data: largeBytes,
    });
    const client = await connect(createChatReadMcpServer(fake, { maxAttachmentBytes: 50 }));

    const res = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "spaces/A/messages/M1/attachments/ATT1" },
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
    expect(fake.sent[0]?.text).toBe("inline base64 upload\n\n_test_");
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
      expect(fake.sent[0]?.text).toBe("here is an image from disk\n\n_test_");
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

  it("restricts chat-read MCP tools to allowedSpaces when specified", async () => {
    const fake = new FakeChatClient();
    fake.spaces.push(
      { name: "spaces/A", spaceType: "SPACE", displayName: "Allowed Space" },
      { name: "spaces/B", spaceType: "SPACE", displayName: "Forbidden Space" }
    );
    fake.messages.push(
      {
        name: "spaces/A/messages/M1",
        text: "in allowed space",
        createTime: "2026-08-26T10:00:00Z",
      },
      {
        name: "spaces/B/messages/M2",
        text: "in forbidden space",
        createTime: "2026-08-26T10:00:00Z",
      }
    );
    const sampleBytes = Buffer.from("attachment bytes");
    fake.attachments.set("spaces/A/attachments/ATT1", {
      metadata: {
        name: "spaces/A/attachments/ATT1",
        contentName: "allowed.txt",
        contentType: "text/plain",
      },
      data: sampleBytes,
    });
    fake.attachments.set("spaces/A/messages/M1/attachments/ATT1", {
      metadata: {
        name: "spaces/A/messages/M1/attachments/ATT1",
        contentName: "allowed.txt",
        contentType: "text/plain",
        source: "UPLOADED_CONTENT",
        attachmentDataRef: { resourceName: "media/TOKEN_A" },
      },
      data: sampleBytes,
    });
    fake.attachments.set("spaces/B/messages/M2/attachments/ATT2", {
      metadata: {
        name: "spaces/B/messages/M2/attachments/ATT2",
        contentName: "forbidden.txt",
        contentType: "text/plain",
        source: "UPLOADED_CONTENT",
        attachmentDataRef: { resourceName: "media/TOKEN_B" },
      },
      data: sampleBytes,
    });

    const client = await connect(createChatReadMcpServer(fake, { allowedSpaces: ["spaces/A"] }));

    // list_spaces only returns allowed spaces
    const listSpacesRes = (await client.callTool({
      name: "list_spaces",
      arguments: {},
    })) as CallToolResult;
    expect(listSpacesRes.isError).toBeFalsy();
    const listedSpaces = JSON.parse(textOf(listSpacesRes)) as { spaces: { name: string }[] };
    expect(listedSpaces.spaces.map((s) => s.name)).toEqual(["spaces/A"]);

    // get_message in allowed space vs forbidden space
    const getMsgAllowed = (await client.callTool({
      name: "get_message",
      arguments: { messageName: "spaces/A/messages/M1" },
    })) as CallToolResult;
    expect(getMsgAllowed.isError).toBeFalsy();

    const getMsgForbidden = (await client.callTool({
      name: "get_message",
      arguments: { messageName: "spaces/B/messages/M2" },
    })) as CallToolResult;
    expect(getMsgForbidden.isError).toBeTruthy();
    expect(textOf(getMsgForbidden)).toContain("access denied");

    // get_attachment in allowed space vs forbidden space
    const getAttAllowed = (await client.callTool({
      name: "get_attachment",
      arguments: { attachmentName: "spaces/A/messages/M1/attachments/ATT1" },
    })) as CallToolResult;
    expect(getAttAllowed.isError).toBeFalsy();

    const getAttForbidden = (await client.callTool({
      name: "get_attachment",
      arguments: { attachmentName: "spaces/B/messages/M2/attachments/ATT2" },
    })) as CallToolResult;
    expect(getAttForbidden.isError).toBeTruthy();
    expect(textOf(getAttForbidden)).toContain("access denied");

    // download_attachment in allowed space vs forbidden space
    const dlAttAllowed = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "spaces/A/messages/M1/attachments/ATT1" },
    })) as CallToolResult;
    expect(dlAttAllowed.isError).toBeFalsy();
    expect(textOf(dlAttAllowed)).toBe(sampleBytes.toString("base64"));

    const dlAttForbidden = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "spaces/B/messages/M2/attachments/ATT2" },
    })) as CallToolResult;
    expect(dlAttForbidden.isError).toBeTruthy();
    expect(textOf(dlAttForbidden)).toContain("access denied");

    // raw media tokens are rejected on scoped servers
    const dlMediaTokenForbidden = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "media/TOKEN_A" },
    })) as CallToolResult;
    expect(dlMediaTokenForbidden.isError).toBeTruthy();
    expect(textOf(dlMediaTokenForbidden)).toContain("raw media/ tokens are not permitted");

    // list_messages in allowed space vs forbidden space
    const listMsgAllowed = (await client.callTool({
      name: "list_messages",
      arguments: { spaceName: "spaces/A" },
    })) as CallToolResult;
    expect(listMsgAllowed.isError).toBeFalsy();

    const listMsgForbidden = (await client.callTool({
      name: "list_messages",
      arguments: { spaceName: "spaces/B" },
    })) as CallToolResult;
    expect(listMsgForbidden.isError).toBeTruthy();
    expect(textOf(listMsgForbidden)).toContain("access denied");
  });

  it("downloads attachment using raw dataRef token or media format on unscoped server", async () => {
    const fake = new FakeChatClient();
    const sampleBytes = Buffer.from("opaque token bytes");
    fake.attachments.set("media/OPAQUE_TOKEN_123", {
      metadata: {
        name: "spaces/A/messages/M1/attachments/ATT1",
        attachmentDataRef: { resourceName: "media/OPAQUE_TOKEN_123" },
      },
      data: sampleBytes,
    });
    const client = await connect(createChatReadMcpServer(fake));

    const res = (await client.callTool({
      name: "download_attachment",
      arguments: { resourceName: "media/OPAQUE_TOKEN_123" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe(sampleBytes.toString("base64"));
  });

  it("auto-paginates list_spaces for scoped actors to locate allowed spaces across pages", async () => {
    const fake = new FakeChatClient();
    fake.spaces.push(
      { name: "spaces/OTHER_1", displayName: "Other 1", spaceType: "SPACE" },
      { name: "spaces/OTHER_2", displayName: "Other 2", spaceType: "SPACE" },
      { name: "spaces/TARGET", displayName: "Target Space", spaceType: "SPACE" }
    );
    // listSpaces with pageSize=1 would normally require paging; scoped list_spaces finds it
    const client = await connect(
      createChatReadMcpServer(fake, { allowedSpaces: ["spaces/TARGET"] })
    );

    const res = (await client.callTool({
      name: "list_spaces",
      arguments: { pageSize: 1 },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { spaces: { name: string }[] };
    expect(parsed.spaces).toEqual([
      { name: "spaces/TARGET", displayName: "Target Space", spaceType: "SPACE" },
    ]);
  });

  describe("Google Chat reply routing (#611)", () => {
    const makeEntry = (
      payload: Record<string, unknown>,
      source = "chat_space:spaces/A"
    ): InboxEntry => ({
      id: "entry-1",
      actorId: "test",
      source,
      deliveredAt: new Date("2026-09-21T10:00:00Z"),
      seenAt: null,
      handledAt: null,
      handledNote: null,
      payload: {
        type: "gchat.message",
        ...payload,
      },
    });

    it("replies top-level (omits threadName) when selected inbox entry is a top-level message (message id == thread id)", async () => {
      const fake = new FakeChatClient();
      const topLevelEntry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [topLevelEntry],
        })
      );

      // Model passes threadName equal to top-level thread head: should be mechanically stripped
      const res1 = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "top-level answer",
          threadName: "spaces/A/threads/M1",
        },
      })) as CallToolResult;
      expect(res1.isError).toBeFalsy();
      expect(fake.sent[0]?.threadName).toBeUndefined();

      // Model omits threadName: stays top-level
      const res2 = (await client.callTool({
        name: "send_message",
        arguments: { spaceName: "spaces/A", text: "another answer" },
      })) as CallToolResult;
      expect(res2.isError).toBeFalsy();
      expect(fake.sent[1]?.threadName).toBeUndefined();

      // Dot-notation message name: spaces/A/messages/M1.M1 with spaces/A/threads/M1
      const fakeDot = new FakeChatClient();
      const dotEntry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1.M1",
        threadName: "spaces/A/threads/M1",
      });
      const clientDot = await connect(
        createChatWriteMcpServer("test", fakeDot, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [dotEntry],
        })
      );
      const resDot = (await clientDot.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "dot notation reply",
          threadName: "spaces/A/threads/M1",
        },
      })) as CallToolResult;
      expect(resDot.isError).toBeFalsy();
      expect(fakeDot.sent[0]?.threadName).toBeUndefined();
    });

    it("creates thread on top-level message when explicitly requested via createThread", async () => {
      const fake = new FakeChatClient();
      const topLevelEntry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [topLevelEntry],
        })
      );

      const res = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "explicitly new thread",
          threadName: "spaces/A/threads/M1",
          createThread: true,
        },
      })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/M1");
    });

    it("replies inside existing thread when selected inbox entry is a thread reply (message id != thread id)", async () => {
      const fake = new FakeChatClient();
      const existingThreadEntry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M2",
        threadName: "spaces/A/threads/T1",
      });
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [existingThreadEntry],
        })
      );

      // Model provides the threadName: stays in thread
      const res1 = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "in thread with threadName",
          threadName: "spaces/A/threads/T1",
        },
      })) as CallToolResult;
      expect(res1.isError).toBeFalsy();
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/T1");

      // Model omits threadName: mechanically routed to stay in thread
      const res2 = (await client.callTool({
        name: "send_message",
        arguments: { spaceName: "spaces/A", text: "in thread omitting threadName" },
      })) as CallToolResult;
      expect(res2.isError).toBeFalsy();
      expect(fake.sent[1]?.threadName).toBe("spaces/A/threads/T1");
    });

    it("evaluates selectedInboxEntries dynamically via getter function", async () => {
      const fake = new FakeChatClient();
      let currentEntries: InboxEntry[] = [];
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: () => currentEntries,
        })
      );

      // Initially no selected entries: uses caller's threadName
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "no selection",
          threadName: "spaces/A/threads/M1",
        },
      });
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/M1");

      // Now set top-level entry: threadName is stripped
      currentEntries = [
        makeEntry({
          spaceName: "spaces/A",
          messageName: "spaces/A/messages/M1",
          threadName: "spaces/A/threads/M1",
        }),
      ];
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "with selection",
          threadName: "spaces/A/threads/M1",
        },
      });
      expect(fake.sent[1]?.threadName).toBeUndefined();
    });

    it("preserves caller's threadName when targeting a different existing thread in the same space", async () => {
      const fake = new FakeChatClient();
      const topLevelEntry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [topLevelEntry],
        })
      );

      // Caller deliberately supplies a different thread: must NOT be stripped
      const res = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "replying to a different thread",
          threadName: "spaces/A/threads/OTHER",
        },
      })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/OTHER");
    });

    it("does not let selected entry in space B affect send to space A", async () => {
      const fake = new FakeChatClient();
      const spaceBEntry = makeEntry(
        {
          spaceName: "spaces/B",
          messageName: "spaces/B/messages/B1",
          threadName: "spaces/B/threads/B1",
        },
        "chat_space:spaces/B"
      );
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A", "spaces/B"],
          selectedInboxEntries: [spaceBEntry],
        })
      );

      // Send to space A with threadName: preserved, not affected by space B
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "msg in space A",
          threadName: "spaces/A/threads/A1",
        },
      });
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/A1");

      // Send to space A without threadName: preserved as undefined (not overridden by space B)
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "top-level in space A",
        },
      });
      expect(fake.sent[1]?.threadName).toBeUndefined();
    });

    it("handles multiple selected entries in the same space correctly", async () => {
      const fake = new FakeChatClient();
      const entryT1 = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/T1",
      });
      const entryT2 = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M2",
        threadName: "spaces/A/threads/T2",
      });
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [entryT1, entryT2],
        })
      );

      // Caller specifies T2: routes to T2, not the first entry T1
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "reply to T2",
          threadName: "spaces/A/threads/T2",
        },
      });
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/T2");

      // Caller specifies T1: routes to T1
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "reply to T1",
          threadName: "spaces/A/threads/T1",
        },
      });
      expect(fake.sent[1]?.threadName).toBe("spaces/A/threads/T1");

      // Caller omits threadName: disagreeing entries mean ambiguous -> leaves threadName undefined
      await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "ambiguous reply",
        },
      });
      expect(fake.sent[2]?.threadName).toBeUndefined();
    });

    it("keeps an explicit thread reply in-thread when a selected head shares its handle", async () => {
      const head = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });
      const reply = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M7",
        threadName: "spaces/A/threads/M1",
      });

      for (const selectedInboxEntries of [
        [head, reply],
        [reply, head],
      ]) {
        const fake = new FakeChatClient();
        const client = await connect(
          createChatWriteMcpServer("test", fake, {
            allowedSpaces: ["spaces/A"],
            selectedInboxEntries,
          })
        );

        await client.callTool({
          name: "send_message",
          arguments: {
            spaceName: "spaces/A",
            text: "reply in selected thread",
            threadName: "spaces/A/threads/M1",
          },
        });
        expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/M1");
      }
    });

    it("makes selected head authoritative when createThread: true is passed with mismatched threadName", async () => {
      const fake = new FakeChatClient();
      const topLevelEntry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });
      const client = await connect(
        createChatWriteMcpServer("test", fake, {
          allowedSpaces: ["spaces/A"],
          selectedInboxEntries: [topLevelEntry],
        })
      );

      const res = (await client.callTool({
        name: "send_message",
        arguments: {
          spaceName: "spaces/A",
          text: "start thread on selected message",
          threadName: "spaces/A/threads/MISMATCHED",
          createThread: true,
        },
      })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      expect(fake.sent[0]?.threadName).toBe("spaces/A/threads/M1");
    });
  });

  describe("resolveChatReplyThreadName pure unit tests", () => {
    function makeEntry(
      payload: Record<string, unknown>,
      source = "chat_space:spaces/A"
    ): InboxEntry {
      return {
        id: "entry-1",
        actorId: "test",
        source,
        deliveredAt: new Date("2026-09-21T10:00:00Z"),
        seenAt: null,
        handledAt: null,
        handledNote: null,
        payload: {
          type: "gchat.message",
          ...payload,
        },
      };
    }

    function mockLogger(
      logs: { level: string; event: string; fields?: Record<string, unknown> }[]
    ): Logger {
      const write = (level: string) => (event: string, fields?: Record<string, unknown>) =>
        logs.push({ level, event, fields });
      const logger = {
        debug: write("debug"),
        info: write("info"),
        warn: write("warn"),
        error: write("error"),
        child: () => logger,
      } as unknown as Logger;
      return logger;
    }

    it("strips threadName when caller passes top-level head thread handle and logs override", () => {
      const logs: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
      const logger = mockLogger(logs);
      const entry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });

      const res = resolveChatReplyThreadName(
        "spaces/A",
        "spaces/A/threads/M1",
        false,
        [entry],
        logger
      );
      expect(res).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({
        level: "info",
        event: "chat_reply_thread_overridden",
        fields: {
          spaceName: "spaces/A",
          callerThreadName: "spaces/A/threads/M1",
          effectiveThreadName: undefined,
          reason: "selected_toplevel_message",
        },
      });
    });

    it("preserves caller's threadName when caller targets a different thread than selected top-level message", () => {
      const entry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });

      const res = resolveChatReplyThreadName("spaces/A", "spaces/A/threads/OTHER", false, [entry]);
      expect(res).toBe("spaces/A/threads/OTHER");
    });

    it("assigns threadName when replying to existing thread and logs assignment", () => {
      const logs: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
      const logger = mockLogger(logs);
      const entry = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M2",
        threadName: "spaces/A/threads/T1",
      });

      const res = resolveChatReplyThreadName("spaces/A", undefined, false, [entry], logger);
      expect(res).toBe("spaces/A/threads/T1");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({
        level: "info",
        event: "chat_reply_assigned_thread",
        fields: {
          spaceName: "spaces/A",
          effectiveThreadName: "spaces/A/threads/T1",
          reason: "selected_thread_entry",
        },
      });
    });

    it("ignores selected entries belonging to different spaces", () => {
      const entry = makeEntry(
        {
          spaceName: "spaces/B",
          messageName: "spaces/B/messages/B1",
          threadName: "spaces/B/threads/B1",
        },
        "chat_space:spaces/B"
      );

      // Caller provided thread in spaces/A: preserved
      expect(resolveChatReplyThreadName("spaces/A", "spaces/A/threads/A1", false, [entry])).toBe(
        "spaces/A/threads/A1"
      );
      // Caller omitted thread in spaces/A: stays undefined
      expect(resolveChatReplyThreadName("spaces/A", undefined, false, [entry])).toBeUndefined();
    });

    it("treats disagreeing entries in same space as ambiguous when threadName omitted", () => {
      const logs: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
      const logger = mockLogger(logs);
      const e1 = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      });
      const e2 = makeEntry({
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M2",
        threadName: "spaces/A/threads/T1",
      });

      const res = resolveChatReplyThreadName("spaces/A", undefined, false, [e1, e2], logger);
      expect(res).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.event).toBe("chat_reply_ambiguous_selection");
    });
  });
});
