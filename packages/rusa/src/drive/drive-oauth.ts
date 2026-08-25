import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface InstalledClient {
  client_id: string;
  client_secret: string;
}

interface DriveToken {
  refresh_token: string;
}

/**
 * Mints Google Drive access tokens from the Drive refresh token.
 */
export class DriveOAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tokenFilename = "drive-token.json"
  ) {}

  async token(): Promise<string> {
    const tok = JSON.parse(
      readFileSync(join(this.configDir, this.tokenFilename), "utf-8")
    ) as DriveToken;
    if (typeof tok.refresh_token !== "string" || tok.refresh_token.length === 0) {
      throw new Error("drive token is missing a refresh token");
    }
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;

    const client = (
      JSON.parse(readFileSync(join(this.configDir, "client.json"), "utf-8")) as {
        installed: InstalledClient;
      }
    ).installed;

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
      throw new Error(
        `drive token refresh failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    const json = (await resp.json()) as { access_token: string; expires_in?: number };
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
