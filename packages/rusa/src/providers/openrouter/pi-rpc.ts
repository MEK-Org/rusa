import { StringDecoder } from "node:string_decoder";
import {
  formatExecutingNotice,
  formatLiveError,
  formatMcpInvocationNotice,
  formatRunCommandNotice,
  formatToolError,
} from "../live-output.js";

/** Wire contract pinned to @earendil-works/pi-coding-agent 0.99.2 (#808). */
type RecordValue = Record<string, unknown>;
class PiAdmissionError extends Error {}

function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Pi RPC object");
  }
  return value as RecordValue;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolName(value: unknown): string {
  // Tool names are rendered to the live stream. Preserve only the identifier
  // alphabet Pi uses so a malformed protocol record cannot format the display.
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(value) ? value : "tool";
}

function toolNotice(name: string, args?: unknown): string {
  const mcp = /^mcp__([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)$/.exec(name);
  if (mcp) return formatMcpInvocationNotice(mcp[1] as string, mcp[2] as string);
  if (name === "bash" && args && typeof args === "object" && !Array.isArray(args)) {
    const command = text((args as RecordValue).command);
    if (command) return formatRunCommandNotice(command);
  }
  return formatExecutingNotice(name);
}

function readableToolName(name: string): string {
  const mcp = /^mcp__([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)$/.exec(name);
  return mcp ? `${mcp[1] as string}:${mcp[2] as string}` : name;
}

/** Keep provider diagnostics useful without forwarding unknown provider payloads. */
function safeProviderError(value: unknown): string {
  const message = typeof value === "string" ? value : "";
  const status = /\b([1-5]\d\d)\b/.exec(message)?.[1];
  switch (status) {
    case "400":
      return "Pi provider rejected the request (HTTP 400)";
    case "401":
    case "403":
      return "Pi provider authentication or authorization failed";
    case "402":
      return "Pi provider rejected the request for billing or credit";
    case "404":
      return "Pi provider could not find the requested route or model";
    case "429":
      return "Pi provider rate limited the request";
  }
  if (status?.startsWith("5")) return `Pi provider service failed (HTTP ${status})`;
  if (/\b(timeout|timed out)\b/i.test(message)) return "Pi provider request timed out";
  if (/\b(network|connect(?:ion)?|dns)\b/i.test(message)) return "Pi provider connection failed";
  return "Pi reported a provider error";
}

/** Strict LF framing, including split UTF-8 and literal Unicode separators.
 * Limits apply to bytes on the wire, before parsing or retaining a record.
 * Protocol errors intentionally omit the input, which may contain secrets.
 */
class PiRpcDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;
  private ended = false;

  constructor(
    private readonly receive: (record: RecordValue) => void,
    private readonly maxRecordBytes = 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new Error("Invalid Pi RPC record limit");
    }
  }

  push(chunk: Buffer): void {
    if (this.ended) throw new Error("Pi RPC decoder already ended");
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf < 0 ? chunk.length : lf;
      this.bytes += end - start;
      if (this.bytes > this.maxRecordBytes) throw new Error("Pi RPC record limit exceeded");
      this.pending += this.decoder.write(chunk.subarray(start, end));
      if (lf < 0) return;
      this.pending += this.decoder.end();
      const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
      this.pending = "";
      this.bytes = 0;
      let record: RecordValue;
      try {
        record = object(JSON.parse(line));
        if (typeof record.type !== "string") throw new Error();
      } catch {
        throw new Error("Invalid Pi RPC record");
      }
      this.receive(record);
      start = lf + 1;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.bytes !== 0) throw new Error("Truncated Pi RPC record");
  }
}

export interface PiRpcTransport {
  /** Write one complete record, honoring stdin backpressure. */
  write(record: string): Promise<void>;
  /** Close stdin and reap the supervised process group, even after a stalled write. */
  close(): void;
}

export interface PiUsageObservation {
  requestedModel: string;
  reportedModel?: string;
  /** Raw harness report, not OpenRouter billed cost. Missing stays unknown. */
  usage?: RecordValue;
}

export interface PiRpcOutcome {
  success: boolean;
  /** True only when the host terminated this invocation before Pi settled it. */
  cancelled?: true;
  reason?: string;
  output: string;
  requests: PiUsageObservation[];
}

/** One fresh portable invocation. Owns protocol state only; the execution host
 * must provide sandboxing, credentials, required-MCP readiness, deadline,
 * cancellation and process-group cleanup before this can become a provider.
 */
export class PiRpcInvocation {
  private pending = new Map<
    string,
    { command: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private sequence = 0;
  private phase: "new" | "preparing" | "running" | "done" = "new";
  private settled = false;
  private accepted = false;
  private failure?: string;
  private output = "";
  private requests: PiUsageObservation[] = [];
  private finishRun?: (outcome: PiRpcOutcome) => void;
  private readonly decoder: PiRpcDecoder;
  private writeTail: Promise<void> = Promise.resolve();
  private cancellation?: Promise<void>;
  private finalStopReason?: unknown;
  private progressBeforeAcceptance = false;
  private readonly announcedToolCalls = new Set<string>();

  constructor(
    private readonly transport: PiRpcTransport,
    private readonly model: string,
    private readonly effort?: string,
    private readonly maxOutputBytes = 1024 * 1024,
    private readonly maxRequests = 1000,
    private readonly onProgress?: () => void,
    private readonly onOutput?: (chunk: string) => void
  ) {
    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1
    ) {
      throw new Error("Invalid Pi RPC invocation limit");
    }
    this.decoder = new PiRpcDecoder((record) => this.receive(record));
  }

