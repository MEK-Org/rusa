// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PiRpcInvocation, type PiRpcTransport } from "./pi-rpc.js";

type WireRecord = Record<string, unknown>;
const model = "vendor/fixed-model";
const state = {
  model: { provider: "openrouter", id: model },
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  messageCount: 0,
};

function fixture(
  options: {
    state?: WireRecord;
    levels?: string[];
    effort?: string | null;
    afterResponse?: (command: WireRecord) => Promise<void>;
    disposition?: string;
    reject?: string;
    beforePromptResponse?: (invocation: PiRpcInvocation) => void;
    onProgress?: () => void;
    maxOutputBytes?: number;
    maxRequests?: number;
  } = {}
) {
  const commands: WireRecord[] = [];
  let invocation: PiRpcInvocation;
  const transport: PiRpcTransport = {
    close: vi.fn(),
    write: vi.fn(async (line) => {
      const command = JSON.parse(line) as WireRecord;
      commands.push(command);
      if (command.type === "prompt") options.beforePromptResponse?.(invocation);
      const data =
        command.type === "get_state"
          ? (options.state ?? state)
          : command.type === "get_available_thinking_levels"
            ? { levels: options.levels ?? ["off", "high"] }
            : command.type === "prompt"
              ? { disposition: options.disposition ?? "started" }
              : undefined;
      wire(invocation, {
        type: "response",
        id: command.id,
        command: command.type,
        success: command.type !== options.reject,
        data,
        error: "SECRET provider diagnostic",
      });
      await options.afterResponse?.(command);
    }),
  };
  invocation = new PiRpcInvocation(
    transport,
    model,
    options.effort === null ? undefined : (options.effort ?? "high"),
    options.maxOutputBytes,
    options.maxRequests,
    options.onProgress
  );
  return { invocation, transport, commands };
}

function wire(invocation: PiRpcInvocation, record: WireRecord) {
  invocation.acceptStdout(Buffer.from(`${JSON.stringify(record)}\n`));
}

function assistant(invocation: PiRpcInvocation, overrides: WireRecord = {}) {
  wire(invocation, {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model,
      stopReason: "stop",
      content: [{ type: "text", text: "OK" }],
      ...overrides,
    },
  });
}

async function start(f: ReturnType<typeof fixture>) {
  const result = f.invocation.run("portable context and synthetic task");
  await vi.waitFor(() => expect(f.commands.some((c) => c.type === "prompt")).toBe(true));
  return { result };
}

