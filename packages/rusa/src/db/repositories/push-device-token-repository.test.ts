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

  it("normalizes a principal's repeated token registration", () => {
    tokens.register(one, " token-a ");
    const refreshed = tokens.register(one, "token-a");

    expect(refreshed).toEqual({
      token: "token-a",
      principalId: one,
    });
  });

  it("moves a refreshed device token to its newly authenticated principal", () => {
    tokens.register(one, "token-a");
    tokens.register(two, "token-a");

    expect(tokens.listForPrincipal(one)).toEqual([]);
    expect(tokens.listForPrincipal(two)).toEqual([
      {
        token: "token-a",
        principalId: two,
      },
    ]);
  });

  it("cannot revoke another principal's token", () => {
    tokens.register(one, "token-a");

    expect(tokens.revoke(two, "token-a")).toBe(false);
    expect(tokens.listForPrincipal(one)).toHaveLength(1);
    expect(tokens.revoke(one, "token-a")).toBe(true);
    expect(tokens.listForPrincipal(one)).toEqual([]);
  });

  it("removes an invalid token independently of its principal", () => {
    tokens.register(one, "token-a");
    expect(tokens.remove("token-a")).toBe(true);
    expect(tokens.remove("token-a")).toBe(false);
  });
});
