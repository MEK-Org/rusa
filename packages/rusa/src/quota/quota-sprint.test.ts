import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot, QuotaLimit, QuotaWindowKind } from "../mcp/quota-mcp.js";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import {
  COORDINATOR_PROTOCOL_MINOR,
  MANUAL_QUOTA_OBSERVATION_PATH,
  QUOTA_READING_MODE_PATH,
  QUOTA_SPRINT_PATH,
  QUOTA_SPRINT_PROTOCOL_MINOR,
} from "./coordinator-protocol.js";
import { QuotaCoordinatorService } from "./coordinator-service.js";
import { QUOTA_KI_SECONDS_PER_POINT_SECOND, SharedQuotaStore } from "./shared-store.js";

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  // biome-ignore lint/suspicious/noExplicitAny: test response payload
  json: any;
}

function makeRequest(
  socketPath: string,
  path: string,
  method = "GET",
  body?: string,
  headers?: http.OutgoingHttpHeaders
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let json: TestResponse["json"] = {};
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RESET = "2030-01-08T00:00:00.000Z";
const NEXT_RESET = "2030-01-15T00:00:00.000Z";
const T0 = Date.parse("2030-01-03T00:00:00.000Z");
const EXPIRES = "2030-01-05T00:00:00Z";
const MAX_INTERVAL = 600;
const FABLE = "claude-fable-5-1";

interface Reading {
  kind: QuotaWindowKind;
  percentLeft: number;
  resetAtIso: string | null;
  scope?: QuotaLimit["scope"];
}

function weekly(percentLeft: number, resetAtIso: string | null = RESET): Reading {
  return { kind: "weekly", percentLeft, resetAtIso };
}

/** A session window comfortably ahead of pace: a reasoned row commanding zero. */
function session(atMs: number, percentLeft = 95): Reading {
  return { kind: "session", percentLeft, resetAtIso: new Date(atMs + 4 * HOUR).toISOString() };
}

function scrape(store: SharedQuotaStore, atMs: number, readings: Reading[]): void {
  const scrapedAt = new Date(atMs).toISOString();
  const state: ProviderQuotaSnapshot = {
    provider: "claude",
    status: readings.some((reading) => reading.percentLeft <= 0) ? "exhausted" : "available",
    scrapedAt,
    limits: readings.map((reading) => ({
      label: `${reading.kind} limit`,
      kind: reading.kind,
      scope: reading.scope ?? "provider",
      percentLeft: reading.percentLeft,
      resetAtIso: reading.resetAtIso ?? undefined,
    })),
  };
  const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" });
  store.recordParsed(id, state, state);
}

/** Wording that would read as an inventory of resets the operator holds (root condition 4). */
const RESET_INVENTORY =
  /inventory|redeem|redemption|resets? (left|remaining|available)|available resets|reset availability/i;

const roots: string[] = [];
const services: QuotaCoordinatorService[] = [];
const stores: SharedQuotaStore[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(path: string): SharedQuotaStore {
  const store = new SharedQuotaStore(path);
  store.configureController({ maxIntervalSeconds: MAX_INTERVAL });
  stores.push(store);
  return store;
}

async function harness(opts: { bootId?: string; dbPath?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rusa-quota-sprint-"));
  roots.push(root);
  const dbPath = opts.dbPath ?? join(root, "quota.db");
  const socketPath = join(root, "coordinator.sock");
  const store = openStore(dbPath);
  const clock = { nowMs: T0 + MINUTE };
  const bootId = opts.bootId ?? "boot-1";
  const service = new QuotaCoordinatorService({
    socketPath,
    store,
    configuredProviders: ["claude", "codex"],
    maxIntervalSeconds: MAX_INTERVAL,
    now: () => clock.nowMs,
    bootId,
  });
  services.push(service);
  await service.start();

  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers?: http.OutgoingHttpHeaders
  ) =>
    makeRequest(
      socketPath,
      path,
      method,
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      headers
    );
  const status = async () => {
    const res = await request(`${QUOTA_SPRINT_PATH}?provider=claude`);
    expect(res.status).toBe(200);
    expect(res.body).not.toMatch(RESET_INVENTORY);
    return res.json;
  };
  const throttle = async () => {
    const res = await request("/v1/throttle?provider=claude");
    expect(res.status).toBe(200);
    return res.json;
  };
  const armBody = async (overrides: Record<string, unknown> = {}) => {
    const current = await status();
    return {
      action: "arm",
      provider: "claude",
      bootId: current.boot.id,
      revision: current.revision,
      bucket: "claude:weekly",
      cycleAnchor: RESET,
      generation: current.readingMode.generation,
      requestId: "arm-1",
      expiresAt: EXPIRES,
      confirmResetUsable: true,
      ...overrides,
    };
  };
  const post = (body: unknown) => request(QUOTA_SPRINT_PATH, "POST", body);
  const arm = async (overrides: Record<string, unknown> = {}) => post(await armBody(overrides));
  const cancel = async (armId: string, overrides: Record<string, unknown> = {}) => {
    const current = await status();
    return post({
      action: "cancel",
      provider: "claude",
      bootId: current.boot.id,
      revision: current.revision,
      armId,
      ...overrides,
    });
  };
  return {
    root,
    dbPath,
    socketPath,
    store,
    clock,
    service,
    request,
    status,
    throttle,
    armBody,
    post,
    arm,
    cancel,
  };
}

/** Two readings an hour apart, burning well ahead of the even spread. */
function seedBehindPace(store: SharedQuotaStore): void {
  scrape(store, T0 - HOUR, [weekly(60), session(T0 - HOUR)]);
  scrape(store, T0, [weekly(58), session(T0)]);
}

describe("quota sprint: status, arm and cancel (#861)", () => {
  it("states plainly that this boot holds no policy and that an earlier boot's was lost", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const status = await h.status();
    expect(status).toMatchObject({
      provider: "claude",
      boot: { id: "boot-1", startedAt: new Date(T0 + MINUTE).toISOString() },
      revision: 0,
      readingMode: { mode: "scrape", generation: 0 },
      policy: null,
      lastEnded: null,
      buckets: [
        {
          key: "claude:weekly",
          models: [],
          latest: { observedAt: new Date(T0).toISOString(), percentLeft: 58, resetAtIso: RESET },
          cycleAnchor: RESET,
          freshness: { stale: false, hardStale: false },
        },
      ],
    });
    expect(status.service.protocolMinor).toBe(COORDINATOR_PROTOCOL_MINOR);
    expect(COORDINATOR_PROTOCOL_MINOR).toBe(QUOTA_SPRINT_PROTOCOL_MINOR);
    expect(status.notes).toHaveLength(1);
    expect(status.notes[0]).toContain("No sprint is armed for claude in coordinator boot boot-1");
    expect(status.notes[0]).toContain("any sprint armed before this boot was disarmed");
    expect(status.pacing.ordinary.intervalSeconds).toBeGreaterThan(0);
    expect(status.pacing.effective).toEqual(status.pacing.ordinary);
  });

  it("arms one weekly bucket: old readers get the effective interval, the sprint block the ordinary", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const before = await h.throttle();
    expect(before.governingBucketKey).toBe("claude:weekly");
    expect(before.intervalSeconds).toBeGreaterThan(0);
    expect(before.sprint).toBeUndefined();

    const armed = await h.arm();
    expect(armed.status).toBe(200);
    expect(armed.json).toMatchObject({
      action: "arm",
      duplicate: false,
      revision: 1,
      boot: { id: "boot-1" },
      lastEnded: null,
      policy: {
        requestId: "arm-1",
        bucketKey: "claude:weekly",
        models: [],
        readingModeGeneration: 0,
        cycleAnchor: { resetAtIso: RESET, observedAt: new Date(T0).toISOString(), percentLeft: 58 },
        expiresAt: "2030-01-05T00:00:00.000Z",
        state: "active",
      },
    });

    const during = await h.throttle();
    // The weekly delay leaves the election; the session window still binds.
    expect(during.intervalSeconds).toBe(0);
    expect(during.governingBucketKey).toBe("claude:session");
    expect(during.sprint).toMatchObject({
      armId: armed.json.policy.armId,
      bucketKey: "claude:weekly",
      state: "active",
      ordinary: {
        intervalSeconds: before.intervalSeconds,
        governingBucketKey: "claude:weekly",
      },
    });
    // The stored buckets are untouched: the relaxation is an election input only.
    expect(during.buckets).toEqual(before.buckets);

    // A reader that predates the sprint minor applies the effective interval.
    const oldReader = new QuotaCoordinatorClient({
      socketPath: h.socketPath,
      maxIntervalSeconds: MAX_INTERVAL,
    });
    expect(oldReader.applyResponse("claude", during)).toBe(true);
    expect(oldReader.getLastAppliedInterval("claude")).toBe(0);

    const collection = await h.request("/v1/throttle");
    expect(collection.json.providers.claude.intervalSeconds).toBe(0);
    expect(collection.json.providers.claude.sprint.armId).toBe(armed.json.policy.armId);

    const status = await h.status();
    expect(status.pacing.effective.intervalSeconds).toBe(0);
    expect(status.pacing.ordinary.intervalSeconds).toBe(before.intervalSeconds);
    expect(status.notes).toEqual([]);
  });

  it("replays a lost-response retry, refuses a changed retry, a stale revision and a second arm", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const body = await h.armBody();
    const first = await h.post(body);
    expect(first.status).toBe(200);

    // The response was lost; the operator retries the identical request.
    const retry = await h.post(body);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ duplicate: true, revision: 1 });
    expect(retry.json.policy.armId).toBe(first.json.policy.armId);

    const changed = await h.post({ ...body, expiresAt: "2030-01-04T00:00:00Z" });
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe("idempotency_conflict");

    const staleRevision = await h.post({ ...body, requestId: "arm-2" });
    expect(staleRevision.status).toBe(409);
    expect(staleRevision.json.error.code).toBe("sprint_revision_conflict");

    const second = await h.arm({ requestId: "arm-2" });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("sprint_already_armed");
    expect((await h.status()).revision).toBe(1);
  });

  it("refuses unusable preconditions without arming", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ bootId: "boot-0" }, "sprint_boot_mismatch"],
      [{ bucket: "claude:session" }, "sprint_bucket_unknown"],
      [{ bucket: "claude[other]:weekly" }, "sprint_bucket_unknown"],
      [{ cycleAnchor: "2030-01-08T01:00:00.000Z" }, "sprint_cycle_mismatch"],
      [{ generation: 1 }, "mode_generation_mismatch"],
      [{ expiresAt: "2030-01-02T00:00:00Z" }, "sprint_expiry_invalid"],
      [{ expiresAt: "2030-01-08T00:00:01Z" }, "sprint_expiry_invalid"],
    ];
    for (const [overrides, code] of refusals) {
      const res = await h.arm(overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(409);
      expect(res.json.error.code, JSON.stringify(overrides)).toBe(code);
    }
    expect(await h.status()).toMatchObject({ revision: 0, policy: null });

    // The refused earlier-boot request is recorded plainly.
    const notes: string[] = (await h.status()).notes;
    expect(notes.some((note) => note.includes("earlier coordinator boot boot-0 was refused"))).toBe(
      true
    );

    // Evidence the arm must not trust: stale, then exhausted, then no future reset.
    h.clock.nowMs = T0 + 46 * MINUTE;
    expect((await h.arm()).json.error.code).toBe("sprint_evidence_unusable");
    h.clock.nowMs = T0 + 61 * MINUTE;
    scrape(h.store, T0 + 60 * MINUTE, [weekly(0), session(T0 + 60 * MINUTE)]);
    expect((await h.arm()).json.error.code).toBe("sprint_evidence_unusable");
    h.clock.nowMs = T0 + 121 * MINUTE;
    scrape(h.store, T0 + 120 * MINUTE, [weekly(40, null), session(T0 + 120 * MINUTE)]);
    expect((await h.arm()).json.error.code).toBe("sprint_evidence_unusable");
    expect((await h.status()).policy).toBeNull();
  });

  it("gates method, body shape, provider and socket permissions", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    expect(statSync(h.socketPath).mode & 0o777).toBe(0o600);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await h.request(QUOTA_SPRINT_PATH, method);
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET, POST");
    }
    expect((await h.request(`${QUOTA_SPRINT_PATH}?provider=nope`)).status).toBe(404);
    expect((await h.request(QUOTA_SPRINT_PATH, "POST", "{not json")).status).toBe(400);
    expect((await h.request(QUOTA_SPRINT_PATH, "POST", [])).status).toBe(400);
    expect((await h.arm({ provider: "nope" })).status).toBe(404);
    const malformed: Record<string, unknown>[] = [
      { action: "disarm" },
      { bootId: "" },
      { revision: -1 },
      { revision: 1.5 },
      { requestId: "has space" },
      { requestId: "x".repeat(129) },
      { bucket: "" },
      { cycleAnchor: "soon" },
      { generation: "0" },
      { expiresAt: "2030-01-05T00:00:00+02:00" },
      { expiresAt: "2030-01-05" },
      { confirmResetUsable: false },
      { confirmResetUsable: undefined },
    ];
    for (const overrides of malformed) {
      const res = await h.arm(overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(res.json.error.code).toBe("invalid_request");
    }
    expect((await h.cancel("not an id!")).status).toBe(400);
    expect((await h.status()).revision).toBe(0);
  });

  it("keeps state bounded: an old arm's cancel is a no-op, an older one is refused", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const first = await h.arm({ requestId: "arm-a" });
    const a = first.json.policy.armId;
    expect((await h.cancel(a)).json).toMatchObject({
      duplicate: false,
      policy: null,
      lastEnded: { armId: a, reason: "cancelled" },
    });
    // A lost cancel response, retried: nothing to undo.
    expect((await h.cancel(a)).json).toMatchObject({ duplicate: true, revision: 2 });

    const second = await h.arm({ requestId: "arm-b" });
    const b = second.json.policy.armId;
    expect(second.json.revision).toBe(3);
    // The old arm's cancel never touches the new one.
    const oldCancel = await h.cancel(a);
    expect(oldCancel.json).toMatchObject({ duplicate: true, policy: { armId: b } });
    expect((await h.cancel(b)).json.lastEnded).toMatchObject({ armId: b, reason: "cancelled" });

    // Only the current and latest ended arm are retained.
    const evicted = await h.cancel(a);
    expect(evicted.status).toBe(409);
    expect(evicted.json.error.code).toBe("sprint_arm_not_current");
    const replay = await h.arm({ requestId: "arm-a", revision: 0 });
    expect(replay.status).toBe(409);
    expect(replay.json.error.code).toBe("sprint_revision_conflict");
    const cancelWithStaleRevision = await h.arm({ requestId: "arm-c" });
    const c = cancelWithStaleRevision.json.policy.armId;
    const stale = await h.cancel(c, { revision: 4 });
    expect(stale.json.error.code).toBe("sprint_revision_conflict");
  });
});