describe("Pi RPC portable invocation spike", () => {
  it("waits beyond prompt acceptance and agent_end, then closes after settlement", async () => {
    const f = fixture();
    const { result } = await start(f);
    const finished = vi.fn();
    void result.then(finished);
    assistant(f.invocation);
    wire(f.invocation, { type: "agent_end", willRetry: false });
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    expect(f.transport.close).not.toHaveBeenCalled();
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({ success: true, output: "OK" });
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.commands.map((c) => c.type)).toEqual([
      "get_state",
      "get_available_thinking_levels",
      "set_auto_retry",
      "set_auto_compaction",
      "prompt",
    ]);
  });

  it("handles settlement before the correlated prompt response", async () => {
    const f = fixture({
      beforePromptResponse(invocation) {
        assistant(invocation);
        wire(invocation, { type: "agent_settled" });
      },
    });
    expect(await f.invocation.run("task")).toMatchObject({ success: true });
  });

  it("reports execution progress, not admission responses", async () => {
    const onProgress = vi.fn();
    const f = fixture({
      onProgress,
      beforePromptResponse(invocation) {
        wire(invocation, { type: "turn_start" });
      },
    });

    const { result } = await start(f);
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1));
    assistant(f.invocation);
    wire(f.invocation, { type: "agent_settled" });
    await result;
  });

  it.each([
    { ...state, model: { provider: "anthropic", id: model } },
    { ...state, model: { provider: "openrouter", id: "fuzzy-substitution" } },
    { ...state, thinkingLevel: "medium" },
    { ...state, pendingMessageCount: 1 },
    { ...state, messageCount: 1 },
    { ...state, sessionFile: "/ambient/session.jsonl" },
    { ...state, isStreaming: true },
    { ...state, isCompacting: true },
  ])("rejects mismatched or nonportable startup state %# before prompting", async (readback) => {
    const f = fixture({ state: readback });
    expect(await f.invocation.run("task")).toMatchObject({ success: false });
    expect(f.commands.some((c) => c.type === "prompt")).toBe(false);
  });

  it("rejects unsupported effort before sending a prompt", async () => {
    const f = fixture({ levels: ["off"] });
    expect(await f.invocation.run("task")).toMatchObject({ success: false });
    expect(f.commands.some((c) => c.type === "prompt")).toBe(false);
  });

  it.each(["handled", "queued"])("rejects %s prompt disposition", async (disposition) => {
    const f = fixture({ disposition });
    expect(await f.invocation.run("task")).toMatchObject({ success: false });
  });

  it.each([
    "get_state",
    "get_available_thinking_levels",
    "set_auto_retry",
    "set_auto_compaction",
    "prompt",
  ])("reports %s rejection without retaining diagnostics", async (reject) => {
    const f = fixture({ reject });
    const outcome = await f.invocation.run("task");
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it.each(["error", "aborted"])("treats settled %s as failure", async (stopReason) => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { stopReason });
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({ success: false });
  });

  it("fails on reported model substitution after startup", async () => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { model: "vendor/other" });
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({ success: false, reason: "Pi reported a different model" });
  });

  it("retains each completed request once, with missing usage and model unknown", async () => {
    const f = fixture();
    const { result } = await start(f);
    wire(f.invocation, { type: "message_update", usage: { totalTokens: 10 } });
    assistant(f.invocation, { usage: { totalTokens: 25, cost: { total: 0.01 } } });
    wire(f.invocation, { type: "turn_end", message: {} });
    assistant(f.invocation, { usage: undefined, model: undefined });
    wire(f.invocation, { type: "agent_settled" });
    const outcome = await result;
    expect(outcome.requests).toEqual([
      {
        requestedModel: model,
        reportedModel: model,
        usage: { totalTokens: 25, cost: { total: 0.01 } },
      },
      { requestedModel: model, reportedModel: undefined, usage: undefined },
    ]);
  });

  it("retains partial usage when the host reports stream interruption", async () => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { usage: { totalTokens: 12 } });
    f.invocation.fail("stream interruption");
    expect(await result).toMatchObject({
      success: false,
      requests: [{ usage: { totalTokens: 12 } }],
    });
  });

  it.each([
    '{"type":"message_end","message":null}\n',
    '{"type":"message_end","message":{"role":"assistant","usage":5}}\n',
    "SECRET-invalid-json\n",
  ])("settles malformed stdout without exposing the record %#", async (line) => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.acceptStdout(Buffer.from(line));
    const outcome = await result;
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it.each([
    "",
    '{"type":"agent_settled"}',
  ])("fails premature EOF with partial record %j", async (partial) => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation);
    f.invocation.acceptStdout(Buffer.from(partial));
    f.invocation.endStdout();
    expect(await result).toMatchObject({
      success: false,
      reason: partial ? "Truncated Pi RPC output" : "Pi subprocess ended before settlement",
    });
  });

  it("bounds output independently of wire record size", async () => {
    const f = fixture({ maxOutputBytes: 1 });
    const { result } = await start(f);
    assistant(f.invocation);
    expect(await result).toMatchObject({ success: false, reason: "Pi RPC output limit exceeded" });
  });

  it("bounds retained request count", async () => {
    const f = fixture({ maxRequests: 1 });
    const { result } = await start(f);
    assistant(f.invocation);
    assistant(f.invocation);
    expect(await result).toMatchObject({ success: false, requests: [expect.any(Object)] });
  });

  it("closes exactly once on cancellation without writing abort commands", async () => {
    const f = fixture();
    const { result } = await start(f);
    const cancelled = f.invocation.cancel();
    expect(f.invocation.cancel()).toBe(cancelled);
    await cancelled;
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({
      success: false,
      cancelled: true,
      reason: "Pi invocation cancelled",
    });
    expect(f.commands.some((c) => c.type === "clear_queue" || c.type === "abort")).toBe(false);
    expect(f.transport.close).toHaveBeenCalledOnce();
    await expect(f.invocation.run("again")).rejects.toThrow("already used");
  });

  it("fails on an uncorrelated response rather than leaving an in-flight command pending", async () => {
    const f = fixture();
    const { result } = await start(f);
    wire(f.invocation, { type: "response", command: "prompt", id: "unknown", success: true });
    expect(await result).toMatchObject({ success: false, reason: "Unexpected Pi RPC response" });
  });

  it("settles a failed stdin write without leaking its exception", async () => {
    const transport: PiRpcTransport = {
      write: async () => {
        throw new Error("SECRET stdin failure");
      },
      close: vi.fn(),
    };
    const invocation = new PiRpcInvocation(transport, model, "high");
    const result = await invocation.run("task");
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("cancels while startup readback is pending", async () => {
    const transport: PiRpcTransport = { write: vi.fn(async () => {}), close: vi.fn() };
    const invocation = new PiRpcInvocation(transport, model, "high");
    const result = invocation.run("task");
    await invocation.cancel();
    expect(await result).toMatchObject({ success: false, reason: "Pi invocation cancelled" });
    // A deferred startup write must never reach a transport already closed by cancel.
    expect(transport.write).not.toHaveBeenCalled();
  });

  it("cancels before a deferred throwing startup write", async () => {
    const transport: PiRpcTransport = {
      write: () => {
        throw new Error("closed");
      },
      close: vi.fn(),
    };
    const invocation = new PiRpcInvocation(transport, model, "high");
    const result = invocation.run("task");
    await invocation.cancel();
    expect(await result).toMatchObject({ success: false, reason: "Pi invocation cancelled" });
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("does not treat empty settlement as completed work", async () => {
    const f = fixture();
    const { result } = await start(f);
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({
      success: false,
      reason: "Pi returned no assistant message",
    });
  });
  it.each([
    "get_state",
    "prompt",
  ])("host failure settles despite an acknowledged stalled %s write", async (blocked) => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      afterResponse: async (command) => {
        if (command.type === blocked) await drained;
      },
    });
    const result = f.invocation.run("task");
    await vi.waitFor(() => expect(f.commands.some((c) => c.type === blocked)).toBe(true));
    f.invocation.fail("deadline");
    await expect(result).resolves.toMatchObject({ success: false, reason: "deadline" });
    expect(f.transport.close).toHaveBeenCalledOnce();
    release();
  });

  it("cancels immediately behind a stalled prompt write and ignores later stdout", async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      afterResponse: async (command) => {
        if (command.type === "prompt") await drained;
      },
    });
    const { result } = await start(f);
    assistant(f.invocation, { usage: { input: 7 } });
    f.invocation.acceptStdout(Buffer.from('{"type":'));
    await f.invocation.cancel();
    f.invocation.endStdout();
    f.invocation.acceptStdout(Buffer.from("invalid stdout\n"));
    f.invocation.fail("later deadline");
    expect(await result).toMatchObject({
      success: false,
      reason: "Pi invocation cancelled",
      requests: [{ usage: { input: 7 } }],
    });
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.commands.at(-1)?.type).toBe("prompt");
    release();
  });

  it.each([
    undefined,
    null,
    42,
    [],
  ])("reports missing or malformed startup model %j as admission failure", async (selected) => {
    const f = fixture({ state: { ...state, model: selected } });
    expect(await f.invocation.run("task")).toMatchObject({
      success: false,
      reason: "Pi resolved a different provider or model",
    });
    expect(f.commands.map((c) => c.type)).toEqual(["get_state"]);
  });

  it.each([
    "toolUse",
    "length",
    "pending",
    undefined,
  ])("rejects final stop reason %s", async (stopReason) => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { stopReason });
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({ success: false });
  });

  it.each([
    { type: "turn_start" },
    { type: "extension_error", error: "SECRET" },
    { type: "message_update", assistantMessageEvent: { type: "error", error: "SECRET" } },
    { type: "message_start", message: { role: "assistant" } },
    { type: "compaction_start" },
    { type: "compaction_end", aborted: true },
    { type: "auto_retry_end", success: false },
  ])("rejects failure or incomplete continuation %#", async (event) => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation);
    wire(f.invocation, event);
    wire(f.invocation, { type: "agent_settled" });
    const outcome = await result;
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it("returns only final assistant text while retaining all turn usage", async () => {
    const f = fixture({ effort: null, state: { ...state, thinkingLevel: "off" } });
    const { result } = await start(f);
    assistant(f.invocation, {
      stopReason: "toolUse",
      content: [{ type: "text", text: "Working" }],
    });
    assistant(f.invocation, { content: [{ type: "text", text: "🧠\u2028one\u2029two" }] });
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({
      success: true,
      output: "🧠\u2028one\u2029two",
      requests: [expect.any(Object), expect.any(Object)],
    });
    expect(f.commands.some((c) => c.type === "get_available_thinking_levels")).toBe(false);
  });

  it("frames split UTF-8, CRLF, and multiple records through the invocation", async () => {
    const f = fixture();
    const { result } = await start(f);
    const data = Buffer.from(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "🧠\u2028one\u2029two" }],
        },
      })}\r\n{"type":"agent_end"}\n`
    );
    for (const byte of data) f.invocation.acceptStdout(Buffer.from([byte]));
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({ success: true, output: "🧠\u2028one\u2029two" });
  });

  it("bounds records across chunks before parsing", async () => {
    const f = fixture();
    const { result } = await start(f);
    f.invocation.acceptStdout(Buffer.alloc(1024 * 1024, 32));
    f.invocation.acceptStdout(Buffer.from("x"));
    expect(await result).toMatchObject({
      success: false,
      reason: "Invalid or oversized Pi RPC output",
    });
  });
  it.each([
    null,
    42,
    { id: model },
    "other/model",
  ])("rejects invalid reported model %j and preserves identity failure", async (reportedModel) => {
    const f = fixture();
    const { result } = await start(f);
    assistant(f.invocation, { model: reportedModel, provider: "other", stopReason: "error" });
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({ success: false, reason: "Pi reported a different model" });
  });

  it("preserves the first execution failure across later identity and provider errors", async () => {
    const f = fixture();
    const { result } = await start(f);
    wire(f.invocation, { type: "extension_error" });
    assistant(f.invocation, { model: "other/model", stopReason: "error" });
    wire(f.invocation, { type: "agent_settled" });
    expect(await result).toMatchObject({
      success: false,
      reason: "Pi reported an execution error",
    });
  });
});
