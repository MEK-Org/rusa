import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError } from "./result.js";

type ServerInfo = ConstructorParameters<typeof McpServer>[0];
type ServerOptions = ConstructorParameters<typeof McpServer>[1];
type RegisterTool = McpServer["registerTool"];

/**
 * The SDK's own classification of "raw shape vs. schema instance"
 * (`isZodTypeLike` / `isZodSchemaInstance` / `isZodRawShapeCompat` in
 * `server/mcp.js`), reproduced so we strictify exactly the values it would have
 * wrapped in `z.object(...)` and nothing else.
 *
 * The duck-typed `parse`/`safeParse` arm is load-bearing, not defensive
 * symmetry. A schema object that carries neither `_def` nor `_zod` and keeps
 * its methods on the prototype has **no own enumerable keys**, so dropping the
 * arm classifies it as the empty raw shape — a tool with no parameters — and we
 * would replace a complete schema with `z.strictObject({})`, advertising
 * `properties: {}` and rejecting every argument. Divergence in the other
 * direction is quieter but still wrong: a shape the SDK recognizes and we
 * don't gets wrapped downstream, non-strictly, which is the exact gap this
 * module exists to close.
 */
function isZodTypeLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof (value as { parse: unknown }).parse === "function" &&
    "safeParse" in value &&
    typeof (value as { safeParse: unknown }).safeParse === "function"
  );
}

function isZodSchemaInstance(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ("_def" in value || "_zod" in value || isZodTypeLike(value))
  );
}

function isRawShape(value: unknown): value is z.ZodRawShape {
  if (typeof value !== "object" || value === null) return false;
  if (isZodSchemaInstance(value)) return false;
  // An empty object is a valid raw shape: a tool that takes no parameters.
  if (Object.keys(value).length === 0) return true;
  return Object.values(value).some(isZodTypeLike);
}

/**
 * Build an `McpServer` that **rejects unknown tool parameters** instead of
 * silently discarding them .
 *
 * The SDK wraps a registered raw shape in `z.object(shape)`, which strips keys
 * it doesn't know. That is benign for most tools — a dropped filter yields a
 * superset, which is visibly wrong. It is not benign when two properties hold
 * at once: the param is **optional**, and its absence has a valid but
 * *different* meaning. `understanding.list_children` is both. Passing `id`
 * (the name its sibling `get_node` uses) got the key dropped, `node_id` read
 * `undefined`, and `undefined` is the documented request for *the top-level
 * nodes*. The call returned a well-formed list of children belonging to a
 * different node, with nothing in the response to distinguish "here are the
 * children you asked for" from "I ignored your argument" — a reachability walk
 * run that way succeeds trivially, for any node, including one that is not in
 * the tree at all.
 *
 * An unknown param is always a caller bug, so this is applied at construction
 * for every tool on every server rather than audited tool by tool. A caller
 * that gets the name wrong now gets an error naming the key.
 *
 * A tool that registers a **complete Zod schema** rather than a raw shape is
 * left alone: it has chosen its own unknown-key policy and we do not override it.
 */

export const DEFAULT_FENCED_ERROR_MESSAGE =
  "Run is over: yield_run has already been called for this turn. Do not call any further tools; end your turn now.";

export interface StrictServerOptions {
  capabilities?: ServerOptions extends { capabilities?: infer C } ? C : undefined;
  isFenced?: () => boolean;
  fencedErrorMessage?: string;
}

export function createMcpServer(info: ServerInfo, options?: StrictServerOptions): McpServer {
  const { isFenced, fencedErrorMessage, ...serverOptions } = options ?? {};
  const server = new McpServer(
    info,
    Object.keys(serverOptions).length > 0 ? (serverOptions as ServerOptions) : undefined
  );
  // biome-ignore lint/suspicious/noExplicitAny: registerTool generic cannot be expressed without cast
  const register = server.registerTool.bind(server) as any;

  // Shadow the prototype method on this instance. The cast is unavoidable:
  // `inputSchema` is a generic parameter of `registerTool`, and swapping a raw
  // shape for the ZodObject the SDK would itself have built from it is not
  // expressible in that generic.
  // biome-ignore lint/suspicious/noExplicitAny: registerTool signature is generic
  server.registerTool = ((name: any, config: any, cb: any) =>
    register(
      name,
      {
        ...config,
        inputSchema: isRawShape(config.inputSchema)
          ? z.strictObject(config.inputSchema)
          : config.inputSchema,
      },
      // biome-ignore lint/suspicious/noExplicitAny: callback arguments are forwarded
      async (args: any, extra: any) => {
        if (isFenced?.()) {
          return toolError(new Error(fencedErrorMessage ?? DEFAULT_FENCED_ERROR_MESSAGE));
        }
        return cb(args, extra);
      }
    )) as RegisterTool;

  return server;
}
