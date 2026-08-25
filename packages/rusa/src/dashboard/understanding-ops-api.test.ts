import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyOp } from "@thkp-eng/goals-types";
import { compressOp } from "@thkp-eng/goals-types";
import { describe, expect, it } from "vitest";
import {
  handleUnderstandingOpsRequest,
  handleUnderstandingStringsRequest,
  type UnderstandingOpsDeps,
} from "./understanding-ops-api.js";

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
// A minimal-but-real delta op so `compressOp` (which the handler applies) round-trips it.
const op = (id: string, hlc: string): AnyOp =>
  ({
    id,
    hlcTimestamp: hlc,
    version: 6,
    type: "delta",
    delta: { id: `g-${id}`, text: id },
  }) as unknown as AnyOp;

/** A fake load that records the opts it was called with. */
function fakeLoad(
  result: { ops: AnyOp[]; cursor: string | null },
  rootNodeId?: string | null
): {
  deps: UnderstandingOpsDeps;
  seen: () => { cursor?: string | null; limit?: number } | undefined;
} {
  let seen: { cursor?: string | null; limit?: number } | undefined;
  return {
    deps: {
      load: async (opts) => {
        seen = opts;
        return result;
      },
      rootNodeId,
    },
    seen: () => seen,
  };
}

describe("understanding ops-getter (ISSUE_NUM 2b calibration view server)", () => {
  it("GET returns the local ops + nextCursor and forwards cursor/limit to load", async () => {
    const ops = [op("a", "h1"), op("b", "h2")];
    const { deps, seen } = fakeLoad({ ops, cursor: "h2" }, "rootX");
    const r = fakeRes();
    const handled = await handleUnderstandingOpsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/understanding/ops?cursor=h0&limit=50"),
      deps
    );
    expect(handled).toBe(true);
    expect(r.status()).toBe(200);
    // The handler serves the COMPACT wire form (compressOp) the browser view parses —
    // not the expanded in-memory ops it loaded — plus the canonical rootNodeId to anchor on.
    expect(r.json()).toEqual({
      ops: ops.map((o) => compressOp(o)),
      nextCursor: "h2",
      rootNodeId: "rootX",
    });
    expect(seen()).toEqual({ cursor: "h0", limit: 50 });
  });

  it("rootNodeId defaults to null when unconfigured", async () => {
    const { deps } = fakeLoad({ ops: [], cursor: null }); // no rootNodeId
    const r = fakeRes();
    await handleUnderstandingOpsRequest(fakeReq("GET"), r.res, u("/api/understanding/ops"), deps);
    expect((r.json() as { rootNodeId: unknown }).rootNodeId).toBeNull();
  });

  it("no cursor → null cursor; bad/oversized limit → clamped default", async () => {
    const { deps, seen } = fakeLoad({ ops: [], cursor: null });
    const r = fakeRes();
    await handleUnderstandingOpsRequest(fakeReq("GET"), r.res, u("/api/understanding/ops"), deps);
    expect(seen()).toEqual({ cursor: null, limit: 500 }); // default

    const big = fakeLoad({ ops: [], cursor: null });
    await handleUnderstandingOpsRequest(
      fakeReq("GET"),
      fakeRes().res,
      u("/api/understanding/ops?limit=999999"),
      big.deps
    );
    expect(big.seen()?.limit).toBe(2000); // clamped to MAX
  });

  it("non-GET → 405", async () => {
    const { deps } = fakeLoad({ ops: [], cursor: null });
    const r = fakeRes();
    await handleUnderstandingOpsRequest(fakeReq("POST"), r.res, u("/api/understanding/ops"), deps);
    expect(r.status()).toBe(405);
  });

  it("ignores non-matching paths (returns false)", async () => {
    const { deps } = fakeLoad({ ops: [], cursor: null });
    const r = fakeRes();
    const handled = await handleUnderstandingOpsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/mesh/threads"),
      deps
    );
    expect(handled).toBe(false);
  });

  it("a load failure → 500 (doesn't throw)", async () => {
    const deps: UnderstandingOpsDeps = {
      load: async () => {
        throw new Error("ops-log unreadable");
      },
    };
    const r = fakeRes();
    await handleUnderstandingOpsRequest(fakeReq("GET"), r.res, u("/api/understanding/ops"), deps);
    expect(r.status()).toBe(500);
  });
});

describe("understanding strings-getter (ISSUE_NUM node-body rendering)", () => {
  const opsDep: Pick<UnderstandingOpsDeps, "load"> = {
    load: async () => ({ ops: [], cursor: null }),
  };

  it("GET resolves the requested ids (deduped, trimmed) via loadStrings", async () => {
    let seen: string[] | undefined;
    const deps: UnderstandingOpsDeps = {
      ...opsDep,
      loadStrings: async (ids) => {
        seen = ids;
        return { a: "body-a", b: "body-b" };
      },
    };
    const r = fakeRes();
    const handled = await handleUnderstandingStringsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/understanding/strings?ids=a,%20b%20,a,"),
      deps
    );
    expect(handled).toBe(true);
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual({ strings: { a: "body-a", b: "body-b" } });
    expect(seen).toEqual(["a", "b"]); // deduped + trimmed + empties dropped
  });

  it("empty ids → {} without calling loadStrings", async () => {
    let called = false;
    const deps: UnderstandingOpsDeps = {
      ...opsDep,
      loadStrings: async () => {
        called = true;
        return {};
      },
    };
    const r = fakeRes();
    await handleUnderstandingStringsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/understanding/strings"),
      deps
    );
    expect(r.json()).toEqual({ strings: {} });
    expect(called).toBe(false);
  });

  it("no loadStrings dep wired → {} (renders blank, never errors)", async () => {
    const r = fakeRes();
    await handleUnderstandingStringsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/understanding/strings?ids=a"),
      opsDep as UnderstandingOpsDeps
    );
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual({ strings: {} });
  });

  it("non-GET → 405", async () => {
    const r = fakeRes();
    await handleUnderstandingStringsRequest(
      fakeReq("POST"),
      r.res,
      u("/api/understanding/strings?ids=a"),
      opsDep as UnderstandingOpsDeps
    );
    expect(r.status()).toBe(405);
  });

  it("ignores non-matching paths (returns false)", async () => {
    const r = fakeRes();
    const handled = await handleUnderstandingStringsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/understanding/ops"),
      opsDep as UnderstandingOpsDeps
    );
    expect(handled).toBe(false);
  });

  it("a loadStrings failure → 500 (doesn't throw / blank the view globally)", async () => {
    const deps: UnderstandingOpsDeps = {
      ...opsDep,
      loadStrings: async () => {
        throw new Error("firestore unreachable");
      },
    };
    const r = fakeRes();
    await handleUnderstandingStringsRequest(
      fakeReq("GET"),
      r.res,
      u("/api/understanding/strings?ids=a"),
      deps
    );
    expect(r.status()).toBe(500);
  });
});
