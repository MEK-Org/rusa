import { startWebhookForwarder, type TargetGroup } from "../webhook/forwarder.js";

export interface ForwardWebhooksOptions {
  host?: string;
  port: number;
  targets: string[];
}

/**
 * Parse CLI --target values into target groups.
 * A value containing "|" is a fallback chain: "urlA|urlB" means try A first,
 * fall back to B. A plain URL is a standalone group (always attempted).
 */
function parseTargetGroups(raw: string[]): TargetGroup[] {
  return raw.map((value) => {
    const parts = value
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  });
}

export async function runForwardWebhooks(opts: ForwardWebhooksOptions): Promise<void> {
  if (opts.targets.length === 0) {
    throw new Error("At least one --target is required.");
  }

  const forwarder = await startWebhookForwarder({
    host: opts.host,
    port: opts.port,
    targets: parseTargetGroups(opts.targets),
  });

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await forwarder.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
