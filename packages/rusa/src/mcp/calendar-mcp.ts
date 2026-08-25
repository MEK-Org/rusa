import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarClientProvider } from "../calendar/calendar-client.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const CALENDAR_READ_MCP_NAME = "calendar-read";

export interface CalendarReadObservation {
  operation: "list_calendars" | "list_events" | "get_event";
  account?: string;
  calendarId?: string;
}

/** Read-only Calendar tools whose authorization is enforced at the server boundary. */
export function createCalendarReadMcpServer(
  actorId: string,
  clients: CalendarClientProvider,
  options: {
    allowedCalendars: string[];
    allowedAccounts: string[];
    onRead?: (actorId: string, observation: CalendarReadObservation) => void;
    isFenced?: () => boolean;
  }
): McpServer {
  const server = createMcpServer(
    { name: CALENDAR_READ_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );

  const clientFor = (calendarId: string, account?: string) => {
    if (account !== undefined) {
      if (!options.allowedAccounts.includes(account)) {
        throw new Error(`access denied: account ${account} is not in allowed accounts`);
      }
      return clients.forAccount(account);
    }
    if (!options.allowedCalendars || !options.allowedCalendars.includes(calendarId)) {
      throw new Error(`access denied: calendar ${calendarId} is not in allowed calendars`);
    }
    return clients.legacyClient;
  };

  server.registerTool(
    "list_calendars",
    {
      title: "List calendars visible to an allowed Google account",
      description: "Enumerate every calendar visible to one explicitly granted Google account.",
      inputSchema: {
        account: z.string().email(),
        pageToken: z.string().optional().describe("Google page token returned by the prior page"),
      },
    },
    async ({ account, pageToken }) => {
      try {
        if (!options.allowedAccounts.includes(account)) {
          throw new Error(`access denied: account ${account} is not in allowed accounts`);
        }
        const result = await clients.forAccount(account).listCalendars(pageToken);
        options.onRead?.(actorId, { operation: "list_calendars", account });
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_events",
    {
      title: "List events from an allowed Google Calendar",
      description:
        "Read events between two RFC 3339 timestamps. Omit account for a legacy calendar-ID grant; provide account for a whole-account grant.",
      inputSchema: {
        calendarId: z.string(),
        account: z.string().email().optional(),
        timeMin: z.string().describe("Inclusive lower bound as an RFC 3339 timestamp"),
        timeMax: z.string().describe("Exclusive upper bound as an RFC 3339 timestamp"),
      },
    },
    async ({ calendarId, account, timeMin, timeMax }) => {
      try {
        const result = await clientFor(calendarId, account).listEvents(
          calendarId,
          timeMin,
          timeMax
        );
        options.onRead?.(actorId, {
          operation: "list_events",
          calendarId,
          ...(account === undefined ? {} : { account }),
        });
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_event",
    {
      title: "Get an event from an allowed Google Calendar",
      description:
        "Read one event by calendar ID and event ID. Omit account for a legacy calendar-ID grant; provide account for a whole-account grant.",
      inputSchema: {
        calendarId: z.string(),
        account: z.string().email().optional(),
        eventId: z.string(),
      },
    },
    async ({ calendarId, account, eventId }) => {
      try {
        const result = await clientFor(calendarId, account).getEvent(calendarId, eventId);
        options.onRead?.(actorId, {
          operation: "get_event",
          calendarId,
          ...(account === undefined ? {} : { account }),
        });
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}

export const CALENDAR_WRITE_MCP_NAME = "calendar-write";

export interface CalendarWriteObservation {
  operation: "upsert_event" | "clear_event";
  calendarId: string;
  issueNumber: number;
}

/** Write-enabled Calendar tools whose authorization is enforced at the server boundary. */
export function createCalendarWriteMcpServer(
  actorId: string,
  clients: CalendarClientProvider,
  options: {
    allowedCalendars: string[];
    onWrite?: (actorId: string, observation: CalendarWriteObservation) => void;
    isFenced?: () => boolean;
  }
): McpServer {
  const server = createMcpServer(
    { name: CALENDAR_WRITE_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );

  const clientFor = (calendarId: string) => {
    if (!options.allowedCalendars || !options.allowedCalendars.includes(calendarId)) {
      throw new Error(`access denied: calendar ${calendarId} is not in allowed calendars`);
    }
    return clients.legacyClient;
  };

  server.registerTool(
    "upsert_event",
    {
      title: "Upsert event keyed on issue number",
      description:
        "Create or update an all-day event for a planned day-slot, keyed on the issue number.",
      inputSchema: {
        calendarId: z.string(),
        issueNumber: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format"),
        summary: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ calendarId, issueNumber, date, summary, description }) => {
      try {
        const client = clientFor(calendarId);
        const eventId = `issue${issueNumber}`;

        // Calculate end date (exclusive for all-day events)
        const [year, month, day] = date.split("-").map(Number);
        const endDate = new Date(Date.UTC(year, month - 1, day + 1));
        const endDateStr = endDate.toISOString().split("T")[0];

        const eventBody = {
          id: eventId,
          summary: summary || `Issue #${issueNumber}`,
          description: description || `Projection of Issue #${issueNumber}`,
          start: { date },
          end: { date: endDateStr },
        };

        let exists = false;
        try {
          await client.getEvent(calendarId, eventId);
          exists = true;
        } catch (err: unknown) {
          const is404 = err instanceof Error && err.message.includes("HTTP 404");
          if (!is404) throw err;
        }

        let result: unknown;
        if (exists) {
          result = await client.updateEvent(calendarId, eventId, eventBody);
        } else {
          try {
            result = await client.createEvent(calendarId, eventBody);
          } catch (err: unknown) {
            const is409 = err instanceof Error && err.message.includes("HTTP 409");
            if (!is409) throw err;
            result = await client.updateEvent(calendarId, eventId, {
              ...eventBody,
              status: "confirmed",
            });
          }
        }

        options.onWrite?.(actorId, {
          operation: "upsert_event",
          calendarId,
          issueNumber,
        });
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "clear_event",
    {
      title: "Clear event keyed on issue number",
      description: "Delete the calendar event associated with the specified issue number.",
      inputSchema: {
        calendarId: z.string(),
        issueNumber: z.number().int().positive(),
      },
    },
    async ({ calendarId, issueNumber }) => {
      try {
        const client = clientFor(calendarId);
        const eventId = `issue${issueNumber}`;

        let exists = false;
        try {
          await client.getEvent(calendarId, eventId);
          exists = true;
        } catch (err: unknown) {
          const is404 = err instanceof Error && err.message.includes("HTTP 404");
          if (!is404) throw err;
        }

        if (exists) {
          await client.deleteEvent(calendarId, eventId);
        }

        options.onWrite?.(actorId, {
          operation: "clear_event",
          calendarId,
          issueNumber,
        });
        return toolOk({ success: true, cleared: exists });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
