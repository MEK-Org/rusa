import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface InstalledClient {
  client_id: string;
  client_secret: string;
}

interface CalendarToken {
  refresh_token: string;
  email?: string;
  client_id?: string;
  client_secret?: string;
}

/**
 * Mints Google Calendar access tokens from the calendar-only refresh token.
 * The OAuth client is shared with Chat, but its token file deliberately is not.
 */
export class CalendarOAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tokenFilename = "calendar-token.json",
    private readonly expectedEmail?: string
  ) {}

  async token(): Promise<string> {
    const tok = JSON.parse(
      readFileSync(join(this.configDir, this.tokenFilename), "utf-8")
    ) as CalendarToken;
    if (typeof tok.refresh_token !== "string" || tok.refresh_token.length === 0) {
      throw new Error("calendar token is missing a refresh token");
    }
    if (this.expectedEmail !== undefined && tok.email !== this.expectedEmail) {
      throw new Error(
        `calendar token identity mismatch: requested ${this.expectedEmail}, token identifies ${tok.email ?? "no account"}`
      );
    }
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    let client: InstalledClient;
    if (this.expectedEmail !== undefined) {
      if (
        typeof tok.client_id !== "string" ||
        tok.client_id.length === 0 ||
        typeof tok.client_secret !== "string" ||
        tok.client_secret.length === 0
      ) {
        throw new Error("identity-scoped calendar token is missing embedded OAuth client fields");
      }
      client = { client_id: tok.client_id, client_secret: tok.client_secret };
    } else {
      client = (
        JSON.parse(readFileSync(join(this.configDir, "client.json"), "utf-8")) as {
          installed: InstalledClient;
        }
      ).installed;
    }
    const resp = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tok.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) {
      throw new Error(`calendar token refresh failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    const json = (await resp.json()) as { access_token: string; expires_in?: number };
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
