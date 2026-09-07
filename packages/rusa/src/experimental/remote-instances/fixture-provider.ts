import { setTimeout as delay } from "node:timers/promises";
import type { ProviderFactory } from "./protocol.js";

/** Deterministic stand-in, not an LLM or a desktop implementation. */
export const createProvider: ProviderFactory = (bridge, options) => ({
  name: "instance-fixture",
  providerName: "instance-fixture",
  async run(run) {
    const prompt = JSON.parse(run.prompt) as {
      parentId: string;
      charter: string;
      messages: string[];
    };
    const sessionId = run.session?.id ?? randomUUID();
    run.onChunk?.(`Actor provider running in PID ${process.pid}\n`);
    await delay(Number(options.delayMs ?? 25), undefined, { signal: run.signal });
    const report = {
      pid: process.pid,
      sessionId,
      resumed: Boolean(run.session?.id),
      charter: prompt.charter,
      messages: prompt.messages,
    };
    await bridge.sendMessage(prompt.parentId, JSON.stringify(report));
    bridge.yieldRun("complete", "Scripted instance round trip complete");
    return { success: true, output: JSON.stringify(report), exitCode: 0, sessionId };
  },
});

import { randomUUID } from "node:crypto";
