import { defineConfig } from "tsup";

// Build the follower without compiling the leader CLI or the Flutter dashboard.
export default defineConfig({
  entry: {
    follower: "src/experimental/remote-instances/follower.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "build/follower",
  clean: true,
});
