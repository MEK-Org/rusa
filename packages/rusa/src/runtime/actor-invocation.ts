import { Actor, type ActorOptions, type PromptBuild } from "../actor/actor.js";
import type { MeshActor } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { McpServerSpec } from "../providers/types.js";

/**
 * The inputs needed to construct one live actor invocation.
 *
 * The durable record deliberately says nothing about how this process invokes
 * it. Provider selection, capabilities, workspace policy, session/prompt
 * sources, and the execution driver are composition inputs. Keeping those
 * axes separate lets a later caller provide another opaque-id root without
 * treating parentlessness or a literal id as an execution role.
 */
export interface ActorInvocationInput {
  /** Durable identity and topology. Construction only reads the id from it. */
  record: ActorRecord;
  /** Capabilities already resolved by host composition; MCP servers are their runtime projection. */
  capabilities: readonly string[];
  /** Execution environment, independent of actor hierarchy and capabilities. */
  workspace: {
    cwd: string;
    addDirs?: string[];
    sandbox?: boolean;
    isE2eRoot?: boolean;
    prepareUnderstandingMount?: ActorOptions["prepareUnderstandingMount"];
  };
  /** Current provider/model policy, including any explicitly supplied fallback. */
  provider: {
    modelConfig: RawProviderModelConfig[];
    resolveProvider: ActorOptions["resolveProvider"];
    fallback?: ActorOptions["fallback"];
  };
  /** Actor-bound tools, assembled from the capability inputs by the host. */
  mcpServers: McpServerSpec[];
  /** Working-memory persistence is an invocation input, not a root/worker property. */
  session: {
    load: () => string | undefined;
    save: (id: string) => void;
  };
  /** Prompt construction (including portable-context injection) is per invocation. */
  prompt: () => PromptBuild;
  /** All remaining current Actor hooks/options, kept intact by this seam. */
  actorOptions: Omit<
    ActorOptions,
    | "id"
    | "cwd"
    | "modelConfig"
    | "resolveProvider"
    | "mcpServers"
    | "sandbox"
    | "isE2eRoot"
    | "prepareUnderstandingMount"
    | "addDirs"
    | "loadSessionId"
    | "saveSessionId"
    | "buildPrompt"
    | "fallback"
  >;
  /** Optional E2E/remote execution driver; absent means the local Actor driver. */
  driver?: (input: ActorInvocationInput, options: ActorOptions) => MeshActor;
}

/**
 * Construct one configured, spawned, or rehydrated actor through the same
 * invocation boundary. This function intentionally does not infer hierarchy,
 * authority, capabilities, or sandbox policy from an actor id or record role.
 */
export function constructActorFromInvocation(input: ActorInvocationInput): MeshActor {
  const options: ActorOptions = {
    ...input.actorOptions,
    id: input.record.id,
    cwd: input.workspace.cwd,
    modelConfig: input.provider.modelConfig,
    resolveProvider: input.provider.resolveProvider,
    mcpServers: input.mcpServers,
    sandbox: input.workspace.sandbox,
    isE2eRoot: input.workspace.isE2eRoot,
    prepareUnderstandingMount: input.workspace.prepareUnderstandingMount,
    addDirs: input.workspace.addDirs,
    loadSessionId: input.session.load,
    saveSessionId: input.session.save,
    buildPrompt: input.prompt,
    fallback: input.provider.fallback,
  };
  return input.driver?.(input, options) ?? new Actor(options);
}
