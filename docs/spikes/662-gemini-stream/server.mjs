import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { GeminiRecording } from "./gemini.mjs";

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/client.mjs", ["client.mjs", "text/javascript"]],
  ["/capture.mjs", ["capture.mjs", "text/javascript"]],
  ["/pcm.mjs", ["pcm.mjs", "text/javascript"]],
]);
const newToken = () => randomBytes(24).toString("hex");
const same = (a, b) => {
  const bytes = Buffer.from(a);
  const expected = Buffer.from(b);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};

export function createSpike({
  apiKey,
  token = newToken(),
  recordingFactory = () => new GeminiRecording({ apiKey }),
  sessionMs = 60 * 60 * 1000,
} = {}) {
  const sessions = new Map();
  let active = null;
  const allowedHost = (host) =>
    [`localhost:${server.address()?.port}`, `127.0.0.1:${server.address()?.port}`].includes(host);
  const sameOrigin = (req) =>
    allowedHost(req.headers.host) && req.headers.origin === `http://${req.headers.host}`;
  const getSession = (req) => {
    const id = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("spike="))
      ?.slice(6);
    const expires = sessions.get(id);
    if (!expires || expires <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return id;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'"
    );
    if (!allowedHost(req.headers.host)) {
      res.writeHead(403);
      return res.end("Invalid host");
    }
    if (req.url === "/session" && req.method === "POST") {
      if (!sameOrigin(req)) {
        res.writeHead(403);
        return res.end("Invalid origin");
      }
      let body = "";
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 128) {
            res.writeHead(413);
            return res.end();
          }
        }
      } catch {
        res.writeHead(400);
        return res.end("Incomplete authentication request");
      }
      if (!same(body, token)) {
        res.writeHead(401);
        return res.end("Invalid access code");
      }
      // This isolated harness has one operator. Re-authentication revokes the prior session.
      sessions.clear();
      active?.close(1008, "Session replaced");
      const id = newToken();
      sessions.set(id, Date.now() + sessionMs);
      res.setHeader("Set-Cookie", `spike=${id}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(204);
      return res.end();
    }
    const file = files.get(req.url);
    if (req.method !== "GET" || !file) {
      res.writeHead(404);
      return res.end("Not found");
    }
    try {
      res.setHeader("Content-Type", file[1]);
      res.end(await readFile(new URL(file[0], import.meta.url)));
    } catch {
      res.writeHead(500);
      res.end("File unavailable");
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4000, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const session = getSession(req);
    if (req.url !== "/record" || !sameOrigin(req) || !session || active || !apiKey) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      active = ws;
      const recording = recordingFactory();
      const expiry = setTimeout(() => {
        recording.cancel();
        ws.close(1008, "Access session expired");
      }, sessions.get(session) - Date.now());
      const send = (message) => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 128 * 1024) {
          recording.cancel();
          ws.close(1008, "Browser queue overflow");
          return;
        }
        ws.send(JSON.stringify(message));
      };
      recording.on("update", (message) => {
        send(message);
        if (["complete", "error"].includes(message.type)) ws.close();
      });
      ws.on("message", (bytes, binary) => {
        if (!getSession(req)) {
          recording.cancel();
          ws.close(1008, "Access session expired");
          return;
        }
        if (binary) return recording.audio(bytes);
        try {
          const message = JSON.parse(bytes.toString());
          if (message.type === "stop") recording.stop(message.samples);
          else if (message.type === "cancel") {
            recording.cancel();
            send({ type: "cancelled" });
            ws.close();
          } else {
            recording.cancel();
            send({ type: "error", message: "Invalid recording command" });
            ws.close();
          }
        } catch {
          recording.cancel();
          send({ type: "error", message: "Invalid recording command" });
          ws.close();
        }
      });
      ws.on("error", () => recording.cancel());
      ws.on("close", () => {
        clearTimeout(expiry);
        recording.cancel();
        if (active === ws) active = null;
      });
    });
  });
  return {
    server,
    token,
    close: async () => {
      active?.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required in the server environment");
    process.exitCode = 1;
  } else {
    const spike = createSpike({ apiKey: process.env.GEMINI_API_KEY });
    spike.server.listen(8771, "127.0.0.1", () => {
      console.log(`Open http://localhost:8771/#${spike.token}`);
      console.log(
        "Loopback-only standalone prototype; four-minute limit; no actor delivery. Keep this launch URL private."
      );
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await spike.close();
      });
  }
}
