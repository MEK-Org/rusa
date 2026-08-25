import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GoogleGmailClient } from "./gmail-client.js";

describe("GoogleGmailClient", () => {
  it("uses gmail-token.json and sends as users/me without a From header", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gmail-client-test-"));
    writeFileSync(
      join(configDir, "client.json"),
      JSON.stringify({ installed: { client_id: "client-id", client_secret: "client-secret" } })
    );
    writeFileSync(
      join(configDir, "gmail-token.json"),
      JSON.stringify({ refresh_token: "refresh" })
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
    const client = new GoogleGmailClient(configDir, fetchImpl);

    await client.sendEmail({
      to: "person@example.com",
      cc: ["copy@example.com"],
      subject: "Subject",
      body: "Plain body",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    );
    const request = fetchImpl.mock.calls[1]?.[1];
    const requestBody = JSON.parse(String(request?.body)) as { raw: string };
    const mime = Buffer.from(requestBody.raw, "base64url").toString("utf8");
    expect(mime).toContain("To: person@example.com\r\n");
    expect(mime).toContain("Cc: copy@example.com\r\n");
    expect(mime).toContain("Subject: Subject\r\n");
    expect(mime).toContain("\r\n\r\nPlain body");
    expect(mime).not.toMatch(/^From:/m);
  });

  it("omits html_body -> single-part text/plain, no multipart container (byte-identical to original)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gmail-client-test-"));
    writeFileSync(
      join(configDir, "client.json"),
      JSON.stringify({ installed: { client_id: "client-id", client_secret: "client-secret" } })
    );
    writeFileSync(
      join(configDir, "gmail-token.json"),
      JSON.stringify({ refresh_token: "refresh" })
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
    const client = new GoogleGmailClient(configDir, fetchImpl);

    await client.sendEmail({
      to: "person@example.com",
      cc: ["copy@example.com"],
      subject: "Subject",
      body: "Plain body",
    });

    const request = fetchImpl.mock.calls[1]?.[1];
    const requestBody = JSON.parse(String(request?.body)) as { raw: string };
    const mime = Buffer.from(requestBody.raw, "base64url").toString("utf8");

    // The expected raw MIME for single-part plain text
    const expectedMime = [
      "To: person@example.com",
      "Cc: copy@example.com",
      "Subject: Subject",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "Plain body",
    ].join("\r\n");

    expect(mime).toBe(expectedMime);
  });

  it("includes html_body -> multipart/alternative MIME message with plain and html parts in correct order", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gmail-client-test-"));
    writeFileSync(
      join(configDir, "client.json"),
      JSON.stringify({ installed: { client_id: "client-id", client_secret: "client-secret" } })
    );
    writeFileSync(
      join(configDir, "gmail-token.json"),
      JSON.stringify({ refresh_token: "refresh" })
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
    const client = new GoogleGmailClient(configDir, fetchImpl);

    await client.sendEmail({
      to: "person@example.com",
      cc: ["copy@example.com"],
      subject: "Subject",
      body: "Plain body",
      html_body: "<h1>HTML body</h1>",
    });

    const request = fetchImpl.mock.calls[1]?.[1];
    const requestBody = JSON.parse(String(request?.body)) as { raw: string };
    const mime = Buffer.from(requestBody.raw, "base64url").toString("utf8");

    // Retrieve the dynamic boundary from Content-Type header
    const match = mime.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/);
    expect(match).not.toBeNull();
    const boundary = match ? match[1] : "";

    const expectedMime = [
      "To: person@example.com",
      "Cc: copy@example.com",
      "Subject: Subject",
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "Plain body",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "<h1>HTML body</h1>",
      `--${boundary}--`,
    ].join("\r\n");

    expect(mime).toBe(expectedMime);
  });
});
