// @vitest-environment node

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSubprocess, type SubprocessDuplex } from "../subprocess-execution.js";
import { PiRpcInvocation } from "./pi-rpc.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url));

/** Synthetic peer using the shared supervisor. Sandbox/Pi compatibility remain unproven. */
async function runFixture(mode: "success" | "eof", prompt = "portable context") {
  let invocation: PiRpcInvocation | undefined;
  let outcome: ReturnType<PiRpcInvocation["run"]> | undefined;
  let signal: NodeJS.Signals | undefined;
  let transport: SubprocessDuplex | undefined;
  const failed = (reason: string) => {
    invocation?.fail(reason);
    return { success: false, output: reason, exitCode: 1 };
  };
  try {
    await runSubprocess({
      command: process.execPath,
      args: [fixturePath, mode],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 3000,
      onDuplex: (value) => {
        transport = value;
        invocation = new PiRpcInvocation(value, "vendor/fixed-model");
        outcome = invocation.run(prompt);
      },
      handleStdoutData: (chunk) => invocation?.acceptStdout(chunk),
      onStdoutEnd: (_chunks, cause) => {
        if (cause === "eof") invocation?.endStdout();
      },
      handleStderrData: () => {},
      buildKilledResult: () => failed("Fixture deadline exceeded"),
      buildSignalResult: (_attribution, receivedSignal) => {
        signal = receivedSignal;
        return failed("Fixture subprocess signalled");
      },
      buildExitResult: () => failed("Fixture subprocess exited"),
      buildSpawnErrorResult: () => failed("Fixture subprocess failed"),
    });
    if (!outcome) throw new Error("Fixture did not start");
    return { outcome: await outcome, signal };
  } finally {
    await transport?.close();
  }
}

describe("Pi RPC through synthetic subprocess pipes", () => {
  it("settles and reaps a peer that stays alive after agent_settled", async () => {
    const { outcome, signal } = await runFixture("success", "fresh intent 🧠\nnext line");
    expect(outcome).toMatchObject({ success: true, output: "fresh intent 🧠\nnext line" });
    expect(outcome.requests).toEqual([
      {
        requestedModel: "vendor/fixed-model",
        reportedModel: "vendor/fixed-model",
        usage: { input: 3, output: 2 },
      },
    ]);
    expect(signal).toBe("SIGKILL");
  }, 10000);

  it("rejects EOF before settlement and reaps the peer", async () => {
    const { outcome, signal } = await runFixture("eof");
    expect(outcome).toMatchObject({
      success: false,
      reason: "Pi subprocess ended before settlement",
    });
    expect(signal).toBe("SIGKILL");
  }, 10000);
});
