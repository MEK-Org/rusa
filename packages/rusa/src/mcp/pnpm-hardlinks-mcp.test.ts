import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryThreadRegistry } from "../actor/thread-registry.js";
import { pnpmStoreFileForContent } from "../pnpm/hardlinks.js";
import {
  createPnpmHardlinksMcpServer,
  type PnpmHardlinksToolDeps,
  runForceRelinkWorkers,
} from "./pnpm-hardlinks-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("pnpm hardlinks MCP", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture(
    runningThreadIds: string[] = []
  ): PnpmHardlinksToolDeps & { projectDir: string; storeDir: string } {
    const root = mkdtempSync(join(tmpdir(), "mc-pnpm-hardlinks-mcp-"));
    tempDirs.push(root);
    const workersDir = join(root, "workers");
    const workerDir = join(workersDir, "worker-1");
    const projectDir = join(workerDir, "repo");
    const packageDir = join(
      projectDir,
      "node_modules",
      ".pnpm",
      "left-pad@1.3.0",
      "node_modules",
      "left-pad"
    );
    const storeDir = join(root, "store", "v10");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(projectDir, "node_modules", ".modules.yaml"), `storeDir: ${storeDir}\n`);
    mkdirSync(join(storeDir, "files"), { recursive: true });
    const file = join(packageDir, "index.js");
    writeFileSync(file, "module.exports = leftPad;\n");
    const storeFile = pnpmStoreFileForContent(file, storeDir);
    mkdirSync(dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, "module.exports = leftPad;\n");
    const registry = new InMemoryThreadRegistry();
    registry.upsert({
      id: "worker-1",
      charter: "test",
      parentId: "root",
      status: "active",
      createdAt: "2026-06-30T00:00:00.000Z",
    });
    return {
      rootId: "root",
      workersDir,
      registry,
      runningThreadIds: () => runningThreadIds,
      projectDir,
      storeDir,
    };
  }

  it("skips workers with active runs", () => {
    const deps = fixture(["worker-1"]);
    const file = join(
      deps.projectDir,
      "node_modules",
      ".pnpm",
      "left-pad@1.3.0",
      "node_modules",
      "left-pad",
      "index.js"
    );
    const before = statSync(file);

    expect(runForceRelinkWorkers(deps, { dryRun: false })).toEqual([
      { workerId: "worker-1", skipped: "run in progress", projects: [] },
    ]);
    const after = statSync(file);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(1);
  });

  it("relinks idle worker package copies through the host plane", () => {
    const deps = fixture();

    const summary = runForceRelinkWorkers(deps, { dryRun: false });

    expect(summary[0]?.projects[0]).toEqual(
      expect.objectContaining({
        projectDir: deps.projectDir,
        scanned: 1,
        relinked: 1,
        failed: 0,
        invariantProblems: 0,
      })
    );
  });

  it("refuses non-root callers", async () => {
    const deps = fixture();
    const client = await connect(createPnpmHardlinksMcpServer(deps, "worker-1"));

    const result = textOf(
      (await client.callTool({
        name: "force_relink_workers",
        arguments: { dry_run: true },
      })) as CallToolResult
    );

    expect(result).toBe(
      "'pnpm-hardlinks' is a root-only tool — refusing to run it for 'worker-1'."
    );
  });

  it("reports already-linked files without rewriting them", () => {
    const deps = fixture();
    const file = join(
      deps.projectDir,
      "node_modules",
      ".pnpm",
      "left-pad@1.3.0",
      "node_modules",
      "left-pad",
      "index.js"
    );
    const storeFile = pnpmStoreFileForContent(file, deps.storeDir);
    unlinkSync(file);
    linkSync(storeFile, file);

    const summary = runForceRelinkWorkers(deps, { dryRun: false });

    expect(summary[0]?.projects[0]).toEqual(
      expect.objectContaining({
        relinked: 0,
        alreadyLinked: 1,
        invariantProblems: 0,
      })
    );
  });

  it("is idempotent after relinking copied files", () => {
    const deps = fixture();

    expect(runForceRelinkWorkers(deps, { dryRun: false })[0]?.projects[0]).toEqual(
      expect.objectContaining({
        relinked: 1,
        alreadyLinked: 0,
        invariantProblems: 0,
      })
    );
    expect(runForceRelinkWorkers(deps, { dryRun: false })[0]?.projects[0]).toEqual(
      expect.objectContaining({
        relinked: 0,
        alreadyLinked: 1,
        invariantProblems: 0,
      })
    );
  });

  it("treats missing-store files as benign — reclaim succeeds without throwing ", () => {
    const deps = fixture();
    const file = join(
      deps.projectDir,
      "node_modules",
      ".pnpm",
      "left-pad@1.3.0",
      "node_modules",
      "left-pad",
      "index.js"
    );
    // Content is no longer in the shared CAS → the file can't be hardlinked, but that's benign
    // (unlinkable, not a failure). A clean reclaim must return success, not throw.
    unlinkSync(pnpmStoreFileForContent(file, deps.storeDir));

    const summary = runForceRelinkWorkers(deps, { dryRun: false });
    expect(summary[0]?.projects[0]).toEqual(
      expect.objectContaining({ missingStoreFile: 1, failed: 0, invariantProblems: 0 })
    );
  });

  it("fails loudly on a genuine not-same-inode invariant problem", () => {
    const deps = fixture();
    const file = join(
      deps.projectDir,
      "node_modules",
      ".pnpm",
      "left-pad@1.3.0",
      "node_modules",
      "left-pad",
      "index.js"
    );
    // Give the copied file nlink>1 (so the relink fast-path skips it) while it still points at the
    // WRONG inode (its own copy, not the store) → a real not-same-inode corruption the gate must catch.
    linkSync(file, join(deps.projectDir, "decoy.js"));

    expect(() => runForceRelinkWorkers(deps, { dryRun: false })).toThrow(
      /pnpm hardlink relink did not converge/
    );
  });
});
