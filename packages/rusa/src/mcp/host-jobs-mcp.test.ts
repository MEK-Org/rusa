import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeHostJobAuditArtifact } from "../actor/host-job-audit-artifact.js";
import { buildHostJobBwrapArgs } from "../actor/host-job-runner.js";
import { InMemoryHostJobStore } from "../actor/host-job-store.js";
import type { MeshEventInput } from "../actor/mesh-events.js";
import { createHostJobsServer } from "./host-jobs-mcp.js";

vi.mock("../actor/host-job-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../actor/host-job-runner.js")>(
    "../actor/host-job-runner.js"
  );
  return {
    ...actual,
    buildHostJobBwrapArgs: vi.fn(() => []),
    buildSystemdRunArgv: vi.fn(() => ["systemd-run"]),
    spawnHostJob: vi.fn(),
  };
});

vi.mock("../actor/host-job-audit-artifact.js", async () => {
  const actual = await vi.importActual<typeof import("../actor/host-job-audit-artifact.js")>(
    "../actor/host-job-audit-artifact.js"
  );
  return {
    ...actual,
    writeHostJobAuditArtifact: vi.fn(actual.writeHostJobAuditArtifact),
  };
});

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function dataOf(result: CallToolResult): unknown {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  return JSON.parse(text);
}

describe("host-jobs MCP audit capture", () => {
  let mcHome: string;
  let store: InMemoryHostJobStore;
  let events: MeshEventInput[];

  beforeEach(() => {
    mcHome = join(tmpdir(), `host-jobs-mcp-test-${randomUUID()}`);
    store = new InMemoryHostJobStore();
    events = [];
  });

  afterEach(() => {
    rmSync(mcHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("stamps HostJobRecord and submitted ledger event with audit pointer + sha256 but not body", async () => {
    const client = await connect(
      createHostJobsServer(
        {
          store,
          handleForId: () => "handle",
          mcHome,
          recordEvent: (event) => events.push(event),
          now: () => "2026-07-13T00:00:00.000Z",
        },
        "actor-1"
      )
    );
    const script = 'echo SECRETISH-BODY "$1"\n';
    const args = ["arg-one", "arg two"];
    const manifest = { readPaths: [] };

    const result = dataOf(
      (await client.callTool({
        name: "submit_job",
        arguments: { script, args, manifest, runtimeMaxSec: 60 },
      })) as CallToolResult
    ) as { id: string };

    const record = store.get(result.id);
    expect(record).toBeDefined();
    const artifactBytes = readFileSync(record?.auditArtifactPath ?? "");
    const artifact = JSON.parse(artifactBytes.toString("utf-8"));
    expect(artifact).toMatchObject({
      version: 1,
      jobId: result.id,
      script,
      args,
      manifest,
    });
    const hash = createHash("sha256").update(artifactBytes).digest("hex");
    expect(record?.auditArtifactSha256).toBe(hash);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "host_job_submitted",
      actorId: "actor-1",
    });
    expect(events[0]).not.toHaveProperty("body");
    expect(events[0]?.detail).toContain(record?.auditArtifactPath);
    expect(events[0]?.detail).toContain(hash);
    expect(events[0]?.detail).not.toContain("SECRETISH-BODY");
    expect(events[0]?.detail).not.toContain("arg-one");
    expect(events[0]?.detail).not.toContain("readPaths");
  });

  it("writes no audit artifact, no scratch dir, and no record when manifest validation rejects ", async () => {
    vi.mocked(buildHostJobBwrapArgs).mockImplementationOnce(() => {
      throw new Error('host-jobs manifest: "~/.ssh" is denied (overlaps credential store ~/.ssh)');
    });
    const client = await connect(
      createHostJobsServer(
        {
          store,
          handleForId: () => "handle",
          mcHome,
          recordEvent: (event) => events.push(event),
          now: () => "2026-07-13T00:00:00.000Z",
        },
        "actor-1"
      )
    );

    const result = (await client.callTool({
      name: "submit_job",
      arguments: {
        script: "echo should-never-run\n",
        args: [],
        manifest: { readPaths: ["~/.ssh"] },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(store.list()).toEqual([]);
    expect(events).toEqual([]);

    const auditDir = join(mcHome, "host-jobs", "audit");
    expect(existsSync(auditDir) ? readdirSync(auditDir) : []).toEqual([]);
    const hostJobsDir = join(mcHome, "host-jobs");
    const remainingEntries = existsSync(hostJobsDir)
      ? readdirSync(hostJobsDir).filter((name) => name !== "audit")
      : [];
    expect(remainingEntries).toEqual([]);
  });

  it("purges the scratch dir and audit artifact when a write fails after the script was already written ", async () => {
    vi.mocked(writeHostJobAuditArtifact).mockImplementationOnce(() => {
      throw new Error("simulated pre-spawn write failure");
    });
    const client = await connect(
      createHostJobsServer(
        {
          store,
          handleForId: () => "handle",
          mcHome,
          recordEvent: (event) => events.push(event),
          now: () => "2026-07-13T00:00:00.000Z",
        },
        "actor-1"
      )
    );

    const result = (await client.callTool({
      name: "submit_job",
      arguments: {
        script: "echo should-never-run\n",
        args: [],
        manifest: { readPaths: [] },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(store.list()).toEqual([]);
    expect(events).toEqual([]);

    const auditDir = join(mcHome, "host-jobs", "audit");
    expect(existsSync(auditDir) ? readdirSync(auditDir) : []).toEqual([]);
    const hostJobsDir = join(mcHome, "host-jobs");
    const remainingEntries = existsSync(hostJobsDir)
      ? readdirSync(hostJobsDir).filter((name) => name !== "audit")
      : [];
    expect(remainingEntries).toEqual([]);
  });
});
