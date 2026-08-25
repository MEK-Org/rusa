import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { dashboardBaseUrl, resolveActor, runActorChat } from "./chat.js";

function actor(
  id: string,
  handle: string,
  overrides: Partial<{
    status: string;
    title: string;
    runState: "running" | "queued" | "idle";
    chatDisabled: boolean;
  }> = {}
) {
  return {
    id,
    handle,
    status: overrides.status ?? "active",
    title: overrides.title ?? "",
    runState: overrides.runState ?? ("idle" as const),
    chatDisabled: overrides.chatDisabled ?? false,
  };
}

describe("actor chat target resolution", () => {
  it("resolves an exact id before handles", () => {
    const target = resolveActor(
      [actor("thread-1", "cloudy-porpoise"), actor("cloudy-porpoise", "other-handle")],
      "cloudy-porpoise"
    );
    expect(target.id).toBe("cloudy-porpoise");
  });

  it("resolves a generated handle", () => {
    const target = resolveActor([actor("thread-1", "cloudy-porpoise")], "cloudy-porpoise");
    expect(target.id).toBe("thread-1");
  });

  it("rejects missing, ambiguous, and retired actors", () => {
    expect(() => resolveActor([], "missing")).toThrow("actor not found: missing");
    expect(() => resolveActor([actor("one", "same"), actor("two", "same")], "same")).toThrow(
      "actor handle is ambiguous"
    );
    expect(() =>
      resolveActor([actor("retired", "old", { status: "retired", chatDisabled: true })], "old")
    ).toThrow("actor is retired: old");
  });
});

describe("dashboard URL override", () => {
  it("normalizes a caller-supplied HTTP(S) URL", () => {
    expect(dashboardBaseUrl({ url: "https://mesh.example.test///" })).toBe(
      "https://mesh.example.test"
    );
  });

  it("rejects non-HTTP protocols", () => {
    expect(() => dashboardBaseUrl({ url: "file:///tmp/socket" })).toThrow(
      "--url must use http or https"
    );
  });
});

describe("turn-based actor chat", () => {
  it("sends with one session id and renders the actor's direct reply", async () => {
    let sent = false;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/mesh/threads")) {
        return Response.json({
          threads: [
            actor("thread-1", "cloudy-porpoise", {
              title: "Own interactive CLI design",
              runState: sent ? "running" : "idle",
            }),
          ],
        });
      }
      if (url.includes("/api/mesh/events?")) {
        return Response.json({
          events: sent
            ? [
                {
                  id: "reply-1",
                  kind: "message_sent",
                  actorId: "thread-1",
                  detail: "session-1",
                  body: "I handled it.",
                  payload: JSON.stringify({ messageId: "message-1", to: "human:operator" }),
                },
              ]
            : [],
        });
      }
      if (url.endsWith("/api/mesh/actors/thread-1/chat")) {
        sent = true;
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const input = new PassThrough();

    const chat = runActorChat(
      {
        actor: "cloudy-porpoise",
        url: "http://mesh.test",
        history: 0,
      },
      {
        fetch: fetchMock as typeof fetch,
        input,
        output: sink,
        sessionId: () => "session-1",
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
      }
    );
    input.write("hello\n");
    await vi.waitFor(() => {
      expect(output).toContain("cloudy-porpoise > I handled it.\n\n");
      expect(output).toContain("[cloudy-porpoise is running]\n\n");
    });
    input.end("/exit\n");
    await chat;

    const post = requests.find((request) => request.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      body: "hello",
      sessionId: "session-1",
    });
    expect(output).toContain("Chatting with cloudy-porpoise (thread-1)");
    expect(output).toContain("cloudy-porpoise > I handled it.\n\n");
    expect(output).toContain("[cloudy-porpoise is running]\n\n");
    expect(output).toContain("Chat closed.");
  });

  it("sends repeated messages without waiting for an actor reply", async () => {
    const sentBodies: string[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/mesh/threads")) {
        return Response.json({ threads: [actor("thread-1", "cloudy-porpoise")] });
      }
      if (url.includes("/api/mesh/events?")) return Response.json({ events: [] });
      if (url.endsWith("/api/mesh/actors/thread-1/chat")) {
        sentBodies.push(JSON.parse(String(init?.body)).body);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };

    await runActorChat(
      { actor: "cloudy-porpoise", url: "http://mesh.test", history: 0 },
      {
        fetch: fetchMock as typeof fetch,
        input: Readable.from(["first\n", "second\n", "/exit\n"]),
        output: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
        sessionId: () => "session-1",
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
      }
    );

    expect(sentBodies).toEqual(["first", "second"]);
  });

  it("colors chat labels and status hints when colors are enabled", async () => {
    let sent = false;
    const fetchMock = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/mesh/threads")) {
        return Response.json({
          threads: [actor("thread-1", "cloudy-porpoise", { runState: sent ? "running" : "idle" })],
        });
      }
      if (url.includes("/api/mesh/events?")) {
        return Response.json({
          events: sent
            ? [
                {
                  id: "reply-1",
                  kind: "message_sent",
                  actorId: "thread-1",
                  detail: "session-1",
                  body: "Reply",
                  payload: JSON.stringify({ to: "human:operator" }),
                },
              ]
            : [],
        });
      }
      sent = true;
      return Response.json({ ok: true });
    };
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const input = new PassThrough();

    const chat = runActorChat(
      { actor: "cloudy-porpoise", url: "http://mesh.test", history: 0 },
      {
        fetch: fetchMock as typeof fetch,
        input,
        output: sink,
        sessionId: () => "session-1",
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
        colors: true,
      }
    );
    input.write("hello\n");
    await vi.waitFor(() => {
      expect(output).toContain("\u001B[36m\u001B[1mcloudy-porpoise");
      expect(output).toContain("\u001B[33m[cloudy-porpoise is running]\u001B[39m\n\n");
    });
    input.end("/exit\n");
    await chat;

    expect(output).toContain("\u001B[32m\u001B[1myou");
    expect(output).toContain("\u001B[33m[cloudy-porpoise is running]\u001B[39m\n\n");
  });
});
