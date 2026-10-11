import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createSpike } from "./server.mjs";

class Recording extends EventEmitter {
  samples = 0;
  cancelled = false;
  constructor() {
    super();
    setImmediate(() =>
      this.emit("update", { type: "ready", model: "synthetic-test", maxSeconds: 240 })
    );
  }
  audio(bytes) {
    this.samples += bytes.length / 2;
  }
  stop(samples) {
    assert.equal(samples, this.samples);
    this.emit("update", { type: "complete", text: "blue blue", samples });
  }
  cancel() {
    this.cancelled = true;
  }
}
async function fixture(options = {}) {
  const recordings = [];
  const spike = createSpike({
    apiKey: "synthetic-test-key",
    token: "synthetic-launch-code",
    recordingFactory: () => {
      const r = new Recording();
      recordings.push(r);
      return r;
    },
    ...options,
  });
  await new Promise((resolve) => spike.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${spike.server.address().port}`;
  const login = async (body = spike.token, origin = base) =>
    fetch(`${base}/session`, { method: "POST", body, headers: { Origin: origin } });
  const connect = (cookie, origin = base) =>
    new WebSocket(`${base.replace("http:", "ws:")}/record`, {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
  const rejected = (ws) =>
    new Promise((resolve, reject) => {
      ws.on("open", () => {
        ws.close();
        reject(new Error("Unexpected accepted socket"));
      });
      ws.on("unexpected-response", (_req, response) => {
        response.resume();
        resolve(response.statusCode);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
  return { ...spike, recordings, base, login, connect, rejected };
}
test("auth and origin are checked before any provider construction, with bounded Unicode-safe login", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.login("", "http://other.invalid")).status, 403);
    assert.equal((await f.login("é".repeat(f.token.length))).status, 401);
    assert.equal((await f.login("x".repeat(129))).status, 413);
    assert.equal(await f.rejected(f.connect()), 403);
    const auth = await f.login();
    assert.equal(auth.status, 204);
    const cookie = auth.headers.get("set-cookie").split(";")[0];
    assert.match(auth.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.equal(await f.rejected(f.connect(cookie, "http://other.invalid")), 403);
    assert.equal(f.recordings.length, 0);
    const socket = f.connect(cookie);
    const [ready] = await once(socket, "message");
    assert.equal(JSON.parse(ready).type, "ready");
    assert.equal(await f.rejected(f.connect(cookie)), 403, "Concurrent recording must be denied");
    socket.send(Buffer.alloc(3200));
    socket.send(JSON.stringify({ type: "stop", samples: 1600 }));
    const [complete] = await once(socket, "message");
    assert.deepEqual(JSON.parse(complete), { type: "complete", text: "blue blue", samples: 1600 });
    await once(socket, "close");
    assert.equal(f.recordings.length, 1);
  } finally {
    await f.close();
  }
});
test("Cancel and session expiry release the recording without completion", async () => {
  const f = await fixture({ sessionMs: 100 });
  try {
    const auth = await f.login();
    const cookie = auth.headers.get("set-cookie").split(";")[0];
    const socket = f.connect(cookie);
    await once(socket, "message");
    socket.send(JSON.stringify({ type: "cancel" }));
    const [cancelled] = await once(socket, "message");
    assert.equal(JSON.parse(cancelled).type, "cancelled");
    await once(socket, "close");
    assert.equal(f.recordings[0].cancelled, true);
    const auth2 = await f.login();
    const second = f.connect(auth2.headers.get("set-cookie").split(";")[0]);
    await once(second, "message");
    const [code] = await once(second, "close");
    assert.equal(code, 1008);
    assert.equal(f.recordings[1].cancelled, true);
  } finally {
    await f.close();
  }
});
