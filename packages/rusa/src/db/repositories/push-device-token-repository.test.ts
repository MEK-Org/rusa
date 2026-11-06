import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { PrincipalRepository } from "./principal-repository.js";
import { PushDeviceTokenRepository } from "./push-device-token-repository.js";

describe("PushDeviceTokenRepository", () => {
  let db: Database.Database;
  let principals: PrincipalRepository;
  let tokens: PushDeviceTokenRepository;
  let one: string;
  let two: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    principals = new PrincipalRepository(db);
    tokens = new PushDeviceTokenRepository(db);
    one = principals.createUser({
      email: "one@example.test",
      createdAt: "2026-11-06T00:00:00.000Z",
    }).id;
    two = principals.createUser({
      email: "two@example.test",
      createdAt: "2026-11-06T00:00:00.000Z",
    }).id;
  });

  it("refreshes a principal's token without changing its original registration", () => {
    tokens.register(one, " token-a ", "2026-11-06T01:00:00.000Z");
    const refreshed = tokens.register(one, "token-a", "2026-11-06T02:00:00.000Z");

    expect(refreshed).toEqual({
      token: "token-a",
      principalId: one,
      registeredAt: "2026-11-06T01:00:00.000Z",
      refreshedAt: "2026-11-06T02:00:00.000Z",
    });
  });

  it("moves a refreshed device token to its newly authenticated principal", () => {
    tokens.register(one, "token-a", "2026-11-06T01:00:00.000Z");
    tokens.register(two, "token-a", "2026-11-06T02:00:00.000Z");

    expect(tokens.listForPrincipal(one)).toEqual([]);
    expect(tokens.listForPrincipal(two)).toEqual([
      {
        token: "token-a",
        principalId: two,
        registeredAt: "2026-11-06T02:00:00.000Z",
        refreshedAt: "2026-11-06T02:00:00.000Z",
      },
    ]);
  });

  it("cannot revoke another principal's token", () => {
    tokens.register(one, "token-a", "2026-11-06T01:00:00.000Z");

    expect(tokens.revoke(two, "token-a")).toBe(false);
    expect(tokens.listForPrincipal(one)).toHaveLength(1);
    expect(tokens.revoke(one, "token-a")).toBe(true);
    expect(tokens.listForPrincipal(one)).toEqual([]);
  });

  it("removes an invalid token independently of its principal", () => {
    tokens.register(one, "token-a", "2026-11-06T01:00:00.000Z");
    expect(tokens.remove("token-a")).toBe(true);
    expect(tokens.remove("token-a")).toBe(false);
  });
});
