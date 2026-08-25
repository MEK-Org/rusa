import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClientProvider } from "./calendar-client.js";

function writeAccountToken(dir: string, filename: string, email: string): void {
  writeFileSync(
    join(dir, filename),
    JSON.stringify({
      email,
      refresh_token: "mock-refresh-token",
      client_id: "mock-client-id",
      client_secret: "mock-client-secret",
    })
  );
}

describe("GoogleCalendarClientProvider", () => {
  it("indexes account token files by embedded email and mocks Calendar API access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-account-test-"));
    writeAccountToken(dir, "arbitrary-calendar-token.json", "a@example.com");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: "shared@example.com" }] }), { status: 200 })
      );

    const result = await new GoogleCalendarClientProvider(dir, fetchImpl)
      .forAccount("a@example.com")
      .listCalendars();

    expect(result).toEqual({ items: [{ id: "shared@example.com" }] });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    ]);
  });

  it("fails closed when a filename label does not match its embedded identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-account-test-"));
    writeAccountToken(dir, "a-calendar-token.json", "b@example.com");
    const provider = new GoogleCalendarClientProvider(dir, vi.fn<typeof fetch>());

    expect(() => provider.forAccount("a@example.com")).toThrow(
      "no identity-verified calendar token"
    );
  });

  it("reasserts embedded identity before use if a discovered token is swapped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-account-test-"));
    const filename = "principal-calendar-token.json";
    writeAccountToken(dir, filename, "a@example.com");
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new GoogleCalendarClientProvider(dir, fetchImpl).forAccount("a@example.com");
    writeAccountToken(dir, filename, "b@example.com");

    await expect(client.listCalendars()).rejects.toThrow("calendar token identity mismatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fall back to the legacy shared OAuth client for an account token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-account-test-"));
    writeFileSync(
      join(dir, "client.json"),
      JSON.stringify({ installed: { client_id: "legacy-id", client_secret: "legacy-secret" } })
    );
    writeFileSync(
      join(dir, "principal-calendar-token.json"),
      JSON.stringify({ email: "a@example.com", refresh_token: "mock-refresh-token" })
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new GoogleCalendarClientProvider(dir, fetchImpl).forAccount("a@example.com");

    await expect(client.listCalendars()).rejects.toThrow(
      "identity-scoped calendar token is missing embedded OAuth client fields"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on duplicate embedded identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-account-test-"));
    writeAccountToken(dir, "one-calendar-token.json", "a@example.com");
    writeAccountToken(dir, "two-calendar-token.json", "a@example.com");

    expect(() =>
      new GoogleCalendarClientProvider(dir, vi.fn<typeof fetch>()).forAccount("a@example.com")
    ).toThrow("multiple calendar tokens identify account");
  });
});
