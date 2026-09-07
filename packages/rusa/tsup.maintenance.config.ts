import { defineConfig } from "tsup";

// Build maintenance and quota-evaluation utilities into an isolated directory so
// they do not pollute the production CLI bundle or trigger code-splitting cycles.
export default defineConfig({
  entry: {
    "mcp/quota-mcp": "src/mcp/quota-mcp.ts",
    "quota/shared-store": "src/quota/shared-store.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "build/maintenance",
  clean: false,
});
