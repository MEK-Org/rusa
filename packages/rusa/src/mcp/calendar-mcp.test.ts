import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { CalendarClient, CalendarClientProvider } from "../calendar/calendar-client.js";
import {
  type CalendarReadObservation,
  type CalendarWriteObservation,
  createCalendarReadMcpServer,
  createCalendarWriteMcpServer,
} from "./calendar-mcp.js";

function fakeCalendarClient() {
  const calls: Array<{ method: string; calendarId: string; eventId?: string; body?: unknown }> = [];
  const client: CalendarClient = {
    listCalendars: async () => {
      calls.push({ method: "calendars", calendarId: "" });
      return { items: [{ id: "person@example.com" }] };
    },
    listEvents: async (calendarId) => {
      calls.push({ method: "list", calendarId });
      return { items: [{ id: "event-1", summary: "Planning" }] };
    },
    getEvent: async (calendarId, eventId) => {
      calls.push({ method: "get", calendarId, eventId });
      if (eventId === "non-existent" || eventId === "issue123") {
        throw new Error("HTTP 404 Not Found");
      }
      return { id: eventId, summary: "Planning" };
    },
    createEvent: async (calendarId, event) => {
      calls.push({ method: "create", calendarId, body: event });
      return event;
    },
    updateEvent: async (calendarId, eventId, event) => {
      calls.push({ method: "update", calendarId, eventId, body: event });
      return event;
    },
    deleteEvent: async (calendarId, eventId) => {
      calls.push({ method: "delete", calendarId, eventId });
    },
  };
  return { client, calls };
}

