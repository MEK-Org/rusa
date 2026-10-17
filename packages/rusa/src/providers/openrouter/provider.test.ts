// @vitest-environment node
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "./provider.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openrouter-provider-test-"));
  roots.push(root);
  const apiKeyPath = join(root, "key");
  await writeFile(apiKeyPath, "synthetic-not-a-real-key", { mode: 0o600 });
  const config = {
    openrouterPoc: {
      nodePath: process.execPath,
      piPath: fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url)),
      apiKeyPath,
    },
  };
  return {
    root,
    apiKeyPath,
    provider: new OpenRouterProvider("test", config, "vendor/fixed-model"),
  };
}
it("requires opt-in and refuses worker sandbox launches before inference", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "");
  await expect(provider.run({ cwd: root, prompt: "ping" })).rejects.toThrow(/requires/);
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  await expect(
    provider.run({ cwd: root, prompt: "ping", sandbox: { worktreePath: root } })
  ).rejects.toThrow(/host runs only/);
});
it("refuses a group-readable key", async () => {
  const { root, apiKeyPath, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  await chmod(apiKeyPath, 0o640);
  await expect(provider.run({ cwd: root, prompt: "ping" })).rejects.toThrow(/private file/);
});
it("settles through real pipes, reaps the peer and retains usage without a subscription token record", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const result = await provider.run({
    cwd: root,
    prompt: "ping-unique",
  });
  expect(result).toEqual({
    success: true,
    output: "ping-unique",
    exitCode: 0,
    model: "vendor/fixed-model",
  });
  const artifacts = await readdir(join(root, ".openrouter-poc"));
  expect(artifacts).toHaveLength(1);
  const receipt = await readFile(join(root, ".openrouter-poc", artifacts[0] as string), "utf8");
  expect(JSON.parse(receipt).requests[0].usage).toEqual({ input: 3, output: 2 });
  expect(receipt).not.toContain("synthetic-not-a-real-key");
}, 10000);
