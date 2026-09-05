import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    demo: "src/experimental/process-actors/demo.ts",
    child: "src/experimental/process-actors/child.ts",
    "fixture-provider": "src/experimental/process-actors/fixture-provider.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "build/process-actors",
  clean: true,
});
