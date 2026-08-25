import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSentinelPath,
  clearBuildSentinel,
  readBuildSentinel,
  verifyBuildSentinel,
  writeBuildSentinel,
} from "./build-sentinel.js";

function tmpDist(): string {
  return mkdtempSync(join(tmpdir(), "update-dist-"));
}

const SHA = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

describe("build sentinel", () => {
  it("write then read round-trips the sha", () => {
    const dist = tmpDist();
    writeBuildSentinel(dist, SHA);
    expect(readBuildSentinel(dist)).toBe(SHA);
    expect(existsSync(buildSentinelPath(dist))).toBe(true);
  });

  it("clear removes the sentinel (a crash mid-build leaves none)", () => {
    const dist = tmpDist();
    writeBuildSentinel(dist, SHA);
    clearBuildSentinel(dist);
    expect(readBuildSentinel(dist)).toBeNull();
    expect(existsSync(buildSentinelPath(dist))).toBe(false);
  });

  it("clear is idempotent on an absent sentinel", () => {
    const dist = tmpDist();
    expect(() => clearBuildSentinel(dist)).not.toThrow();
  });
});

describe("verifyBuildSentinel — the partial-build-never-ships gate", () => {
  it("ok only when the sentinel matches HEAD", () => {
    const dist = tmpDist();
    writeBuildSentinel(dist, SHA);
    expect(verifyBuildSentinel(dist, SHA).ok).toBe(true);
  });

  it("FAILS when no sentinel (interrupted build) — boot refused", () => {
    const dist = tmpDist();
    clearBuildSentinel(dist); // simulate: build cleared it, then was SIGTERM'd
    const res = verifyBuildSentinel(dist, SHA);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/interrupted|missing/);
  });

  it("FAILS on a stale sentinel (dist built for a different sha)", () => {
    const dist = tmpDist();
    writeBuildSentinel(dist, OTHER);
    const res = verifyBuildSentinel(dist, SHA);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/!=/);
  });
});
