import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hostJobAuditArtifactDir,
  serializeHostJobAuditArtifact,
  sha256Hex,
  writeHostJobAuditArtifact,
} from "./host-job-audit-artifact.js";

describe("host job audit artifacts", () => {
  let mcHome: string;

  beforeEach(() => {
    mcHome = mkdtempSync(join(tmpdir(), "host-job-audit-test-"));
  });

  afterEach(() => {
    rmSync(mcHome, { recursive: true, force: true });
  });

  it("writes exact submitted script, args, and manifest bytes and returns their sha256", () => {
    const input = {
      jobId: "job-1",
      script: "#!/bin/sh\nprintf '%s\\n' \"$1\"\n",
      args: ["alpha", "two words", "line\nbreak"],
      manifest: { readPaths: ["/var/tmp/input", "/opt/tools"] },
    };

    const ref = writeHostJobAuditArtifact(mcHome, input);
    const bytes = readFileSync(ref.path);

    expect(ref.path).toBe(join(hostJobAuditArtifactDir(mcHome), "job-1.json"));
    expect(bytes).toEqual(serializeHostJobAuditArtifact(input));
    expect(JSON.parse(bytes.toString("utf-8"))).toEqual({
      version: 1,
      ...input,
    });
    expect(ref.sha256).toBe(sha256Hex(bytes));
  });

  it("rejects mutation of an existing artifact path", () => {
    const input = {
      jobId: "job-1",
      script: "echo first\n",
      args: [],
      manifest: { readPaths: [] },
    };
    writeHostJobAuditArtifact(mcHome, input);

    expect(() =>
      writeHostJobAuditArtifact(mcHome, {
        ...input,
        script: "echo mutated\n",
      })
    ).toThrow(/EEXIST|file already exists/i);
  });
});
