import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";
import { GmailOAuth } from "./gmail-oauth.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
  html_body?: string;
}

export interface GmailClient {
  sendEmail(input: SendEmailInput): Promise<unknown>;
}

/** Gmail REST client authenticated with the separate Gmail OAuth token. */
export class GoogleGmailClient implements GmailClient {
  private readonly oauth: GmailOAuth;

  constructor(
    configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.oauth = new GmailOAuth(configDir, fetchImpl);
  }

  async sendEmail(input: SendEmailInput): Promise<unknown> {
    const token = await this.oauth.token();
    let raw: string;
    if (typeof input.html_body === "string") {
      const boundary = `----=_Part_${Math.random().toString(36).substring(2)}`;
      const headers = [
        `To: ${input.to}`,
        ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
        `Subject: ${input.subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ];
      // Order: text/plain then text/html
      const multipartBody = [
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        input.body,
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        input.html_body,
        `--${boundary}--`,
      ].join("\r\n");
      raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${multipartBody}`, "utf8").toString(
        "base64url"
      );
    } else {
      const headers = [
        `To: ${input.to}`,
        ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
        `Subject: ${input.subject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
      ];
      // Deliberately omit From: Gmail sends as the authenticated bot account and
      // no caller-controlled send-as identity reaches the API.
      raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.body}`, "utf8").toString(
        "base64url"
      );
    }
    const resp = await this.fetchImpl(`${GMAIL_API}/users/me/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (!resp.ok) {
      throw new Error(`gmail send -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    return resp.json();
  }
}
