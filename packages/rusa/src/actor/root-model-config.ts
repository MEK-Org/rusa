import type { RusaConfig } from "../config/types.js";
import {
  describeModelConfigPool,
  type ProviderModelConfig,
  type RawProviderModelConfig,
  validateModelConfigPool,
} from "../providers/model-config.js";
import type { ActorRepository } from "../repositories/actor-repository.js";

/**
 * The root's boot-time model-pool decision, kept apart from `start.ts` because
 * it is a root-only carve-out: every other actor's pool is simply read from its
 * record, and the day root stops being special (#333's stated direction) this
 * module is deleted whole rather than untangled from the boot sequence. Being
 * a pure function of config plus repository also lets the refusal branches be
 * pinned without booting the service.
 */

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
 * provider/model contract and is read back as unset. `modelClass` is not
 * decided here: a class-bound root's pool arrives already resolved from the
 * live class row (#626), so preserving it preserves the class's current
 * definition, and a seeded record never had a class to lose.
 *
 * `preflight` runs once per validated entry (the caller instantiates the
 * provider, as worker spawn does for its pool) so an adapter the build lacks
 * refuses boot here, by name, rather than on root's first run.
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
  preflight?: (entry: ProviderModelConfig) => void;
}): RootBootModelConfig {
  const { config, rootId, portable, preflight } = input;
  const rootRecord = input.actors.get(rootId);
  // A class-bound root resolves its pool from the class row like any other
  // actor, so `persisted` below is already the class's current definition. When
  // that class is missing, deleted, empty or invalid there is no pool at all —
  // and falling through to the configured tuple would boot root on a selection
  // nobody chose, the same silent substitution this module exists to prevent
  // (#626).
  if (rootRecord?.modelClassError !== undefined) {
    throw new RootModelConfigStartupError(
      `root actor '${rootId}' is bound to model class "${rootRecord.modelClass}", which cannot be resolved: ${rootRecord.modelClassError}`,
      "redefine that model class with set_model_class, or re-pin root to an explicit pool by replacing the root row's model_config in the actors table; startup never falls back to the configured rootActor tuple for a class-bound root"
    );
  }
  const persisted = rootRecord?.modelConfig;
  const resolve = (pool: readonly RawProviderModelConfig[]): ProviderModelConfig[] => {
    const modelConfig = validateModelConfigPool(config, [...pool], { portable });
    for (const entry of modelConfig) preflight?.(entry);
    return modelConfig;
  };
  if (persisted && persisted.length > 0) {
    try {
      return { source: "persisted", modelConfig: resolve(persisted) };
    } catch (cause) {
      throw new RootModelConfigStartupError(
        `root actor '${rootId}' has a persisted model_config that is not valid under the current configuration: ${reasonOf(cause)} (persisted pool: ${describeModelConfigPool(persisted)})`,
        "restore the provider/model it names in config.yaml, or clear the root row's model_config in the actors table so the configured rootActor tuple seeds it again; startup never overwrites a persisted root pool from the file",
        { cause }
      );
    }
  }
  try {
    return { source: "bootstrap", modelConfig: resolve([input.bootstrap]) };
  } catch (cause) {
    throw new RootModelConfigStartupError(
      `root actor '${rootId}' has no persisted model_config and the configured rootActor tuple cannot seed it: ${reasonOf(cause)} (configured: ${describeModelConfigPool([input.bootstrap])})`,
      "set rootActor.provider/model/effort in config.yaml to a provider declared under `providers` and a model it accepts",
      { cause }
    );
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
