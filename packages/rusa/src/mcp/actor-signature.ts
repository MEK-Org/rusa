import type { RawProviderModelConfig } from "../providers/model-config.js";

/** Format the visible terminal footer mechanically added to actor-authored writes. */
export function formatVisibleActorSignature(
  actorHandle: string,
  selection?: RawProviderModelConfig,
  target: "github" | "google-chat" | "slack" = "github"
): string {
  const signature = selection?.model
    ? selection.effort
      ? `${actorHandle} (${selection.model}, ${selection.effort})`
      : `${actorHandle} (${selection.model})`
    : actorHandle;
  // GitHub uses asterisks for italic text; Google Chat and Slack use underscores.
  const delimiter = target === "github" ? "*" : "_";
  return `${delimiter}${signature}${delimiter}`;
}

/** Add the terminal footer unless the caller already supplied this exact one. */
export function appendVisibleActorSignature(body: string, signature: string): string {
  const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailingSignature = new RegExp(`(?:^|\\r?\\n)${escapedSignature}[\\t ]*(?:\\r?\\n)?$`);
  return trailingSignature.test(body) ? body : body ? `${body}\n\n${signature}` : signature;
}
