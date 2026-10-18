/** Pi 0.99.2 only waits ten seconds for direct MCP servers and swallows hook
 * exceptions. Exit the fresh process before inference if any required namespace
 * has no registered tool. This intentionally rejects empty tool servers too.
 */
export function mcpAdmissionExtension(names: string[], waitMs = 12_000): string {
  const namespaces = names.map((name) => name.replace(/[^A-Za-z0-9_]/g, "_"));
  if (
    new Set(namespaces).size !== names.length ||
    namespaces.some((name) => name.length > 40 || !name)
  ) {
    throw new Error("OpenRouter prototype requires distinct short MCP namespaces");
  }
  return `export default function(pi) {
    pi.on("before_agent_start", async () => {
      const required = ${JSON.stringify(namespaces.map((name) => `mcp__${name}__`))};
      const deadline = Date.now() + ${waitMs};
      while (true) {
        const tools = pi.getAllTools();
        if (required.every(prefix => tools.some(tool => tool.name.startsWith(prefix)))) return;
        if (Date.now() >= deadline) process.exit(78);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
  }`;
}
