import type { RawProviderModelConfig } from "../providers/model-config.js";

/** Format the visible terminal footer mechanically added to actor-authored writes. */
export function formatVisibleActorSignature(
  actorHandle: string,
  selection?: RawProviderModelConfig
): string {
  const signature = selection?.model
    ? selection.effort
      ? `${actorHandle} (${selection.model}, ${selection.effort})`
      : `${actorHandle} (${selection.model})`
    : actorHandle;
  return `*${signature}*`;
}

/**
 * Add a visible actor footer unless the caller has already supplied this exact
 * signature as the final line. The comparison deliberately does not treat a
 * different actor or run selection as equivalent.
 */
export function appendVisibleActorSignature(body: string, signature: string): string {
  const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailingSignature = new RegExp(`(?:^|\\r?\\n)${escapedSignature}[\\t ]*(?:\\r?\\n)?$`);
  return trailingSignature.test(body) ? body : body ? `${body}\n\n${signature}` : signature;
}
