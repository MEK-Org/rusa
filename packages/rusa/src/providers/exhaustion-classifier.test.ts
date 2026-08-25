import { beforeEach, describe, expect, it, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

vi.mock("../understanding/gemini-utils.js", () => ({
  getGeminiClient: () => ({
    models: {
      generateContent: gemini.generateContent,
    },
  }),
  extractGeminiText: async (response: { text?: string }) => response.text ?? "",
}));

import { classifyRunExhaustion, deterministicExhaustionFallback } from "./exhaustion-classifier.js";

describe("exhaustion classifier", () => {
  beforeEach(() => {
    gemini.generateContent.mockReset();
  });

  it("matches the field-reproduced Claude session-limit string on the deterministic path", () => {
    expect(
      deterministicExhaustionFallback("You've hit your session limit · resets 6:20pm (UTC)")
    ).toBe("quota");
  });

  it("classifies network transients as transient-network and logs them", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transientStrings = [
      "connection timed out",
      "connection timeout",
      "network changed",
      "network change",
      "socket hang up",
      "ETIMEDOUT",
      "connect ETIMEDOUT 142.250.180.14:443",
      "read ETIMEDOUT",
      "ENETUNREACH",
      "connect ENETUNREACH 142.250.180.14:443",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ECONNRESET",
      "read ECONNRESET",
      "ECONNREFUSED",
      "connect ECONNREFUSED 127.0.0.1:8080",
      "ECONNABORTED",
      "getaddrinfo ENOTFOUND api.anthropic.com",
      "getaddrinfo EAI_AGAIN api.anthropic.com",
      "EAI_AGAIN",
      "fetch failed",
      "TypeError: fetch failed",
      "network error",
      "net::ERR_NETWORK_CHANGED",
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_CONNECTION_TIMED_OUT",
      "net::ERR_CONNECTION_RESET",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_ADDRESS_UNREACHABLE",
      "temporary failure in name resolution",
      "tls handshake timeout",
      "ssl handshake timeout",
      "request timed out",
      "504 Gateway Timeout",
      "502 Bad Gateway",
      "503 Service Unavailable",
      "ClientNetworkError: connection closed before response",
      "ConnectTimeoutError",
      "SocketTimeoutError",
      "Rate limit check failed: connect ETIMEDOUT 1.2.3.4:443",
    ];

    for (const str of transientStrings) {
      expect(
        deterministicExhaustionFallback(str),
        `expected '${str}' to be transient-network`
      ).toBe("transient-network");
    }

    // Unrelated non-quota errors must fail toward 'unknown', never 'quota'
    expect(
      deterministicExhaustionFallback("SyntaxError: Unexpected token < in JSON at position 0")
    ).toBe("unknown");
    expect(
      deterministicExhaustionFallback(
        "TypeError: Cannot read properties of undefined (reading 'foo')"
      )
    ).toBe("unknown");

    // Without API key
    const res1 = await classifyRunExhaustion({
      success: false,
      output: "connect ETIMEDOUT 142.250.180.14:443",
      exitCode: 1,
    });
    expect(res1).toEqual({ exhausted: false });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient network error detected in fallback")
    );

    warnSpy.mockClear();

    // With API key but classifier throws (e.g. network down)
    gemini.generateContent.mockRejectedValueOnce(new Error("gemini unreachable"));
    const res2 = await classifyRunExhaustion(
      { success: false, output: "network changed", exitCode: 1 },
      "gemini-key"
    );
    expect(res2).toEqual({ exhausted: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Remote classifier failed"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Transient network error detected in fallback")
    );

    warnSpy.mockRestore();
  });

  it("scrubs in-flight tool-call/request payloads out of the text sent to the remote classifier", async () => {
    gemini.generateContent.mockResolvedValueOnce({ text: '{"exhausted":true}' });

    const output = [
      "Tool execution log:",
      '{"name":"deploy","arguments":{"token":"sk-SUPERSECRET-123","target":"prod"}}',
      '<tool_call>{"password":"hunter2"}</tool_call>',
      "Error: You've hit your session limit · resets 6:20pm (UTC)",
    ].join("\n");

    const result = await classifyRunExhaustion(
      { success: false, output, exitCode: 1 },
      "gemini-key"
    );

    expect(result).toEqual({ exhausted: true });
    expect(gemini.generateContent).toHaveBeenCalledTimes(1);
    const sent = gemini.generateContent.mock.calls[0][0].contents as string;
    // Payloads must not leave the process...
    expect(sent).not.toContain("SUPERSECRET");
    expect(sent).not.toContain("hunter2");
    expect(sent).toContain("[scrubbed]");
    // ...but the exhaustion signal the classifier needs must survive.
    expect(sent).toContain("session limit");
  });

  it("degrades to the deterministic exhaustion matcher when the LLM classifier fails", async () => {
    gemini.generateContent.mockRejectedValueOnce(new Error("gemini unavailable"));

    await expect(
      classifyRunExhaustion(
        {
          success: false,
          output: "You've hit your session limit · resets 6:20pm (UTC)",
          exitCode: 1,
        },
        "gemini-key"
      )
    ).resolves.toEqual({ exhausted: true });
    expect(gemini.generateContent).toHaveBeenCalledTimes(1);
  });
});
