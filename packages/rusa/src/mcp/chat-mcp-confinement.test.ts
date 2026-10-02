import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChatClient } from "../chat/fake.js";
import { createChatWriteMcpServer } from "./chat-mcp.js";

// One-shot hook run right after realpath resolves to `path`: the attachment
// target has been validated, and the hook lands a swap before the bytes are
// read (#832).
const afterResolve = vi.hoisted(() => ({
  path: undefined as string | undefined,
  run: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async () => {
  const actual = (await vi.importActual<typeof import("node:fs")>("node:fs")).promises;
  const realpath = async (...args: Parameters<typeof actual.realpath>) => {
    const resolved = await actual.realpath(...args);
    if (afterResolve.path !== undefined && resolved === afterResolve.path) {
      const run = afterResolve.run;
      afterResolve.path = undefined;
      afterResolve.run = undefined;
      run?.();
    }
    return resolved;
  };
  return { ...actual, default: { ...actual, realpath }, realpath };
});

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

const SECRET = "outside secret bytes";

// Both Chat call sites that read an attachment from disk.
const callSites = [
  {
    name: "upload_attachment",
    call: (client: Client, filePath: string) =>
      client.callTool({
        name: "upload_attachment",
        arguments: { spaceName: "spaces/A", filePath },
      }),
  },
  {
    name: "send_message",
    call: (client: Client, filePath: string) =>
      client.callTool({
        name: "send_message",
        arguments: { spaceName: "spaces/A", text: "report", attachments: [{ filePath }] },
      }),
  },
] as const;

describe.each(callSites)("Chat $name disk reads (#832)", ({ call }) => {
  let root: string;
  let workDir: string;
  let outside: string;
  let fake: FakeChatClient;
  let client: Client;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-confinement-")));
    workDir = join(root, "workdir");
    outside = join(root, "outside");
    mkdirSync(workDir);
    mkdirSync(outside);
    writeFileSync(join(outside, "report.txt"), SECRET);
    fake = new FakeChatClient();
    client = await connect(
      createChatWriteMcpServer("test", fake, {
        allowedSpaces: ["spaces/A"],
        workDir,
        maxAttachmentBytes: 64,
      })
    );
  });

  afterEach(() => {
    afterResolve.path = undefined;
    afterResolve.run = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  function expectNothingUploaded(): void {
    expect(fake.uploadedAttachments).toEqual([]);
    expect(fake.sent).toEqual([]);
  }

  it("refuses a final-component symlink swapped in after validation", async () => {
    const target = join(workDir, "report.txt");
    writeFileSync(target, "inside");
    afterResolve.path = target;
    afterResolve.run = () => {
      rmSync(target);
      symlinkSync(join(outside, "report.txt"), target);
    };

    const res = (await call(client, "report.txt")) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("access denied");
    expectNothingUploaded();
  });

  it("refuses an ancestor directory swapped for an outside symlink after validation", async () => {
    const sub = join(workDir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "report.txt"), "inside");
    afterResolve.path = join(sub, "report.txt");
    afterResolve.run = () => {
      renameSync(sub, join(workDir, "sub-moved"));
      symlinkSync(outside, sub);
    };

    const res = (await call(client, "sub/report.txt")) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("access denied");
    expectNothingUploaded();
  });

  it("enforces the byte cap at the read when the file grows after validation", async () => {
    const target = join(workDir, "grow.txt");
    writeFileSync(target, "small");
    afterResolve.path = target;
    afterResolve.run = () => appendFileSync(target, Buffer.alloc(200, "g"));

    const res = (await call(client, "grow.txt")) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("size limit exceeded");
    expectNothingUploaded();
  });

  it.skipIf(process.platform !== "linux")(
    "refuses a FIFO without blocking on it",
    async () => {
      execFileSync("mkfifo", [join(workDir, "pipe")]);
      const res = (await call(client, "pipe")) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("not a regular file");
      expectNothingUploaded();
    },
    5_000
  );

  it("still uploads an ordinary workdir file byte for byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    writeFileSync(join(workDir, "ok.bin"), bytes);

    const res = (await call(client, "ok.bin")) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(fake.uploadedAttachments).toHaveLength(1);
    expect(fake.uploadedAttachments[0]?.filename).toBe("ok.bin");
    expect(fake.uploadedAttachments[0]?.content).toEqual(bytes);
  });
});
