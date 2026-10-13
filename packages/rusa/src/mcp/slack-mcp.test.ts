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
import {
  createSlackReadMcpServer,
  createSlackWriteMcpServer,
  toSlackTimestamp,
} from "./slack-mcp.js";

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

describe("Slack read MCP history", () => {
  function historyServer(conversations: Record<string, unknown>) {
    const client = new SlackClient(TOKEN);
    Object.defineProperty(client, "historyWeb", { value: { conversations } });
    return connect(createSlackReadMcpServer(client));
  }

  it("turns an ISO-8601 date range into Slack timestamp bounds", async () => {
    const history = vi.fn(async () => ({ messages: [], has_more: false }));
    const client = await historyServer({ history });
    const result = await call(client, "list_channel_history", {
      channel: "C1",
      oldest: "2026-10-13T02:00:00+02:00",
      latest: "2026-10-14T00:00:00Z",
      limit: 25,
    });
    expect(result.isError).toBe(false);
    expect(history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 25,
      oldest: "1791849600.000000",
      latest: "1791936000.000000",
    });
    expect(JSON.parse(result.text)).toEqual({
      channel: "C1",
      order: "newest_first",
      messages: [],
      hasMore: false,
    });
  });

  it("passes Slack timestamps, inclusivity and the cursor through with a default page size", async () => {
    const replies = vi.fn(async () => ({
      messages: [{ ts: "5.1", text: "reply", user: "U2", thread_ts: "5.0" }],
    }));
    const client = await historyServer({ replies });
    const result = await call(client, "list_thread_replies", {
      channel: "C1",
      threadTs: "5.0",
      oldest: "5.0",
      inclusive: true,
      cursor: "replies-2",
    });
    expect(result.isError).toBe(false);
    expect(replies).toHaveBeenCalledTimes(1);
    expect(replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "5.0",
      limit: 50,
      oldest: "5.0",
      inclusive: true,
      cursor: "replies-2",
    });
    expect(JSON.parse(result.text)).toMatchObject({ threadTs: "5.0", order: "oldest_first" });
  });

  it("lists attached file metadata without private URLs", async () => {
    const history = vi.fn(async () => ({
      messages: [{ ts: "1.0", text: "see attached", user: "U1", files: [reportFile] }],
    }));
    const client = await historyServer({ history });
    const { text } = await call(client, "list_channel_history", { channel: "C1" });
    expect(JSON.parse(text).messages[0].files).toEqual([
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

  it.each([
    [{ oldest: "yesterday" }, /oldest must be a Slack timestamp/],
    [{ latest: "2026-10-13" }, /latest must be a Slack timestamp/],
    [{ latest: "2026-10-13T00:00:00" }, /latest must be a Slack timestamp/],
    [{ oldest: "2026-02-30T00:00:00Z" }, /oldest must be a Slack timestamp/],
    [{ latest: "2026-04-31T09:00:00+02:00" }, /latest must be a Slack timestamp/],
    [{ latest: "2026-10-13T24:00:00Z" }, /latest must be a Slack timestamp/],
    [
      { oldest: "2026-10-14T00:00:00Z", latest: "2026-10-13T00:00:00Z" },
      /oldest must not be after latest/,
    ],
    [{ limit: 0 }, /limit|Too small|>=1/i],
    [{ limit: 201 }, /limit|Too big|<=200/i],
  ])("rejects invalid bounds %j before calling Slack", async (bounds, message) => {
    const history = vi.fn(async () => ({ messages: [] }));
    const client = await historyServer({ history });
    const result = await call(client, "list_channel_history", { channel: "C1", ...bounds });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    expect(history).not.toHaveBeenCalled();
  });

  it("accepts real calendar instants, including a leap day and fractional seconds", () => {
    expect(toSlackTimestamp("2028-02-29T12:00:00.5Z", "oldest")).toBe("1835438400.500000");
    expect(toSlackTimestamp("2026-10-13T23:59+05:30", "latest")).toBe("1791916140.000000");
  });

  it("rejects a thread timestamp that is not a Slack timestamp", async () => {
    const replies = vi.fn(async () => ({ messages: [] }));
    const client = await historyServer({ replies });
    const result = await call(client, "list_thread_replies", { channel: "C1", threadTs: "latest" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/threadTs must be a Slack message timestamp/);
    expect(replies).not.toHaveBeenCalled();
  });

  it("surfaces Slack's access errors as tool errors", async () => {
    const history = vi.fn(async () => {
      throw Object.assign(new Error("An API error occurred: not_in_channel"), {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "not_in_channel" },
      });
    });
    const client = await historyServer({ history });
    const result = await call(client, "list_channel_history", { channel: "C1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a member of this conversation/);
  });
});

describe("Slack write MCP successful-write hook", () => {
  const slackError = (code: string) =>
    Object.assign(new Error(`An API error occurred: ${code}`), {
      data: { ok: false, error: code },
    });

  function writer(web: Record<string, unknown>, options: { onWrite?: () => void } = {}) {
    const onWrite = vi.fn(options.onWrite);
    const warnings: { event: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (event: string, fields?: Record<string, unknown>) => warnings.push({ event, fields }),
      error: () => {},
      child: () => logger,
    };
    const dir = workdir();
    writeFileSync(join(dir, "out.txt"), "bytes");
    const server = createSlackWriteMcpServer(slackWith(web), ["C1"], {
      workDir: dir,
      onWrite,
      logger,
    });
    return { server, onWrite, warnings };
  }

  it("fires once after Slack posts a message, and not when the post or the grant fails", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: "1791849600.000100" })
      .mockRejectedValueOnce(slackError("not_in_channel"));
    const { server, onWrite } = writer({ chat: { postMessage } });
    const client = await connect(server);

    const sent = await call(client, "send_message", { channel: "C1", text: "hi" });
    expect(sent.isError).toBe(false);
    expect(onWrite).toHaveBeenCalledOnce();

    const refused = await call(client, "send_message", { channel: "C1", text: "again" });
    expect(refused).toMatchObject({
      isError: true,
      text: expect.stringContaining("not_in_channel"),
    });
    const denied = await call(client, "send_message", { channel: "C2", text: "elsewhere" });
    expect(denied.isError).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(onWrite).toHaveBeenCalledOnce();
  });

  it("counts a post Slack accepted without a timestamp as written while still reporting it", async () => {
    const { server, onWrite } = writer({ chat: { postMessage: async () => ({ ok: true }) } });
    const result = await call(await connect(server), "send_message", { channel: "C1", text: "hi" });
    expect(result).toEqual({
      isError: true,
      text: expect.stringContaining("Slack did not return a message timestamp"),
    });
    expect(onWrite).toHaveBeenCalledOnce();
  });

  it("fires once after a reaction is added, and not when Slack refuses it", async () => {
    const add = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(slackError("already_reacted"));
    const { server, onWrite } = writer({ reactions: { add } });
    const client = await connect(server);

    expect((await call(client, "react", { channel: "C1", ts: "1.0" })).isError).toBe(false);
    expect(onWrite).toHaveBeenCalledOnce();
    expect((await call(client, "react", { channel: "C1", ts: "1.0" })).isError).toBe(true);
    expect(onWrite).toHaveBeenCalledOnce();
  });

  it("keeps Slack's result when the local hook throws", async () => {
    const { server, onWrite, warnings } = writer(
      { chat: { postMessage: async () => ({ ok: true, ts: "1791849600.000100" }) } },
      {
        onWrite: () => {
          throw new Error("actor already gone");
        },
      }
    );
    const result = await call(await connect(server), "send_message", { channel: "C1", text: "hi" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      ref: "slack:channels/C1/messages/1791849600.000100",
      ts: "1791849600.000100",
    });
    expect(onWrite).toHaveBeenCalledOnce();
    expect(warnings).toEqual([
      {
        event: "slack_write_hook_failed",
        fields: { tool: "send_message", error: "actor already gone" },
      },
    ]);
  });

  describe("upload_file across Slack's external upload flow", () => {
    const UPLOAD_URL = "https://files.slack.com/upload/v1/synthetic";
    type Step = { ok: boolean; error?: string; files?: unknown[] };

    // The SDK resolves globalThis.fetch when the client is built, so a stub
    // installed first stands in for every step: the two API calls and the
    // byte upload to the URL Slack hands back.
    function uploadApi(steps: { getUrl: Step; complete: Step }) {
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const target = String(url);
          requests.push(target === UPLOAD_URL ? "upload bytes" : (target.split("/").pop() ?? ""));
          if (target === UPLOAD_URL) return new Response("OK", { status: 200 });
          const body = target.endsWith("files.getUploadURLExternal")
            ? { ...steps.getUrl, upload_url: UPLOAD_URL, file_id: "F9" }
            : steps.complete;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        })
      );
      const onWrite = vi.fn();
      const dir = workdir();
      writeFileSync(join(dir, "out.txt"), "bytes");
      const server = createSlackWriteMcpServer(new SlackClient(TOKEN), ["C1"], {
        workDir: dir,
        onWrite,
      });
      return { server, onWrite, requests };
    }

    const upload = async (server: McpServer) =>
      call(await connect(server), "upload_file", { channel: "C1", filePath: "out.txt" });

    it("fires once Slack completes the upload and shares the file", async () => {
      const { server, onWrite, requests } = uploadApi({
        getUrl: { ok: true },
        complete: { ok: true, files: [{ id: "F9" }] },
      });
      const result = await upload(server);
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toEqual({ fileIds: ["F9"], channel: "C1" });
      expect(requests).toEqual([
        "files.getUploadURLExternal",
        "upload bytes",
        "files.completeUploadExternal",
      ]);
      expect(onWrite).toHaveBeenCalledOnce();
    });

    it("does not fire when Slack refuses an upload URL", async () => {
      const { server, onWrite, requests } = uploadApi({
        getUrl: { ok: false, error: "not_in_channel" },
        complete: { ok: true, files: [{ id: "F9" }] },
      });
      expect((await upload(server)).isError).toBe(true);
      expect(requests).toEqual(["files.getUploadURLExternal"]);
      expect(onWrite).not.toHaveBeenCalled();
    });

    it("does not fire when bytes were sent but Slack never completed the share", async () => {
      const { server, onWrite, requests } = uploadApi({
        getUrl: { ok: true },
        complete: { ok: false, error: "channel_not_found" },
      });
      const result = await upload(server);
      expect(result).toEqual({ isError: true, text: expect.stringContaining("channel_not_found") });
      expect(requests).toEqual([
        "files.getUploadURLExternal",
        "upload bytes",
        "files.completeUploadExternal",
      ]);
      expect(onWrite).not.toHaveBeenCalled();
    });

    it("counts a completed share without file IDs as written while still reporting it", async () => {
      const { server, onWrite } = uploadApi({
        getUrl: { ok: true },
        complete: { ok: true, files: [] },
      });
      const result = await upload(server);
      expect(result).toEqual({
        isError: true,
        text: expect.stringContaining("Slack did not confirm the uploaded file"),
      });
      expect(onWrite).toHaveBeenCalledOnce();
    });
  });
});
