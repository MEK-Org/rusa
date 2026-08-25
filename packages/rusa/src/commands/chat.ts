import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import chalk, { Chalk } from "chalk";
import { loadConfig, resolveHome } from "../config/index.js";

const HUMAN_OPERATOR = "human:operator";
const DEFAULT_POLL_MS = 500;

interface ThreadDto {
  id: string;
  handle: string;
  status: string;
  title: string;
  runState: "running" | "queued" | "idle";
  chatDisabled: boolean;
}

interface ThreadsResponse {
  threads: ThreadDto[];
}

interface MeshEvent {
  id: string;
  kind: string;
  actorId: string | null;
  detail: string | null;
  body: string | null;
  payload: string | null;
}

interface EventsResponse {
  events: MeshEvent[];
}

export interface ChatCommandOptions {
  actor: string;
  url?: string;
  home?: string;
  history?: number;
}

interface ChatCommandDeps {
  fetch: typeof fetch;
  input: Readable;
  output: Writable;
  sleep: (ms: number) => Promise<void>;
  sessionId: () => string;
  colors: boolean;
}

const defaultDeps: ChatCommandDeps = {
  fetch,
  input: process.stdin,
  output: process.stdout,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sessionId: randomUUID,
  colors: chalk.level > 0,
};

interface ChatTheme {
  actorLabel: string;
  youLabel: string;
  status: (text: string) => string;
}

function chatTheme(actorHandle: string, colors: boolean): ChatTheme {
  const paint = new Chalk({ level: colors ? 1 : 0 });
  return {
    actorLabel: paint.cyan.bold(actorHandle),
    youLabel: paint.green.bold("you"),
    status: paint.yellow,
  };
}

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function dashboardBaseUrl(options: { url?: string; home?: string }): string {
  if (options.url) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("--url must use http or https");
    }
    return stripTrailingSlash(parsed.toString());
  }

  const config = loadConfig(options.home ?? resolveHome());
  const port = config.dashboard?.port ?? 8080;
  const configuredHost = config.dashboard?.bindHost;
  const host =
    !configuredHost || configuredHost === "0.0.0.0" || configuredHost === "::"
      ? "127.0.0.1"
      : configuredHost;
  const renderedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${renderedHost}:${port}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ChatApiError(
      `Rusa API returned ${response.status} with a non-JSON response`,
      response.status
    );
  }
  if (!response.ok) {
    const apiMessage =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new ChatApiError(apiMessage, response.status);
  }
  return parsed as T;
}

export function resolveActor(threads: ThreadDto[], selector: string): ThreadDto {
  const exactId = threads.find((thread) => thread.id === selector);
  const matches = exactId ? [exactId] : threads.filter((thread) => thread.handle === selector);
  if (matches.length === 0) throw new Error(`actor not found: ${selector}`);
  if (matches.length > 1) {
    throw new Error(
      `actor handle is ambiguous: ${selector} (${matches.map((thread) => thread.id).join(", ")})`
    );
  }
  const actor = matches[0];
  if (actor.status === "retired" || actor.chatDisabled) {
    throw new Error(`actor is retired: ${actor.handle}`);
  }
  return actor;
}

function counterparty(event: MeshEvent): string | null {
  if (event.payload) {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      const value = event.kind === "message_sent" ? payload.to : payload.from;
      if (typeof value === "string") return value;
    } catch {
      // Fall through to the legacy peer-less shape.
    }
  }
  return null;
}

function isActorReply(event: MeshEvent, actorId: string, sessionId: string): boolean {
  return (
    event.kind === "message_sent" &&
    event.actorId === actorId &&
    event.detail === sessionId &&
    counterparty(event) === HUMAN_OPERATOR
  );
}

class ActorChatClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch
  ) {}

  async threads(): Promise<ThreadDto[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/mesh/threads`, {
      headers: { Accept: "application/json" },
    });
    return (await responseJson<ThreadsResponse>(response)).threads;
  }

  async conversation(actorId: string, limit: number): Promise<MeshEvent[]> {
    const query = new URLSearchParams({
      actors: `${actorId},${HUMAN_OPERATOR}`,
      kinds: "message_sent",
      conversation: "true",
      limit: String(limit),
    });
    const response = await this.fetchImpl(`${this.baseUrl}/api/mesh/events?${query}`, {
      headers: { Accept: "application/json" },
    });
    return (await responseJson<EventsResponse>(response)).events;
  }

  async send(actorId: string, body: string, sessionId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/mesh/actors/${encodeURIComponent(actorId)}/chat`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ body, sessionId }),
      }
    );
    await responseJson(response);
  }
}

