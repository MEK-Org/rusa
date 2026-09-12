import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const CSRF_COOKIE = "__Host-rusa_csrf";
export const CSRF_HEADER = "x-rusa-csrf";

function uniqueCookie(req: IncomingMessage, name: string): string | undefined {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}

/** Signed double-submit token, bound to the exact session cookie when authenticated.
 * The host-only Secure prefix prevents sibling domains from injecting the cookie.
 * A new process key invalidates CSRF tokens, not Firebase sessions; bootstrap repairs them. */
export class DashboardCsrf {
  private readonly key = randomBytes(32);

  private signature(nonce: string, session: string): string {
    return createHmac("sha256", this.key)
      .update(JSON.stringify([session, nonce]))
      .digest("hex");
  }

  private valid(token: string | undefined, session: string): boolean {
    if (!token || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
    const [nonce, signature] = token.split(".");
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(this.signature(nonce, session), "hex")
    );
  }

  verify(req: IncomingMessage, session: string): boolean {
    const cookie = uniqueCookie(req, CSRF_COOKIE);
    const header = req.headers[CSRF_HEADER];
    return typeof header === "string" && cookie === header && this.valid(cookie, session);
  }

  issue(req: IncomingMessage, res: ServerResponse, session: string, maxAge: number): void {
    let token = uniqueCookie(req, CSRF_COOKIE);
    if (!this.valid(token, session)) {
      const nonce = randomBytes(32).toString("hex");
      token = `${nonce}.${this.signature(nonce, session)}`;
    }
    // Intentionally readable by same-origin JavaScript, unlike the authentication cookie.
    res.appendHeader(
      "Set-Cookie",
      `${CSRF_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; SameSite=Strict`
    );
  }
}
