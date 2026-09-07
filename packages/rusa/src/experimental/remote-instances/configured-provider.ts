import type { RusaConfig } from "../../config/types.js";
import { resolveProvider } from "../../providers/registry.js";
import type { ProviderFactory } from "./protocol.js";

export interface ProviderSelection {
  providers: RusaConfig["providers"];
  name: string;
  model?: string;
  effort?: string;
}

/** Construct an ordinary provider adapter inside the follower instance. */
export const createProvider: ProviderFactory = (_bridge, options) => {
  const selection = options as unknown as ProviderSelection;
  // The provider registry reads only providers; other service config stays in the parent.
  return resolveProvider(
    { providers: selection.providers } as RusaConfig,
    selection.name,
    selection.model,
    selection.effort
  );
};