function write(output: Writable, text: string): void {
  output.write(text);
}

function renderHistory(events: MeshEvent[], output: Writable, theme: ChatTheme): void {
  for (const event of [...events].reverse()) {
    if (!event.body) continue;
    const label = event.actorId === HUMAN_OPERATOR ? theme.youLabel : theme.actorLabel;
    write(output, `${label} > ${event.body}\n\n`);
  }
}

async function pollForUpdates(
  client: ActorChatClient,
  actor: ThreadDto,
  sessionId: string,
  seenEventIds: Set<string>,
  deps: Pick<ChatCommandDeps, "sleep">,
  theme: ChatTheme,
  render: (text: string) => void,
  isCancelled: () => boolean
): Promise<void> {
  let lastState = actor.runState;
  let lastError: string | null = null;
  if (lastState !== "idle") render(`${theme.status(`[${actor.handle} is ${lastState}]`)}\n\n`);

  while (!isCancelled()) {
    try {
      const events = await client.conversation(actor.id, 100);
      if (isCancelled()) return;
      for (const event of [...events].reverse()) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);
        if (event.body && isActorReply(event, actor.id, sessionId)) {
          render(`${theme.actorLabel} > ${event.body}\n\n`);
        }
      }

      const current = resolveActor(await client.threads(), actor.id);
      if (isCancelled()) return;
      if (current.runState !== lastState) {
        lastState = current.runState;
        render(`${theme.status(`[${actor.handle} is ${lastState}]`)}\n\n`);
      }
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) render(`${theme.status(`[chat polling error: ${message}]`)}\n\n`);
      lastError = message;
    }
    if (!isCancelled()) await deps.sleep(DEFAULT_POLL_MS);
  }
}

export async function runActorChat(
  options: ChatCommandOptions,
  overrides: Partial<ChatCommandDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const baseUrl = dashboardBaseUrl(options);
  const client = new ActorChatClient(baseUrl, deps.fetch);
  const actor = resolveActor(await client.threads(), options.actor);
  const theme = chatTheme(actor.handle, deps.colors);
  const sessionId = deps.sessionId();
  const historyLimit = options.history ?? 20;
  if (!Number.isInteger(historyLimit) || historyLimit < 0 || historyLimit > 200) {
    throw new Error("--history must be an integer between 0 and 200");
  }

  write(deps.output, `Chatting with ${actor.handle} (${actor.id}) via ${baseUrl}\n`);
  if (actor.title) write(deps.output, `${actor.title}\n`);
  write(deps.output, "Turn-based v1: messages to a busy actor queue for its next run.\n");
  write(deps.output, "Type /exit to leave or /help for commands.\n\n");

  const initialEvents = historyLimit > 0 ? await client.conversation(actor.id, historyLimit) : [];
  renderHistory(initialEvents, deps.output, theme);
  const seenEventIds = new Set(initialEvents.map((event) => event.id));

  const terminal = Boolean((deps.input as NodeJS.ReadStream).isTTY);
  const rl = createInterface({
    input: deps.input,
    output: deps.output,
    terminal,
  });
  let readlineClosed = false;
  let interrupted = false;
  let chatClosed = false;
  rl.once("close", () => {
    readlineClosed = true;
  });
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });
  rl.setPrompt(`${theme.youLabel} > `);
  if (!readlineClosed) rl.prompt();

  const renderUpdate = (text: string) => {
    if (terminal && !readlineClosed) write(deps.output, "\r\x1b[2K");
    write(deps.output, text);
    if (terminal && !readlineClosed) rl.prompt(true);
  };
  const polling = pollForUpdates(
    client,
    actor,
    sessionId,
    seenEventIds,
    deps,
    theme,
    renderUpdate,
    () => chatClosed || interrupted
  );

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      write(deps.output, "/exit, /quit  close this chat\n/help         show this help\n");
      if (!readlineClosed) rl.prompt();
      continue;
    }
    if (!line) {
      if (!readlineClosed) rl.prompt();
      continue;
    }

    try {
      await client.send(actor.id, line, sessionId);
      write(deps.output, "\n");
    } catch (err) {
      write(
        deps.output,
        `${theme.status(`[chat error: ${err instanceof Error ? err.message : String(err)}]`)}\n\n`
      );
    }
    if (!readlineClosed) rl.prompt();
  }

  chatClosed = true;
  rl.close();
  await polling;
  write(deps.output, "\nChat closed.\n");
}
