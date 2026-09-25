import type { RusaConfig } from "../../config/types.js";
import { resolveProvider } from "../../providers/registry.js";
import type { ProviderFactory } from "./protocol.js";

export interface ProviderSelection {
  providers: RusaConfig["providers"];
  name: string;
  model?: string;
  effort?: string;
}

/** Construct the provider adapter for the tuple the leader admitted. */
export const createProvider: ProviderFactory = (_bridge, options, selected) => {
  const selection = options as unknown as ProviderSelection;
  // The provider registry reads only providers; other service config stays in the parent.
  return resolveProvider(
    { providers: selection.providers } as RusaConfig,
    selected?.provider ?? selection.name,
    selected?.model ?? selection.model,
    selected?.effort ?? selection.effort
  );
};
