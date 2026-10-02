import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackClient } from "../slack/slack-client.js";
import { createSlackReadMcpServer, createSlackWriteMcpServer } from "./slack-mcp.js";

const TOKEN = "xoxb-synthetic";
const FILE_URL = "https://files.slack.com/files-pri/T1-F1/download/report.txt";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return { isError: result.isError === true, text: first?.type === "text" ? first.text : "" };
}

function slackWith(web: Record<string, unknown>): SlackClient {
  const client = new SlackClient(TOKEN);
  Object.defineProperty(client, "web", { value: web });
  return client;
}

function messageWithFile(file: Record<string, unknown>) {
  return vi.fn(async () => ({
    messages: [{ ts: "1.0", text: "see attached", user: "U1", files: [file] }],
  }));
}

const reportFile = {
  id: "F1",
  name: "report.txt",
  title: "Report",
  mimetype: "text/plain",
  filetype: "text",
  size: 5,
  url_private: FILE_URL,
  url_private_download: FILE_URL,
};

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "rusa-slack-files-"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack read MCP files", () => {
  it("lists file metadata on a message without exposing private URLs", async () => {
    const client = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(reportFile) } })
      )
    );
    const { text } = await call(client, "get_message", { channel: "C1", ts: "1.0" });
    expect(JSON.parse(text).files).toEqual([
      {
        id: "F1",
        name: "report.txt",
        title: "Report",
        mimetype: "text/plain",
        filetype: "text",
        size: 5,
      },
    ]);
    expect(text).not.toContain("files.slack.com");
  });

  it("downloads an attached file into the workdir, sending the token only to Slack's file host", async () => {
    const dir = workdir();
    const fetchMock = vi.fn(
      async () => new Response("hello", { headers: { "content-type": "text/plain" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(reportFile) } }),
        { workDir: dir }
      )
    );
    const result = await call(client, "download_file", {
      channel: "C1",
      ts: "1.0",
      fileId: "F1",
      destinationPath: "report.txt",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      bytes: 5,
      file: { id: "F1", name: "report.txt" },
      source: "slack:channels/C1/messages/1.0",
    });
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(FILE_URL);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("only downloads files attached to the named message", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(reportFile) } }),
        { workDir: workdir() }
      )
    );
    const result = await call(client, "download_file", {
      channel: "C1",
      ts: "1.0",
      fileId: "F_OTHER",
      destinationPath: "other.txt",
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("not attached to C1/1.0");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send the bot token to any host but Slack's file host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = { ...reportFile, url_private_download: "https://evil.example/steal" };
    const client = await connect(
      createSlackReadMcpServer(slackWith({ conversations: { replies: messageWithFile(file) } }), {
        workDir: workdir(),
      })
    );
    const result = await call(client, "download_file", {
      channel: "C1",
      ts: "1.0",
      fileId: "F1",
      destinationPath: "report.txt",
    });
    expect(result.text).toContain("refusing to send Slack credentials");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the size limit from metadata and while streaming", async () => {
    const dir = workdir();
    const fetchMock = vi.fn(async () => new Response("123456789"));
    vi.stubGlobal("fetch", fetchMock);
    const declaredLarge = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile({ ...reportFile, size: 9 }) } }),
        { workDir: dir, maxFileBytes: 8 }
      )
    );
    const args = { channel: "C1", ts: "1.0", fileId: "F1", destinationPath: "big.bin" };
    expect((await call(declaredLarge, "download_file", args)).text).toContain(
      "file size limit exceeded"
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const undeclared = { ...reportFile } as Record<string, unknown>;
    delete undeclared.size;
    const streamedLarge = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(undeclared) } }),
        { workDir: dir, maxFileBytes: 8 }
      )
    );
    expect((await call(streamedLarge, "download_file", args)).text).toContain(
      "file size limit exceeded"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "big.bin"))).toBe(false);
  });

  it("reports Slack's sign-in page as a missing files:read scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } }))
    );
    const client = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(reportFile) } }),
        { workDir: workdir() }
      )
    );
    const result = await call(client, "download_file", {
      channel: "C1",
      ts: "1.0",
      fileId: "F1",
      destinationPath: "report.txt",
    });
    expect(result.text).toContain("files:read");
  });

  it("confines downloads to new files inside the workdir", async () => {
    const dir = workdir();
    const outside = workdir();
    mkdirSync(join(dir, "sub"));
    symlinkSync(outside, join(dir, "escape"));
    writeFileSync(join(dir, "existing.txt"), "keep");
    const fetchMock = vi.fn(async () => new Response("hello"));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(reportFile) } }),
        { workDir: dir }
      )
    );
    const download = (destinationPath: string) =>
      call(client, "download_file", { channel: "C1", ts: "1.0", fileId: "F1", destinationPath });

    expect((await download("../outside.txt")).text).toContain("escapes the actor workdir");
    expect((await download(join(outside, "abs.txt"))).text).toContain("escapes the actor workdir");
    expect((await download("escape/linked.txt")).text).toContain(
      "resolves outside the actor workdir"
    );
    expect((await download("existing.txt")).isError).toBe(true);
    expect(readFileSync(join(dir, "existing.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(outside, "linked.txt"))).toBe(false);

    expect((await download("sub/ok.txt")).isError).toBe(false);
    expect(readFileSync(join(dir, "sub", "ok.txt"), "utf8")).toBe("hello");
  });

  it("refuses a download whose directory is swapped for an outside symlink during the fetch", async () => {
    const dir = workdir();
    const outside = workdir();
    mkdirSync(join(dir, "sub"));
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchStarted();
        await held;
        return new Response("hello");
      })
    );
    const client = await connect(
      createSlackReadMcpServer(
        slackWith({ conversations: { replies: messageWithFile(reportFile) } }),
        { workDir: dir }
      )
    );
    const pending = call(client, "download_file", {
      channel: "C1",
      ts: "1.0",
      fileId: "F1",
      destinationPath: "sub/new.txt",
    });
    await started;
    renameSync(join(dir, "sub"), join(dir, "sub-moved"));
    symlinkSync(outside, join(dir, "sub"));
    release();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("access denied");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });
});

