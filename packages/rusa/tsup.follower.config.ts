import { defineConfig } from "tsup";

// Build the follower without compiling the leader CLI or the Flutter dashboard.
export default defineConfig({
  entry: {
    follower: "src/experimental/remote-instances/follower.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: process.env.RUSA_FOLLOWER_DIST_DIR ?? "build/follower",
  clean: true,
});