describe("quota sprint: ending and suspension (#861)", () => {
  it("cancel publishes the ordinary decision for the same cycle", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const ordinary = await h.throttle();
    const armed = await h.arm();
    h.clock.nowMs = T0 + 30 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [weekly(57.5), session(T0 + 30 * MINUTE)]);
    const during = await h.throttle();
    expect(during.intervalSeconds).toBe(0);

    const cancelled = await h.cancel(armed.json.policy.armId);
    expect(cancelled.json.lastEnded).toMatchObject({
      reason: "cancelled",
      endedAt: new Date(T0 + 30 * MINUTE).toISOString(),
    });
    const after = await h.throttle();
    expect(after.sprint).toBeUndefined();
    expect(after.intervalSeconds).toBe(during.sprint.ordinary.intervalSeconds);
    expect(after.intervalSeconds).toBe(h.store.getProviderThrottle("claude")?.intervalSeconds);
    expect(after.governingBucketKey).toBe("claude:weekly");
    expect(ordinary.intervalSeconds).toBeGreaterThan(0);
    const status = await h.status();
    expect(status.lastEnded.message).toContain("same cycle");
  });

  it("expiry ends the arm at its own instant, even when no reading arrives after it", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    await h.arm({ expiresAt: "2030-01-03T00:30:00Z" });
    h.clock.nowMs = T0 + 20 * MINUTE;
    expect((await h.throttle()).intervalSeconds).toBe(0);
    h.clock.nowMs = T0 + 30 * MINUTE;
    const after = await h.throttle();
    expect(after.sprint).toBeUndefined();
    expect(after.intervalSeconds).toBe(h.store.getProviderThrottle("claude")?.intervalSeconds);
    expect(after.intervalSeconds).toBeGreaterThan(0);
    expect((await h.status()).lastEnded).toMatchObject({
      reason: "expired",
      endedAt: "2030-01-03T00:30:00.000Z",
    });
  });

  it("suspends on stale target evidence without moving expiry, and resumes on a fresh reading", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const armed = await h.arm();
    h.clock.nowMs = T0 + 50 * MINUTE;
    const suspended = await h.throttle();
    expect(suspended.sprint).toMatchObject({
      state: "suspended_stale",
      expiresAt: armed.json.policy.expiresAt,
    });
    expect(suspended.intervalSeconds).toBe(suspended.sprint.ordinary.intervalSeconds);
    expect(suspended.intervalSeconds).toBeGreaterThan(0);
    const status = await h.status();
    expect(status.policy).toMatchObject({
      state: "suspended_stale",
      expiresAt: EXPIRES.replace("Z", ".000Z"),
    });
    expect(status.notes.join(" ")).toContain("expiry does not move");

    scrape(h.store, T0 + 55 * MINUTE, [weekly(57.6), session(T0 + 55 * MINUTE)]);
    h.clock.nowMs = T0 + 56 * MINUTE;
    const resumed = await h.throttle();
    expect(resumed.sprint.state).toBe("active");
    expect(resumed.intervalSeconds).toBe(0);
    expect(resumed.sprint.expiresAt).toBe(armed.json.policy.expiresAt);
  });

  it("an exhausted target ends the arm; the exhaustion gate stays until an actual reading shows headroom", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    await h.arm();
    h.clock.nowMs = T0 + 31 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [weekly(0), session(T0 + 30 * MINUTE)]);
    const after = await h.throttle();
    expect(after.sprint).toBeUndefined();
    expect(after.exhaustedUntil).toBe(RESET);
    const status = await h.status();
    expect(status.lastEnded).toMatchObject({
      reason: "exhausted",
      endedAt: new Date(T0 + 30 * MINUTE).toISOString(),
    });
    // An operator's word that a reset was redeemed is not evidence: no route
    // takes it, and re-arming against the exhausted reading is refused.
    expect((await h.arm({ requestId: "arm-2" })).json.error.code).toBe("sprint_evidence_unusable");
    expect((await h.throttle()).exhaustedUntil).toBe(RESET);

    // Only a fresh actual reading with headroom lifts the gate.
    h.clock.nowMs = T0 + 41 * MINUTE;
    scrape(h.store, T0 + 40 * MINUTE, [weekly(100, NEXT_RESET), session(T0 + 40 * MINUTE)]);
    const refilled = await h.throttle();
    expect(refilled.exhaustedUntil).toBeNull();
    expect(refilled.intervalSeconds).toBe(0);
  });

  it("a verified refill consumes the arm and the new cycle starts from a zero actuator", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    await h.arm();
    h.clock.nowMs = T0 + 31 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [weekly(100, NEXT_RESET), session(T0 + 30 * MINUTE)]);
    const status = await h.status();
    expect(status.policy).toBeNull();
    expect(status.lastEnded).toMatchObject({ reason: "new_cycle" });
    const after = await h.throttle();
    expect(after.sprint).toBeUndefined();
    expect(after.intervalSeconds).toBe(0);
    // Readings of the new cycle pace it ordinarily from zero.
    expect((await h.arm({ requestId: "arm-2" })).json.error.code).toBe("sprint_cycle_mismatch");
  });

  it("a moved deadline alone only invalidates the arm and keeps the controller's period", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const ordinary = (await h.throttle()).intervalSeconds;
    await h.arm();
    h.clock.nowMs = T0 + 31 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [
      weekly(57.5, "2030-01-08T03:00:00.000Z"),
      session(T0 + 30 * MINUTE),
    ]);
    expect((await h.status()).lastEnded).toMatchObject({ reason: "deadline_moved" });
    const after = await h.throttle();
    expect(after.sprint).toBeUndefined();
    expect(after.governingBucketKey).toBe("claude:weekly");
    // Not a verified cycle: the actuator resumes from its prior period.
    expect(after.intervalSeconds).toBeGreaterThan(0);
    expect(Math.abs(after.intervalSeconds - ordinary)).toBeLessThan(ordinary);
  });

  it("a reading with no usable deadline ends the arm as ambiguous", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    await h.arm();
    h.clock.nowMs = T0 + 31 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [weekly(57.5, null), session(T0 + 30 * MINUTE)]);
    expect((await h.status()).lastEnded).toMatchObject({ reason: "cycle_ambiguous" });
  });

  it("another window's exhaustion keeps binding while the weekly sprint is active", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    await h.arm();
    h.clock.nowMs = T0 + 31 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [weekly(57.5), session(T0 + 30 * MINUTE, 0)]);
    const during = await h.throttle();
    expect(during.sprint.state).toBe("active");
    expect(during.exhaustedUntil).toBe(new Date(T0 + 30 * MINUTE + 4 * HOUR).toISOString());
  });

  it("a reading-mode generation change disarms and ordinary pacing resumes on the next accepted reading", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    await h.arm();
    expect((await h.throttle()).intervalSeconds).toBe(0);

    const switched = await h.request(QUOTA_READING_MODE_PATH, "POST", {
      provider: "claude",
      mode: "manual",
    });
    expect(switched.json.generation).toBe(1);
    const status = await h.status();
    expect(status.policy).toBeNull();
    expect(status.lastEnded).toMatchObject({ reason: "reading_mode_changed" });
    expect((await h.throttle()).sprint).toBeUndefined();
    // Re-arming against the old generation is refused.
    expect((await h.arm({ requestId: "arm-2", generation: 0 })).json.error.code).toBe(
      "mode_generation_mismatch"
    );

    const observedAt = new Date(T0 + 30 * MINUTE).toISOString();
    h.clock.nowMs = T0 + 31 * MINUTE;
    const accepted = await h.request(
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      {
        provider: "claude",
        generation: 1,
        observation: {
          provider: "claude",
          status: "available",
          scrapedAt: observedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 57,
              resetAtIso: RESET,
              scope: { provider: "claude" },
            },
          ],
        },
      },
      { "Idempotency-Key": "manual-1" }
    );
    expect(accepted.status).toBe(200);
    const resumed = await h.throttle();
    expect(resumed.sprint).toBeUndefined();
    expect(resumed.updatedAt).toBe(observedAt);
    expect(resumed.governingBucketKey).toBe("claude:weekly");
    expect(resumed.intervalSeconds).toBeGreaterThan(0);
    expect(resumed.intervalSeconds).toBe(h.store.getProviderThrottle("claude")?.intervalSeconds);
  });

  it("a coordinator restart disarms, and status says so plainly", async () => {
    const h = await harness();
    seedBehindPace(h.store);
    const armed = await h.arm();
    expect((await h.throttle()).intervalSeconds).toBe(0);
    await h.service.stop();
    services.splice(services.indexOf(h.service), 1);

    const restarted = await harness({ bootId: "boot-2", dbPath: h.dbPath });
    const throttle = await restarted.throttle();
    expect(throttle.sprint).toBeUndefined();
    expect(throttle.intervalSeconds).toBeGreaterThan(0);
    const cancel = await restarted.post({
      action: "cancel",
      provider: "claude",
      bootId: "boot-1",
      revision: armed.json.revision,
      armId: armed.json.policy.armId,
    });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error.code).toBe("sprint_boot_mismatch");
    const status = await restarted.status();
    expect(status).toMatchObject({
      boot: { id: "boot-2" },
      revision: 0,
      policy: null,
      lastEnded: null,
    });
    expect(status.notes[0]).toContain("No sprint is armed for claude in coordinator boot boot-2");
    expect(status.notes[0]).toContain("will not resume");
    expect(status.notes[1]).toContain("earlier coordinator boot boot-1 was refused");
    expect(status.notes[1]).toContain("lost when this boot started");
  });
});

