import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface InstalledClient {
  client_id: string;
  client_secret: string;
}

interface GchatToken {
  refresh_token: string;
  email?: string;
  user_id?: string;
}

/** Default location of the gchat user-OAuth credentials. */
export function defaultGchatConfigDir(): string {
  return join(homedir(), ".config", "gchat");
}

export interface GchatIdentity {
  /** Resource name `users/{id}` — used to suppress self-messages. */
  userId: string;
  email?: string;
}

/** Read the authenticated user's identity from token.json. */
export function loadGchatIdentity(configDir = defaultGchatConfigDir()): GchatIdentity {
  const tok = JSON.parse(readFileSync(join(configDir, "token.json"), "utf-8")) as GchatToken;
  if (!tok.user_id) {
    throw new Error(
      `gchat token.json is missing user_id (looked in ${configDir}); re-run gchat-auth`
    );
  }
  return { userId: `users/${tok.user_id}`, email: tok.email };
}

/**
 * Mints (and caches) Google user-OAuth access tokens from the gchat credentials
 * (`client.json` + `token.json` produced by `gchat-auth`): trade the stored
 * refresh token for an access token and reuse it until shortly before expiry.
 * Shared by every component that calls Google APIs as the gchat user (the Chat
 * REST client and the Workspace Events subscriber).
 */
export class GchatOAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const client = (
      JSON.parse(readFileSync(join(this.configDir, "client.json"), "utf-8")) as {
        installed: InstalledClient;
      }
    ).installed;
    const tok = JSON.parse(readFileSync(join(this.configDir, "token.json"), "utf-8")) as GchatToken;
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
      throw new Error(`gchat token refresh failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    const json = (await resp.json()) as { access_token: string; expires_in?: number };
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