describe("Slack write MCP upload_file", () => {
  function uploader() {
    return vi.fn(async (_args: Record<string, unknown>) => ({
      ok: true,
      files: [{ ok: true, files: [{ id: "F9" }] }],
    }));
  }

  it("uploads a workdir file into a thread through the external upload flow", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "out.png"), "png-bytes");
    const uploadV2 = uploader();
    const client = await connect(
      createSlackWriteMcpServer(slackWith({ files: { uploadV2 } }), ["C1"], { workDir: dir })
    );
    const result = await call(client, "upload_file", {
      channel: "C1",
      filePath: "out.png",
      threadTs: "1.0",
      initialComment: "chart attached",
    });
    expect(JSON.parse(result.text)).toEqual({ fileIds: ["F9"], channel: "C1", threadTs: "1.0" });
    expect(uploadV2).toHaveBeenCalledWith({
      channel_id: "C1",
      file: Buffer.from("png-bytes"),
      filename: "out.png",
      initial_comment: "chart attached",
      thread_ts: "1.0",
    });
  });

  it("rejects disallowed channels, paths outside the workdir, and oversized files", async () => {
    const dir = workdir();
    const outside = workdir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    writeFileSync(join(dir, "big.bin"), "123456789");
    writeFileSync(join(dir, "ok.txt"), "ok");
    const uploadV2 = uploader();
    const client = await connect(
      createSlackWriteMcpServer(slackWith({ files: { uploadV2 } }), ["C1"], {
        workDir: dir,
        maxFileBytes: 8,
      })
    );
    const upload = (channel: string, filePath: string) =>
      call(client, "upload_file", { channel, filePath });

    expect((await upload("C2", "ok.txt")).text).toContain("access denied: Slack channel C2");
    expect((await upload("C1", join(outside, "secret.txt"))).text).toContain(
      "escapes the actor workdir"
    );
    expect((await upload("C1", "link.txt")).text).toContain("resolves outside the actor workdir");
    expect((await upload("C1", "big.bin")).text).toContain("file size limit exceeded");
    expect(uploadV2).not.toHaveBeenCalled();
  });

  it("refuses file reads and writes while the actor is follower-hosted", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "stale-on-leader.txt"), "stale");
    let followerHosted = true;
    const fileToolsAvailable = () => !followerHosted;
    const replies = messageWithFile(reportFile);
    const postMessage = vi.fn(async () => ({ ok: true, ts: "2.0" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const read = await connect(
      createSlackReadMcpServer(slackWith({ conversations: { replies } }), {
        workDir: dir,
        fileToolsAvailable,
      })
    );
    const uploadV2 = uploader();
    const write = await connect(
      createSlackWriteMcpServer(slackWith({ chat: { postMessage }, files: { uploadV2 } }), ["C1"], {
        workDir: dir,
        fileToolsAvailable,
      })
    );

    // Text tools remain functional while follower-hosted
    const send = await call(write, "send_message", { channel: "C1", text: "hello" });
    expect(send.isError).toBe(false);
    expect(postMessage).toHaveBeenCalled();
    const msg = await call(read, "get_message", { channel: "C1", ts: "1.0" });
    expect(msg.isError).toBe(false);
    expect(replies).toHaveBeenCalled();

    // File tools refuse visibly and do not touch leader files or Slack APIs
    replies.mockClear();
    const download = await call(read, "download_file", {
      channel: "C1",
      ts: "1.0",
      fileId: "F1",
      destinationPath: "downloaded.txt",
    });
    const upload = await call(write, "upload_file", {
      channel: "C1",
      filePath: "stale-on-leader.txt",
    });
    expect(download.text).toContain("unavailable for follower-hosted actors (see #812)");
    expect(upload.text).toContain("unavailable for follower-hosted actors (see #812)");
    expect(replies).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadV2).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "downloaded.txt"))).toBe(false);

    // The placement is checked at call time, not only when the server is mounted.
    followerHosted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("fresh"))
    );
    expect(
      (
        await call(read, "download_file", {
          channel: "C1",
          ts: "1.0",
          fileId: "F1",
          destinationPath: "downloaded.txt",
        })
      ).isError
    ).toBe(false);
    expect(
      (await call(write, "upload_file", { channel: "C1", filePath: "stale-on-leader.txt" })).isError
    ).toBe(false);
  });
});

