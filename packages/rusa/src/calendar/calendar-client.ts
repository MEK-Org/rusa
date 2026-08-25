import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";
import { CalendarOAuth } from "./calendar-oauth.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarClient {
  listCalendars(pageToken?: string): Promise<unknown>;
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<unknown>;
  getEvent(calendarId: string, eventId: string): Promise<unknown>;
  createEvent(calendarId: string, event: unknown): Promise<unknown>;
  updateEvent(calendarId: string, eventId: string, event: unknown): Promise<unknown>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export interface CalendarClientProvider {
  legacyClient: CalendarClient;
  forAccount(email: string): CalendarClient;
}

/** Google Calendar REST client authenticated with the calendar-only OAuth token. */
export class GoogleCalendarClient implements CalendarClient {
  private readonly oauth: CalendarOAuth;

  constructor(
    configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch,
    tokenFilename = "calendar-token.json",
    expectedEmail?: string
  ) {
    this.oauth = new CalendarOAuth(configDir, fetchImpl, tokenFilename, expectedEmail);
  }

  listCalendars(pageToken?: string): Promise<unknown> {
    return this.get("users/me/calendarList", pageToken ? { pageToken } : undefined);
  }

  private async get(path: string, query?: Record<string, string>): Promise<unknown> {
    const token = await this.oauth.token();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const resp = await this.fetchImpl(`${CALENDAR_API}/${path}${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(
        `calendar GET ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return resp.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const token = await this.oauth.token();
    const resp = await this.fetchImpl(`${CALENDAR_API}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `calendar POST ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return resp.json();
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    const token = await this.oauth.token();
    const resp = await this.fetchImpl(`${CALENDAR_API}/${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `calendar PUT ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return resp.json();
  }

  private async deleteReq(path: string): Promise<void> {
    const token = await this.oauth.token();
    const resp = await this.fetchImpl(`${CALENDAR_API}/${path}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(
        `calendar DELETE ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
  }

  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<unknown> {
    return this.get(`calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
    });
  }

  getEvent(calendarId: string, eventId: string): Promise<unknown> {
    return this.get(
      `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  }

  createEvent(calendarId: string, event: unknown): Promise<unknown> {
    return this.post(`calendars/${encodeURIComponent(calendarId)}/events`, event);
  }

  updateEvent(calendarId: string, eventId: string, event: unknown): Promise<unknown> {
    return this.put(
      `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      event
    );
  }

  deleteEvent(calendarId: string, eventId: string): Promise<void> {
    return this.deleteReq(
      `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  }
}

/**
 * Discovers account tokens by the Google identity embedded in each token file.
 * File names are deliberately not identities: the embedded email is rechecked
 * by CalendarOAuth before every access-token use.
 */
export class GoogleCalendarClientProvider implements CalendarClientProvider {
  readonly legacyClient: CalendarClient;
  private readonly accountClients = new Map<string, CalendarClient>();

  constructor(
    private readonly configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.legacyClient = new GoogleCalendarClient(configDir, fetchImpl);
  }

  forAccount(email: string): CalendarClient {
    if (!email) throw new Error("access denied: calendar account is required");
    const cached = this.accountClients.get(email);
    if (cached) return cached;
    const tokenFiles = new Map<string, string>();
    for (const entry of readdirSync(this.configDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith("calendar-token.json")) continue;
      const parsed = JSON.parse(readFileSync(join(this.configDir, entry.name), "utf8")) as {
        email?: unknown;
      };
      if (typeof parsed.email !== "string" || parsed.email.length === 0) continue;
      if (tokenFiles.has(parsed.email)) {
        throw new Error(`access denied: multiple calendar tokens identify account ${parsed.email}`);
      }
      tokenFiles.set(parsed.email, entry.name);
    }
    const tokenFilename = tokenFiles.get(email);
    if (!tokenFilename) {
      throw new Error(`access denied: no identity-verified calendar token for account ${email}`);
    }
    const client = new GoogleCalendarClient(this.configDir, this.fetchImpl, tokenFilename, email);
    this.accountClients.set(email, client);
    return client;
  }
}
