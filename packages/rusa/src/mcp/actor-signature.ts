import type { RawProviderModelConfig } from "../providers/model-config.js";

/** Format the visible terminal footer mechanically added to actor-authored writes. */
export function formatVisibleActorSignature(
  actorHandle: string,
  selection?: RawProviderModelConfig,
  target: "github" | "google-chat" = "github"
): string {
  const signature = selection?.model
    ? selection.effort
      ? `${actorHandle} (${selection.model}, ${selection.effort})`
      : `${actorHandle} (${selection.model})`
    : actorHandle;
  // GitHub uses asterisks for italic text; Google Chat uses underscores.
  const delimiter = target === "google-chat" ? "_" : "*";
  return `${delimiter}${signature}${delimiter}`;
}
