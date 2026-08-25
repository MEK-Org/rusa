import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { GmailClient, SendEmailInput } from "../email/gmail-client.js";
import { createEmailSendMcpServer } from "./email-mcp.js";

function fakeGmailClient() {
  const calls: SendEmailInput[] = [];
  const client: GmailClient = {
    sendEmail: async (input) => {
      calls.push(input);
      return { id: "gmail-message-1" };
    },
  };
  return { client, calls };
}

async function connect(gmailClient: GmailClient, allowedRecipients: string[], onSend = vi.fn()) {
  const server = createEmailSendMcpServer("actor-1", gmailClient, {
    allowedRecipients,
    onSend,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, onSend };
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("email-send MCP server", () => {
  it("exposes only send_email", async () => {
    const fake = fakeGmailClient();
    const { client } = await connect(fake.client, ["person@example.com"]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["send_email"]);
  });

  it("fails closed when the allowed recipient list is empty", async () => {
    const fake = fakeGmailClient();
    const { client, onSend } = await connect(fake.client, []);
    const result = (await client.callTool({
      name: "send_email",
      arguments: { to: "person@example.com", subject: "Hello", body: "Body" },
    })) as CallToolResult;

    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("access denied");
    expect(fake.calls).toEqual([]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("denies a non-allow-listed To or Cc recipient before calling Gmail", async () => {
    const fake = fakeGmailClient();
    const { client } = await connect(fake.client, ["person@example.com"]);

    const deniedTo = (await client.callTool({
      name: "send_email",
      arguments: { to: "other@example.com", subject: "Hello", body: "Body" },
    })) as CallToolResult;
    const deniedCc = (await client.callTool({
      name: "send_email",
      arguments: {
        to: "person@example.com",
        cc: ["other@example.com"],
        subject: "Hello",
        body: "Body",
      },
    })) as CallToolResult;

    expect(deniedTo.isError).toBeTruthy();
    expect(deniedCc.isError).toBeTruthy();
    expect(fake.calls).toEqual([]);
  });

  it("sends to allowed To and Cc recipients and emits the durable-event callback", async () => {
    const fake = fakeGmailClient();
    const { client, onSend } = await connect(fake.client, [
      "person@example.com",
      "copy@example.com",
    ]);
    const result = (await client.callTool({
      name: "send_email",
      arguments: {
        to: "person@example.com",
        cc: ["copy@example.com"],
        subject: "Hello",
        body: "Plain text",
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ id: "gmail-message-1" });
    expect(fake.calls).toEqual([
      {
        to: "person@example.com",
        cc: ["copy@example.com"],
        subject: "Hello",
        body: "Plain text",
      },
    ]);
    expect(onSend).toHaveBeenCalledWith("actor-1", {
      to: "person@example.com",
      cc: ["copy@example.com"],
    });
  });

  it("reports success when audit recording fails after Gmail accepts the send", async () => {
    const fake = fakeGmailClient();
    const auditError = new Error("event sink unavailable");
    const onSend = vi.fn(() => {
      throw auditError;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = await connect(fake.client, ["person@example.com"], onSend);

    const result = (await client.callTool({
      name: "send_email",
      arguments: { to: "person@example.com", subject: "Hello", body: "Body" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ id: "gmail-message-1" });
    expect(fake.calls).toHaveLength(1);
    expect(onSend).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[email-send] failed to record completed send: event sink unavailable"
    );
  });

  it("forwards html_body to gmailClient when provided", async () => {
    const fake = fakeGmailClient();
    const { client, onSend } = await connect(fake.client, ["person@example.com"]);
    const result = (await client.callTool({
      name: "send_email",
      arguments: {
        to: "person@example.com",
        subject: "Hello",
        body: "Plain text",
        html_body: "<h1>HTML content</h1>",
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ id: "gmail-message-1" });
    expect(fake.calls).toEqual([
      {
        to: "person@example.com",
        subject: "Hello",
        body: "Plain text",
        html_body: "<h1>HTML content</h1>",
      },
    ]);
    expect(onSend).toHaveBeenCalledWith("actor-1", {
      to: "person@example.com",
      cc: [],
    });
  });
});