async function connect(
  calendarClient: CalendarClient,
  allowedCalendars: string[],
  options: {
    allowedAccounts?: string[];
    accountClients?: Record<string, CalendarClient>;
    onRead?: (actorId: string, observation: CalendarReadObservation) => void;
  } = {}
) {
  const clients: CalendarClientProvider = {
    legacyClient: calendarClient,
    forAccount: (email) => {
      const client = options.accountClients?.[email];
      if (!client) throw new Error(`no token for ${email}`);
      return client;
    },
  };
  const server = createCalendarReadMcpServer("actor-1", clients, {
    allowedCalendars,
    allowedAccounts: options.allowedAccounts ?? [],
    onRead: options.onRead,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function connectWrite(
  calendarClient: CalendarClient,
  allowedCalendars: string[],
  options: {
    onWrite?: (actorId: string, observation: CalendarWriteObservation) => void;
  } = {}
) {
  const clients: CalendarClientProvider = {
    legacyClient: calendarClient,
    forAccount: (_email) => {
      throw new Error("account grants not supported for write");
    },
  };
  const server = createCalendarWriteMcpServer("actor-1", clients, {
    allowedCalendars,
    onWrite: options.onWrite,
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

describe("calendar-read MCP server", () => {
  it("exposes only the direct calendar event read tools", async () => {
    const fake = fakeCalendarClient();
    const client = await connect(fake.client, ["person@example.com"]);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_event",
      "list_calendars",
      "list_events",
    ]);
  });

  it("reads events from an exactly allowed calendar", async () => {
    const fake = fakeCalendarClient();
    const onRead = vi.fn();
    const client = await connect(fake.client, ["person@example.com"], { onRead });

    const listed = (await client.callTool({
      name: "list_events",
      arguments: {
        calendarId: "person@example.com",
        timeMin: "2026-08-07T00:00:00Z",
        timeMax: "2026-08-14T00:00:00Z",
      },
    })) as CallToolResult;
    const fetched = (await client.callTool({
      name: "get_event",
      arguments: { calendarId: "person@example.com", eventId: "event-1" },
    })) as CallToolResult;

    expect(listed.isError).toBeFalsy();
    expect(fetched.isError).toBeFalsy();
    expect(JSON.parse(textOf(listed))).toMatchObject({ items: [{ id: "event-1" }] });
    expect(fake.calls).toEqual([
      { method: "list", calendarId: "person@example.com" },
      { method: "get", calendarId: "person@example.com", eventId: "event-1" },
    ]);
    expect(onRead.mock.calls).toEqual([
      ["actor-1", { operation: "list_events", calendarId: "person@example.com" }],
      ["actor-1", { operation: "get_event", calendarId: "person@example.com" }],
    ]);
  });

  it("denies every read when the allowed calendar list is empty", async () => {
    const fake = fakeCalendarClient();
    const client = await connect(fake.client, []);
    const result = (await client.callTool({
      name: "list_events",
      arguments: {
        calendarId: "person@example.com",
        timeMin: "2026-08-07T00:00:00Z",
        timeMax: "2026-08-14T00:00:00Z",
      },
    })) as CallToolResult;

    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("access denied");
    expect(fake.calls).toEqual([]);
  });

  it("requires an exact calendar ID match for list and get", async () => {
    const fake = fakeCalendarClient();
    const client = await connect(fake.client, ["person@example.com"]);

    const listed = (await client.callTool({
      name: "list_events",
      arguments: {
        calendarId: "PERSON@example.com",
        timeMin: "2026-08-07T00:00:00Z",
        timeMax: "2026-08-14T00:00:00Z",
      },
    })) as CallToolResult;
    const fetched = (await client.callTool({
      name: "get_event",
      arguments: { calendarId: "other@example.com", eventId: "event-1" },
    })) as CallToolResult;

    expect(listed.isError).toBeTruthy();
    expect(fetched.isError).toBeTruthy();
    expect(textOf(listed)).toContain("access denied");
    expect(textOf(fetched)).toContain("access denied");
    expect(fake.calls).toEqual([]);
  });

  it("enumerates and reads any calendar through exactly the granted account token", async () => {
    const legacy = fakeCalendarClient();
    const account = fakeCalendarClient();
    const onRead = vi.fn();
    const client = await connect(legacy.client, [], {
      allowedAccounts: ["a@example.com"],
      accountClients: { "a@example.com": account.client },
      onRead,
    });

    const calendars = (await client.callTool({
      name: "list_calendars",
      arguments: { account: "a@example.com" },
    })) as CallToolResult;
    const events = (await client.callTool({
      name: "list_events",
      arguments: {
        account: "a@example.com",
        calendarId: "shared-with-a@example.com",
        timeMin: "2026-08-07T00:00:00Z",
        timeMax: "2026-08-14T00:00:00Z",
      },
    })) as CallToolResult;

    expect(calendars.isError).toBeFalsy();
    expect(events.isError).toBeFalsy();
    expect(legacy.calls).toEqual([]);
    expect(account.calls).toEqual([
      { method: "calendars", calendarId: "" },
      { method: "list", calendarId: "shared-with-a@example.com" },
    ]);
    expect(onRead).toHaveBeenCalledWith("actor-1", {
      operation: "list_events",
      account: "a@example.com",
      calendarId: "shared-with-a@example.com",
    });
  });

  it("never lets an account A grant select account B's client", async () => {
    const legacy = fakeCalendarClient();
    const accountA = fakeCalendarClient();
    const accountB = fakeCalendarClient();
    const client = await connect(legacy.client, [], {
      allowedAccounts: ["a@example.com"],
      accountClients: {
        "a@example.com": accountA.client,
        "b@example.com": accountB.client,
      },
    });

    const result = (await client.callTool({
      name: "list_events",
      arguments: {
        account: "b@example.com",
        calendarId: "b-private@example.com",
        timeMin: "2026-08-07T00:00:00Z",
        timeMax: "2026-08-14T00:00:00Z",
      },
    })) as CallToolResult;

    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("access denied");
    expect(legacy.calls).toEqual([]);
    expect(accountA.calls).toEqual([]);
    expect(accountB.calls).toEqual([]);
  });

  it("does not fall back from a legacy calendar grant to an account token", async () => {
    const legacy = fakeCalendarClient();
    const account = fakeCalendarClient();
    const client = await connect(legacy.client, ["allowed@example.com"], {
      allowedAccounts: ["a@example.com"],
      accountClients: { "a@example.com": account.client },
    });
    const denied = (await client.callTool({
      name: "get_event",
      arguments: { calendarId: "account-only@example.com", eventId: "event-1" },
    })) as CallToolResult;

    expect(denied.isError).toBeTruthy();
    expect(legacy.calls).toEqual([]);
    expect(account.calls).toEqual([]);
  });
});

describe("calendar-write MCP server", () => {
  it("exposes write tools", async () => {
    const fake = fakeCalendarClient();
    const client = await connectWrite(fake.client, ["person@example.com"]);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(["clear_event", "upsert_event"]);
  });

  it("denies write to unallowed calendars", async () => {
    const fake = fakeCalendarClient();
    const client = await connectWrite(fake.client, ["allowed@example.com"]);

    const upsertDenied = (await client.callTool({
      name: "upsert_event",
      arguments: {
        calendarId: "other@example.com",
        issueNumber: 123,
        date: "2026-08-08",
      },
    })) as CallToolResult;

    const clearDenied = (await client.callTool({
      name: "clear_event",
      arguments: {
        calendarId: "other@example.com",
        issueNumber: 123,
      },
    })) as CallToolResult;

    expect(upsertDenied.isError).toBeTruthy();
    expect(textOf(upsertDenied)).toContain("access denied");
    expect(clearDenied.isError).toBeTruthy();
    expect(textOf(clearDenied)).toContain("access denied");
    expect(fake.calls).toEqual([]);
  });

  it("upserts event (create vs update)", async () => {
    const fake = fakeCalendarClient();
    const onWrite = vi.fn();
    const client = await connectWrite(fake.client, ["allowed@example.com"], { onWrite });

    // 1. Existing event (update)
    const updateResult = (await client.callTool({
      name: "upsert_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 456,
        date: "2026-08-08",
        summary: "Update Issue",
        description: "Updated planning",
      },
    })) as CallToolResult;

    expect(updateResult.isError).toBeFalsy();
    expect(fake.calls[0]).toEqual({
      method: "get",
      calendarId: "allowed@example.com",
      eventId: "issue456",
    });
    expect(fake.calls[1]).toEqual({
      method: "update",
      calendarId: "allowed@example.com",
      eventId: "issue456",
      body: {
        id: "issue456",
        summary: "Update Issue",
        description: "Updated planning",
        start: { date: "2026-08-08" },
        end: { date: "2026-08-09" },
      },
    });

    // 2. Non-existent event (create)
    const createResult = (await client.callTool({
      name: "upsert_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 123,
        date: "2026-08-08",
      },
    })) as CallToolResult;

    expect(createResult.isError).toBeFalsy();
    expect(fake.calls[2]).toEqual({
      method: "get",
      calendarId: "allowed@example.com",
      eventId: "issue123",
    });
    expect(fake.calls[3]).toEqual({
      method: "create",
      calendarId: "allowed@example.com",
      body: {
        id: "issue123",
        summary: "Issue #123",
        description: "Projection of Issue #123",
        start: { date: "2026-08-08" },
        end: { date: "2026-08-09" },
      },
    });

    expect(onWrite.mock.calls).toEqual([
      [
        "actor-1",
        { operation: "upsert_event", calendarId: "allowed@example.com", issueNumber: 456 },
      ],
      [
        "actor-1",
        { operation: "upsert_event", calendarId: "allowed@example.com", issueNumber: 123 },
      ],
    ]);
  });

  it("clears event (skips delete if not exists)", async () => {
    const fake = fakeCalendarClient();
    const onWrite = vi.fn();
    const client = await connectWrite(fake.client, ["allowed@example.com"], { onWrite });

    // 1. Existing event (delete)
    const clearResult1 = (await client.callTool({
      name: "clear_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 456,
      },
    })) as CallToolResult;

    expect(clearResult1.isError).toBeFalsy();
    expect(JSON.parse(textOf(clearResult1))).toEqual({ success: true, cleared: true });
    expect(fake.calls[0]).toEqual({
      method: "get",
      calendarId: "allowed@example.com",
      eventId: "issue456",
    });
    expect(fake.calls[1]).toEqual({
      method: "delete",
      calendarId: "allowed@example.com",
      eventId: "issue456",
    });

    // 2. Non-existent event (skip delete)
    const clearResult2 = (await client.callTool({
      name: "clear_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 123,
      },
    })) as CallToolResult;

    expect(clearResult2.isError).toBeFalsy();
    expect(JSON.parse(textOf(clearResult2))).toEqual({ success: true, cleared: false });
    expect(fake.calls[2]).toEqual({
      method: "get",
      calendarId: "allowed@example.com",
      eventId: "issue123",
    });
    expect(fake.calls.length).toBe(3); // no delete call appended

    expect(onWrite.mock.calls).toEqual([
      [
        "actor-1",
        { operation: "clear_event", calendarId: "allowed@example.com", issueNumber: 456 },
      ],
      [
        "actor-1",
        { operation: "clear_event", calendarId: "allowed@example.com", issueNumber: 123 },
      ],
    ]);
  });

  it("propagates non-404 getEvent errors", async () => {
    const fake = fakeCalendarClient();
    fake.client.getEvent = async (calendarId, eventId) => {
      fake.calls.push({ method: "get", calendarId, eventId });
      throw new Error("HTTP 500 Internal Server Error");
    };

    const client = await connectWrite(fake.client, ["allowed@example.com"]);

    const upsertResult = (await client.callTool({
      name: "upsert_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 123,
        date: "2026-08-08",
      },
    })) as CallToolResult;

    const clearResult = (await client.callTool({
      name: "clear_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 123,
      },
    })) as CallToolResult;

    expect(upsertResult.isError).toBeTruthy();
    expect(textOf(upsertResult)).toContain("HTTP 500");
    expect(clearResult.isError).toBeTruthy();
    expect(textOf(clearResult)).toContain("HTTP 500");
  });

  it("handles create 409 Conflict fallback to update in upsert_event", async () => {
    const fake = fakeCalendarClient();

    // Simulate non-existence so it goes to create path
    fake.client.getEvent = async (calendarId, eventId) => {
      fake.calls.push({ method: "get", calendarId, eventId });
      throw new Error("HTTP 404 Not Found");
    };

    // Simulate 409 on create
    fake.client.createEvent = async (calendarId, event) => {
      fake.calls.push({ method: "create", calendarId, body: event });
      throw new Error("HTTP 409 Conflict");
    };

    const client = await connectWrite(fake.client, ["allowed@example.com"]);

    const result = (await client.callTool({
      name: "upsert_event",
      arguments: {
        calendarId: "allowed@example.com",
        issueNumber: 123,
        date: "2026-08-08",
        summary: "Tombstone test",
        description: "Trying to revive",
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();

    // Calls should be: getEvent (throws 404) -> createEvent (throws 409) -> updateEvent (succeeds)
    expect(fake.calls[0]).toEqual({
      method: "get",
      calendarId: "allowed@example.com",
      eventId: "issue123",
    });
    expect(fake.calls[1]).toEqual({
      method: "create",
      calendarId: "allowed@example.com",
      body: {
        id: "issue123",
        summary: "Tombstone test",
        description: "Trying to revive",
        start: { date: "2026-08-08" },
        end: { date: "2026-08-09" },
      },
    });
    expect(fake.calls[2]).toEqual({
      method: "update",
      calendarId: "allowed@example.com",
      eventId: "issue123",
      body: {
        id: "issue123",
        summary: "Tombstone test",
        description: "Trying to revive",
        start: { date: "2026-08-08" },
        end: { date: "2026-08-09" },
        status: "confirmed",
      },
    });
  });
});
