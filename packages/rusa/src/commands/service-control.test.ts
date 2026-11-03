import { afterEach, describe, expect, it, vi } from "vitest";
import { runServiceShutdown } from "./service-control.js";

describe("service-control runServiceShutdown", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("sends POST to /api/mesh/shutdown with parameters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: "Drain started" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runServiceShutdown({
      url: "http://127.0.0.1:4000",
      timeout: 300,
      behavior: "cancel",
      reason: "manual test",
    });

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/api/mesh/shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeoutSeconds: 300,
        timeoutBehavior: "cancel",
        reason: "manual test",
      }),
    });
    expect(consoleSpy).toHaveBeenCalledWith("Drain started");
  });

  it("sends POST to /api/mesh/shutdown/cancel when cancel option is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: "Shutdown cancelled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runServiceShutdown({
      url: "http://127.0.0.1:4000",
      cancel: true,
      reason: "never mind",
    });

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/api/mesh/shutdown/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "never mind",
      }),
    });
    expect(consoleSpy).toHaveBeenCalledWith("Shutdown cancelled");
  });

  it("sets process.exitCode on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "Already shutting down" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runServiceShutdown({
      url: "http://127.0.0.1:4000",
    });

    expect(errorSpy).toHaveBeenCalledWith("Failed to request shutdown: Already shutting down");
    expect(process.exitCode).toBe(1);
  });

  it("sets process.exitCode on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runServiceShutdown({
      url: "http://127.0.0.1:4000",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to connect to Rusa service at http://127.0.0.1:4000: Connection refused"
    );
    expect(process.exitCode).toBe(1);
  });
});
