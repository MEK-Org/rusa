import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostJobManifest } from "./host-job-store.js";

export interface HostJobAuditArtifactInput {
  jobId: string;
  script: string;
  args: string[];
  manifest: HostJobManifest;
}

export interface HostJobAuditArtifactRef {
  path: string;
  sha256: string;
}

export function hostJobAuditArtifactDir(mcHome: string): string {
  return join(mcHome, "host-jobs", "audit");
}

export function serializeHostJobAuditArtifact(input: HostJobAuditArtifactInput): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        jobId: input.jobId,
        script: input.script,
        args: input.args,
        manifest: input.manifest,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function writeHostJobAuditArtifact(
  mcHome: string,
  input: HostJobAuditArtifactInput
): HostJobAuditArtifactRef {
  const dir = hostJobAuditArtifactDir(mcHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${input.jobId}.json`);
  const bytes = serializeHostJobAuditArtifact(input);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, sha256: sha256Hex(bytes) };
}
