import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wrap a successful tool result as content. Objects are JSON-stringified; strings
 * pass through. Returning the typed {@link CallToolResult} keeps the `"text"`
 * literal correctly narrowed.
 */
export function toolOk(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Wrap a tool failure as an error result so the caller (an agent) sees the error
 * as a tool result rather than a transport-level throw.
 */
export function toolError(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  };
}
