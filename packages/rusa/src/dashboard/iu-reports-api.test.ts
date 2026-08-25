import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleIuReportsApiRequest, type IuReportsApiDeps } from "./iu-reports-api.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mockRead = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: mockRead,
    },
    readFileSync: mockRead,
  };
});

function fakeReq(method: string): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; status: () => number; json: () => unknown } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      if (payload) body = payload;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => (body ? JSON.parse(body) : undefined) };
}

const u = (path: string): URL => new URL(`http://dash${path}`);

describe("IU reports API ", () => {
  const deps: IuReportsApiDeps = { mcHome: "/mock/home" };
  const mockReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  describe("GET /api/understanding/reports", () => {
    it("happy path: returns index.json contents", async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ v: 1, runs: [{ run_id: "r1" }] }));
      const r = fakeRes();
      const handled = await handleIuReportsApiRequest(
        fakeReq("GET"),
        r.res,
        u("/api/understanding/reports"),
        deps
      );

      expect(handled).toBe(true);
      expect(r.status()).toBe(200);
      expect(r.json()).toEqual({ v: 1, runs: [{ run_id: "r1" }] });
    });

    it("missing index.json -> empty state", async () => {
      const err = new Error("ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      mockReadFileSync.mockImplementation(() => {
        throw err;
      });

      const r = fakeRes();
      await handleIuReportsApiRequest(fakeReq("GET"), r.res, u("/api/understanding/reports"), deps);

      expect(r.status()).toBe(200);
      expect(r.json()).toEqual({ v: 1, runs: [] });
    });

    it("unsupported version gracefully degrades", async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ v: 2, runs: [{ run_id: "r1" }] }));
      const r = fakeRes();
      await handleIuReportsApiRequest(fakeReq("GET"), r.res, u("/api/understanding/reports"), deps);

      expect(r.status()).toBe(200);
      expect(r.json()).toEqual({ v: 2, runs: [], unsupportedVersion: true });
    });
  });

  describe("GET /api/understanding/reports/content", () => {
    const validIndex = JSON.stringify({
      v: 1,
      runs: [
        { run_id: "r1", reportPath: "rendered/r1.md" },
        { run_id: "r2", reportPath: "../escape.md" },
        { run_id: "r3", reportPath: "/absolute/path.md" },
      ],
    });

    it("happy path: returns markdown", async () => {
      mockReadFileSync.mockImplementation((path) => {
        if (typeof path === "string" && path.endsWith("index.json")) return validIndex;
        if (typeof path === "string" && path.endsWith("r1.md")) return "# Report 1";
        throw new Error(`Unexpected path: ${path}`);
      });

      const r = fakeRes();
      const handled = await handleIuReportsApiRequest(
        fakeReq("GET"),
        r.res,
        u("/api/understanding/reports/content?run_id=r1"),
        deps
      );

      expect(handled).toBe(true);
      expect(r.status()).toBe(200);
      expect(r.json()).toEqual({ markdown: "# Report 1" });
    });

    it("missing run_id -> 400", async () => {
      const r = fakeRes();
      await handleIuReportsApiRequest(
        fakeReq("GET"),
        r.res,
        u("/api/understanding/reports/content"),
        deps
      );
      expect(r.status()).toBe(400);
    });

    it("run not found -> 404", async () => {
      mockReadFileSync.mockReturnValue(validIndex);
      const r = fakeRes();
      await handleIuReportsApiRequest(
        fakeReq("GET"),
        r.res,
        u("/api/understanding/reports/content?run_id=nonexistent"),
        deps
      );
      expect(r.status()).toBe(404);
    });

    it("path traversal attempt rejected (..)", async () => {
      mockReadFileSync.mockReturnValue(validIndex);
      const r = fakeRes();
      await handleIuReportsApiRequest(
        fakeReq("GET"),
        r.res,
        u("/api/understanding/reports/content?run_id=r2"),
        deps
      );
      expect(r.status()).toBe(403);
    });

    it("path traversal attempt rejected (absolute)", async () => {
      mockReadFileSync.mockReturnValue(validIndex);
      const r = fakeRes();
      await handleIuReportsApiRequest(
        fakeReq("GET"),
        r.res,
        u("/api/understanding/reports/content?run_id=r3"),
        deps
      );
      expect(r.status()).toBe(403);
    });
  });
});