  acceptStdout(chunk: Buffer): void {
    if (this.phase === "done") return;
    try {
      this.decoder.push(chunk);
    } catch {
      this.fail("Invalid or oversized Pi RPC output");
    }
  }

  endStdout(): void {
    if (this.phase === "done") return;
    try {
      this.decoder.end();
      this.fail();
    } catch {
      this.fail("Truncated Pi RPC output");
    }
  }

  async run(prompt: string): Promise<PiRpcOutcome> {
    if (this.phase !== "new") throw new Error("Pi RPC invocation already used");
    this.phase = "preparing";
    const result = new Promise<PiRpcOutcome>((resolve) => {
      this.finishRun = resolve;
    });
    void this.prepare(prompt);
    return result;
  }

  private async prepare(prompt: string): Promise<void> {
    try {
      // Read back exact identity: CLI model selection is fuzzy and thinking is clamped.
      const state = object(await this.command("get_state"));
      const selected = state.model;
      if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
        throw new PiAdmissionError("Pi resolved a different provider or model");
      }
      const model = object(selected);
      if (model.provider !== "openrouter" || model.id !== this.model) {
        throw new PiAdmissionError("Pi resolved a different provider or model");
      }
      if (this.effort !== undefined && state.thinkingLevel !== this.effort)
        throw new PiAdmissionError("Pi changed requested effort");
      if (
        state.isStreaming !== false ||
        state.isCompacting !== false ||
        state.pendingMessageCount !== 0 ||
        state.messageCount !== 0 ||
        state.sessionFile != null
      ) {
        throw new PiAdmissionError("Pi session is not fresh and idle");
      }
      if (this.effort !== undefined) {
        // get_state exposes raw agent state; capability validation is separate.
        const levels = object(await this.command("get_available_thinking_levels"));
        if (!Array.isArray(levels.levels) || !levels.levels.includes(this.effort)) {
          throw new PiAdmissionError("Pi does not support requested effort");
        }
      }
      await this.command("set_auto_retry", { enabled: false });
      await this.command("set_auto_compaction", { enabled: false });
      if (this.phase !== "preparing") return;
      // Listen before sending: a fast fixture/child can settle before prompt's response.
      this.phase = "running";
      const response = object(await this.command("prompt", { message: prompt }));
      if (response.disposition !== "started") {
        throw new PiAdmissionError("Pi did not start submitted prompt");
      }
      this.accepted = true;
      if (this.progressBeforeAcceptance) {
        this.progressBeforeAcceptance = false;
        this.onProgress?.();
      }
      this.maybeFinish();
    } catch (error) {
      // Command failure text is untrusted and may contain credentials or prompt data.
      this.finish(
        false,
        error instanceof PiAdmissionError ? error.message : "Pi RPC preparation or prompt rejected"
      );
    }
  }

  private write(record: string): Promise<void> {
    const sent = this.writeTail.then(() => {
      if (this.phase === "done") throw new Error("Pi RPC invocation ended");
      return this.transport.write(record);
    });
    this.writeTail = sent.catch(() => {});
    return sent;
  }

  private async command(type: string, fields: RecordValue = {}): Promise<unknown> {
    if (this.phase === "done") throw new Error("Pi RPC invocation ended");
    const id = `rusa-${++this.sequence}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { command: type, resolve, reject });
    });
    // Attach a rejection handler before a synchronous fake/transport can fail.
    const sent = this.write(`${JSON.stringify({ ...fields, type, id })}\n`);
    try {
      const [, value] = await Promise.all([sent, response]);
      return value;
    } finally {
      this.pending.delete(id);
    }
  }

  private receive(record: RecordValue): void {
    try {
      this.handleRecord(record);
    } catch {
      this.finish(false, "Invalid Pi RPC event");
    }
  }

  private handleRecord(record: RecordValue): void {
    if (this.phase === "done") return;
    if (record.type === "response") {
      const request = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
      if (!request || record.command !== request.command) {
        this.finish(false, "Unexpected Pi RPC response");
        return;
      }
      this.pending.delete(record.id as string);
      if (record.success === true) request.resolve(record.data);
      else request.reject(new Error("Pi RPC command rejected"));
      return;
    }
    if (this.phase !== "running") {
      this.finish(false, "Pi emitted work before prompt admission");
      return;
    }
    this.reportExecutionProgress();
    this.renderLiveEvent(record);
    if (
      record.type === "extension_error" ||
      (record.type === "message_update" &&
        record.assistantMessageEvent !== undefined &&
        object(record.assistantMessageEvent).type === "error")
    ) {
      this.failure ??= "Pi reported an execution error";
    }
    if (
      record.type === "compaction_start" ||
      record.type === "compaction_end" ||
      record.type === "auto_retry_start" ||
      record.type === "auto_retry_end"
    ) {
      this.finish(false, "Pi emitted disabled automatic work");
      return;
    }
    if (
      record.type === "turn_start" ||
      (record.type === "message_start" && object(record.message).role === "assistant")
    ) {
      this.finalStopReason = undefined;
    }
    if (record.type === "message_end") {
      const message = object(record.message);
      if (message.role !== "assistant") return;
      if (this.requests.length >= this.maxRequests) {
        this.finish(false, "Pi RPC request limit exceeded");
        return;
      }
      const reportedModel = typeof message.model === "string" ? message.model : undefined;
      if (message.model !== undefined && message.model !== this.model) {
        this.failure ??= "Pi reported a different model";
      }
      if (message.provider !== undefined && message.provider !== "openrouter") {
        this.failure ??= "Pi reported a different provider";
      }
      this.requests.push({
        requestedModel: this.model,
        reportedModel,
        usage: message.usage === undefined ? undefined : object(message.usage),
      });
      this.finalStopReason = message.stopReason;
      this.output = "";
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        this.failure ??= "Pi reported a provider error or abort";
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const content = object(block);
          if (content.type === "text" && typeof content.text === "string") {
            if (
              Buffer.byteLength(this.output) + Buffer.byteLength(content.text) >
              this.maxOutputBytes
            ) {
              this.finish(false, "Pi RPC output limit exceeded");
              return;
            }
            this.output += content.text;
          }
        }
      }
    }
    if (record.type === "agent_settled") {
      this.settled = true;
      this.maybeFinish();
    }
    // agent_end is deliberately not settlement. Progress and tool events are
    // consumed without retaining arbitrary tool output or double-counting usage.
  }

  /**
   * Pi's stdout is a protocol stream, not a terminal transcript. Render only
   * readable assistant deltas, tool starts and bounded semantic failures; each
   * record has already separately ticked liveness through reportExecutionProgress.
   */
  private renderLiveEvent(record: RecordValue): void {
    if (record.type === "message_update") {
      const event = record.assistantMessageEvent;
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const update = event as RecordValue;
      switch (update.type) {
        case "text_delta":
        case "thinking_delta": {
          const delta = text(update.delta);
          if (delta) this.onOutput?.(delta);
          return;
        }
        case "toolcall_start": {
          const id = text(update.id);
          if (id) this.announcedToolCalls.add(id);
          this.onOutput?.(toolNotice(toolName(update.toolName)));
          return;
        }
        case "error":
          this.onOutput?.(formatLiveError(safeProviderError(update.error ?? update.reason)));
          return;
        default:
          return;
      }
    }
    if (record.type === "tool_execution_start") {
      const id = text(record.toolCallId);
      if (id && this.announcedToolCalls.delete(id)) return;
      this.onOutput?.(toolNotice(toolName(record.toolName), record.args));
      return;
    }
    if (record.type === "tool_execution_end") {
      const id = text(record.toolCallId);
      if (id) this.announcedToolCalls.delete(id);
      if (record.isError === true) {
        this.onOutput?.(formatToolError(`${readableToolName(toolName(record.toolName))} failed`));
      }
      return;
    }
    if (record.type === "extension_error") {
      this.onOutput?.(formatLiveError("Pi extension failed"));
    }
  }

  private maybeFinish(): void {
    if (this.phase !== "running" || !this.accepted || !this.settled) return;
    this.finish(
      !this.failure && this.finalStopReason === "stop",
      this.failure ??
        (this.requests.length === 0
          ? "Pi returned no assistant message"
          : this.finalStopReason !== "stop"
            ? "Pi returned no final completed answer"
            : undefined)
    );
  }

  /** Emits only execution activity after Pi has accepted the submitted prompt. */
  private reportExecutionProgress(): void {
    if (this.accepted) this.onProgress?.();
    else this.progressBeforeAcceptance = true;
  }

  /** Called by the host for malformed output, startup/exit failure or deadline. */
  fail(reason = "Pi subprocess ended before settlement"): void {
    this.finish(false, reason);
  }

  /** End this one-shot invocation immediately, even behind a stalled write.
   * The host owns process-group termination; no cooperative abort is assumed.
   */
  cancel(): Promise<void> {
    if (!this.cancellation) {
      this.cancellation = Promise.resolve();
      this.finish(false, "Pi invocation cancelled", true);
    }
    return this.cancellation;
  }

  private finish(success: boolean, reason?: string, cancelled = false): void {
    if (this.phase === "done") return;
    this.phase = "done";
    for (const request of this.pending.values())
      request.reject(new Error("Pi RPC invocation ended"));
    this.pending.clear();
    try {
      this.transport.close();
    } catch {
      success = false;
      reason = "Pi transport cleanup failed";
    }
    this.finishRun?.({
      success,
      ...(cancelled ? { cancelled: true } : {}),
      reason,
      output: this.output,
      requests: this.requests,
    });
  }
}