describe("quota sprint: the ordinary controller is untouched (#861)", () => {
  it("a prolonged sprint then cancel publishes the unsprinted decision, within clamps and bounded windup", async () => {
    const h = await harness();
    const control = openStore(join(h.root, "control.db"));
    const both = (atMs: number, readings: Reading[]) => {
      scrape(h.store, atMs, readings);
      scrape(control, atMs, readings);
    };
    both(T0 - HOUR, [weekly(60), session(T0 - HOUR)]);
    both(T0, [weekly(58), session(T0)]);
    const armed = await h.arm();

    // A day of burning far ahead of the even spread while the sprint holds.
    let percentLeft = 58;
    for (let step = 1; step <= 48; step++) {
      const atMs = T0 + step * 30 * MINUTE;
      percentLeft -= 0.75;
      both(atMs, [weekly(percentLeft), session(atMs)]);
      h.clock.nowMs = atMs + MINUTE;
      const during = await h.throttle();
      expect(during.intervalSeconds).toBe(0);
      expect(during.sprint.state).toBe("active");
      expect(during.sprint.ordinary.intervalSeconds).toBe(
        control.getProviderThrottle("claude")?.intervalSeconds
      );
    }

    const cancelled = await h.cancel(armed.json.policy.armId);
    expect(cancelled.status).toBe(200);
    const after = await h.throttle();
    const unsprinted = control.getProviderThrottle("claude");
    expect(after.intervalSeconds).toBe(unsprinted?.intervalSeconds);
    expect(after.uncappedIntervalSeconds).toBe(unsprinted?.uncappedIntervalSeconds);
    expect(after.intervalSeconds).toBeLessThanOrEqual(MAX_INTERVAL);
    expect(after.intervalSeconds).toBeGreaterThan(0);

    // The controller memory is identical row for row, and the integral never
    // carries more than the clamp's worth of area.
    const memory = (store: SharedQuotaStore) =>
      store.db
        .prepare(
          `SELECT kind, observed_at, controller_error, controller_derivative, controller_integral,
                  uncapped_interval_seconds, interval_seconds
           FROM quota_observations ORDER BY kind, observed_at`
        )
        .all() as Array<{ controller_integral: number; interval_seconds: number }>;
    expect(memory(h.store)).toEqual(memory(control));
    for (const row of memory(h.store)) {
      expect(row.interval_seconds).toBeLessThanOrEqual(MAX_INTERVAL);
      expect(QUOTA_KI_SECONDS_PER_POINT_SECOND * row.controller_integral).toBeLessThanOrEqual(
        MAX_INTERVAL
      );
    }
  });

  it("a model-scoped target relaxes only its own lane and ends if its models move", async () => {
    const h = await harness();
    const fable: QuotaLimit["scope"] = { provider: "claude", models: [FABLE] };
    const readings = (atMs: number, providerLeft: number, fableLeft: number): Reading[] => [
      weekly(providerLeft),
      { kind: "weekly", percentLeft: fableLeft, resetAtIso: RESET, scope: fable },
      session(atMs),
    ];
    scrape(h.store, T0 - HOUR, readings(T0 - HOUR, 60, 60));
    scrape(h.store, T0, readings(T0, 58, 58));
    const status = await h.status();
    const fableKey = `claude[${FABLE}]:weekly`;
    expect(status.buckets.map((bucket: { key: string }) => bucket.key).sort()).toEqual(
      ["claude:weekly", fableKey].sort()
    );
    const before = await h.throttle();
    const armed = await h.arm({ bucket: fableKey });
    expect(armed.status).toBe(200);
    expect(armed.json.policy.models).toEqual([FABLE]);

    const during = await h.throttle();
    // The provider lane still binds; only the Fable lane's weekly delay is dropped.
    expect(during.intervalSeconds).toBe(before.intervalSeconds);
    const fableLane = (throttle: {
      modelLanes: Array<{ models: string[]; intervalSeconds: number }>;
    }) => throttle.modelLanes.find((lane) => lane.models.includes(FABLE));
    expect(fableLane(before)?.intervalSeconds).toBeGreaterThan(0);
    expect(fableLane(during)?.intervalSeconds).toBe(0);
    expect(during.sprint.ordinary.intervalSeconds).toBe(fableLane(before)?.intervalSeconds);

    // The provider now reports Fable under a different model set.
    h.clock.nowMs = T0 + 31 * MINUTE;
    scrape(h.store, T0 + 30 * MINUTE, [
      weekly(57.5),
      {
        kind: "weekly",
        percentLeft: 57.5,
        resetAtIso: RESET,
        scope: { provider: "claude", models: [FABLE, "claude-fable-5-1-mini"] },
      },
      session(T0 + 30 * MINUTE),
    ]);
    expect((await h.status()).lastEnded).toMatchObject({ reason: "model_scope_changed" });
  });
});