describe("Slack write MCP react", () => {
  it("registers react tool and forwards reaction parameters", async () => {
    const react = vi.fn(async () => {});
    const client = slackWith({});
    client.react = react;

    const server = createSlackWriteMcpServer(client, ["C_ALLOWED"]);
    const mcpClient = await connect(server);

    const tools = await mcpClient.listTools();
    const reactTool = tools.tools.find((t) => t.name === "react");
    expect(reactTool).toBeDefined();
    expect(reactTool?.description).toContain("default eyes");
    expect(reactTool?.inputSchema.properties).toHaveProperty("emoji");

    const result = await call(mcpClient, "react", {
      channel: "C_ALLOWED",
      ts: "1234567890.123456",
      emoji: "eyes",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    expect(react).toHaveBeenCalledWith("C_ALLOWED", "1234567890.123456", "eyes");
  });

  it("enforces allowed channel restrictions", async () => {
    const react = vi.fn(async () => {});
    const client = slackWith({});
    client.react = react;

    const server = createSlackWriteMcpServer(client, ["C_ALLOWED"]);
    const mcpClient = await connect(server);

    const result = await call(mcpClient, "react", {
      channel: "C_FORBIDDEN",
      ts: "1234567890.123456",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("access denied: Slack channel C_FORBIDDEN");
    expect(react).not.toHaveBeenCalled();
  });
});
