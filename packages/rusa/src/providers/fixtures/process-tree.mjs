// Synthetic process-group member. No network, credentials or model requests.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

setInterval(() => {}, 1000);
if (process.argv[2] === "grandchild") {
  process.send({ pid: process.pid });
} else {
  const descendant = fork(fileURLToPath(import.meta.url), ["grandchild"], {
    env: {},
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  descendant.once("message", ({ pid }) => {
    process.stdout.write(`${JSON.stringify({ parent: process.pid, descendant: pid })}\n`);
  });
}
