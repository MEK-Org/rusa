import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { assertOwnedListeners } from "./ownership.mjs";

test("refuses a responding occupied port before any write, accepts the child listener", async () => {
  let writes = 0;
  const existing = createServer((req, res) => {
    if (req.method === "POST") writes++;
    res.end("ok");
  });
  existing.listen(0, "127.0.0.1");
  await once(existing, "listening");
  const port = existing.address().port;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createServer} from 'node:http';
    const server = createServer((req,res) => res.end('child'));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    const [data] = await once(child.stdout, "data");
    const childPort = Number(data.toString().trim());
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
    await assert.rejects(async () => {
      await assertOwnedListeners(child.pid, [port]);
      await fetch(`http://127.0.0.1:${port}`, { method: "POST" });
    }, /not exclusively owned/);
    assert.equal(writes, 0);
    await assertOwnedListeners(child.pid, [childPort]);
  } finally {
    child.kill();
    await once(child, "close");
    await new Promise((resolve) => existing.close(resolve));
  }
});
