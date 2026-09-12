import type { RusaConfig } from "../config/types.js";
import {
  type ProviderModelConfig,
  type RawProviderModelConfig,
  validateModelConfigPool,
} from "../providers/model-config.js";
import type { ActorRepository } from "../repositories/actor-repository.js";

/**
 * Startup refused to construct the root actor because the `model_config`
 * persisted on its record cannot be run under the current configuration.
 * Named so the journal record and the exit reason are greppable, and so the
 * boot path never mistakes it for a generic throw it should fall back from:
 * the persisted pool is authoritative after bootstrap, and silently replacing
 * it with the file tuple is exactly the behaviour this guards against.
 */
export class RootModelConfigStartupError extends Error {
  override readonly name = "RootModelConfigStartupError";
  /** What an operator can do about it, in words that fit one journal line. */
  readonly action: string;

  constructor(message: string, action: string, options?: { cause?: unknown }) {
    super(message, options);
    this.action = action;
  }
}

export interface RootBootModelConfig {
  /**
   * `persisted` — the record already carried a pool and startup preserved it;
   * `bootstrap` — the record had none, so the configured tuple seeded it.
   */
  source: "persisted" | "bootstrap";
  /** Validated, ordered pool the live root actor and its record both run on. */
  modelConfig: ProviderModelConfig[];
  /** Class provenance retained from the persisted record; never set on bootstrap. */
  modelClass?: string;
}

/**
 * Decide which model pool the root actor boots on.
 *
 * The actor repository is the durable source for every other actor's
 * `model_config`, and `set_actor_model` writes the root's there too. Startup
 * therefore reads the root's persisted pool back and preserves it — order,
 * provider, model and effort intact — validating it through the same pool
 * validator every spawn and `set_actor_model` already passes through. The
 * scalar `rootActor` file fields only seed a record that carries no pool at
 * all: a fresh database, or a legacy document that predates the required
 * provider/model contract and is read back as unset.
 *
 * A persisted pool that no longer validates (a provider removed from
 * `providers`, a model the catalog now rejects, a multi-entry pool on a root
 * that the file has since made native) throws {@link RootModelConfigStartupError}
 * rather than falling back to the file: a fallback would look like a
 * successful boot while quietly discarding an operator's choice.
 */
export function resolveRootBootModelConfig(input: {
  config: RusaConfig;
  actors: Pick<ActorRepository, "get">;
  rootId: string;
  bootstrap: RawProviderModelConfig;
  portable: boolean;
}): RootBootModelConfig {
  const { config, rootId, portable } = input;
  const existing = input.actors.get(rootId);
  const persisted = existing?.modelConfig;
  if (persisted && persisted.length > 0) {
    let modelConfig: ProviderModelConfig[];
    try {
      modelConfig = validateModelConfigPool(config, persisted, { portable });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new RootModelConfigStartupError(
        `root actor '${rootId}' has a persisted model_config that is not valid under the current configuration: ${reason} (persisted pool: ${describePool(persisted)})`,
        "restore the provider/model it names in config.yaml, or clear the root row's model_config in the actors table so the configured rootActor tuple seeds it again; startup never overwrites a persisted root pool from the file",
        { cause }
      );
    }
    return {
      source: "persisted",
      modelConfig,
      ...(existing?.modelClass === undefined ? {} : { modelClass: existing.modelClass }),
    };
  }
  try {
    return {
      source: "bootstrap",
      modelConfig: validateModelConfigPool(config, [input.bootstrap], { portable }),
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new RootModelConfigStartupError(
      `root actor '${rootId}' has no persisted model_config and the configured rootActor tuple cannot seed it: ${reason} (configured: ${describePool([input.bootstrap])})`,
      "set rootActor.provider/model/effort in config.yaml to a provider declared under `providers` and a model it accepts",
      { cause }
    );
  }
}

/** Human-readable pool summary, matching the mesh's model-set event wording. */
export function describePool(pool: readonly RawProviderModelConfig[]): string {
  return pool
    .map((c) => `${c.provider}${c.model ? `:${c.model}` : ""}${c.effort ? ` @ ${c.effort}` : ""}`)
    .join(", ");
}
