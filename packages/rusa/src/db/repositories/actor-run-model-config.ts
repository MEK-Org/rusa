/**
 * The immutable provider selection that opened an actor run. This document is
 * deliberately versioned because it is stored as JSON in SQLite rather than
 * spread across columns: readers validate it here, not with SQLite JSON
 * functions, so future document versions have one explicit migration path.
 */
export interface ActorRunModelConfig {
  version: 1;
  provider: string;
  model: string;
  effort?: string;
}

export function createActorRunModelConfig(input: {
  provider: string;
  model: string;
  effort?: string;
}): ActorRunModelConfig {
  return validateActorRunModelConfig({ version: 1, ...input });
}

export function serializeActorRunModelConfig(config: ActorRunModelConfig): string {
  return JSON.stringify(validateActorRunModelConfig(config));
}

/** Parse a stored launch document. `null` or undefined is the pre-0042 historical shape. */
export function parseActorRunModelConfig(
  value: string | null | undefined
): ActorRunModelConfig | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid actor run model_config: invalid JSON");
  }
  return validateActorRunModelConfig(parsed);
}

function validateActorRunModelConfig(value: unknown): ActorRunModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid actor run model_config: expected an object");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["version", "provider", "model", "effort"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`invalid actor run model_config: unexpected property '${key}'`);
    }
  }
  if (record.version !== 1) {
    throw new Error("invalid actor run model_config: unsupported version");
  }
  if (typeof record.provider !== "string" || !record.provider.trim()) {
    throw new Error("invalid actor run model_config: provider must be a nonblank string");
  }
  if (typeof record.model !== "string" || !record.model.trim()) {
    throw new Error("invalid actor run model_config: model must be a nonblank string");
  }
  if (record.effort !== undefined && (typeof record.effort !== "string" || !record.effort.trim())) {
    throw new Error("invalid actor run model_config: effort must be a nonblank string when set");
  }
  return {
    version: 1,
    provider: record.provider,
    model: record.model,
    ...(record.effort === undefined ? {} : { effort: record.effort }),
  };
}
