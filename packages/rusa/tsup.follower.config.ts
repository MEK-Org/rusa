import { defineConfig } from "tsup";

// Build the follower without compiling the leader CLI or the Flutter dashboard.
export default defineConfig({
  entry: {
    follower: "src/experimental/process-actors/follower.ts",
    "process-actor-child": "src/experimental/process-actors/child.ts",
    "process-actor-provider": "src/experimental/process-actors/configured-provider.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "build/follower",
  clean: true,
});
