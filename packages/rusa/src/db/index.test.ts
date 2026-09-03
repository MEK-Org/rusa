import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTimestampAsUtcMillis } from "./index.js";

describe("parseTimestampAsUtcMillis", () => {
  it("parses integer seconds correctly without trailing Z", () => {
    const input = "2026-07-04 03:00:58";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("parses integer seconds correctly with trailing Z", () => {
    const input = "2026-07-04 03:00:58Z";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("parses fractional seconds correctly without trailing Z", () => {
    const input = "2026-07-04 03:00:58.338";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58, 338);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("parses fractional seconds correctly with trailing Z", () => {
    const input = "2026-07-04 03:00:58.338Z";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58, 338);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("handles America/Los_Angeles timezone offset without shifting parsed epoch-millis", () => {
    const oldTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const input = "2026-07-04 03:00:58.338";
      const expected = Date.UTC(2026, 6, 4, 3, 0, 58, 338);
      const parsed = parseTimestampAsUtcMillis(input);
      expect(parsed).toBe(expected);
    } finally {
      process.env.TZ = oldTz;
    }
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { closeDb, initDb } from "./index.js";

describe("initDb legacy transition", () => {
  let tmpHome: string;
  let dataDir: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "rusa-test-"));
    dataDir = join(tmpHome, "data");
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("handles fresh installs correctly", () => {
    initDb(tmpHome);
    expect(existsSync(join(dataDir, "mesh.db"))).toBe(true);
    expect(existsSync(join(dataDir, "rusa.db"))).toBe(false);
  });

  it("transitions legacy main only", () => {
    mkdirSync(dataDir, { recursive: true });
    const legacyDbPath = join(dataDir, "rusa.db");
    const db = new Database(legacyDbPath);
    db.close();

    initDb(tmpHome);

    expect(existsSync(join(dataDir, "mesh.db"))).toBe(true);
    expect(existsSync(legacyDbPath)).toBe(false);
  });

  it("transitions legacy main with live WAL/SHM", () => {
    mkdirSync(dataDir, { recursive: true });
    const legacyDbPath = join(dataDir, "rusa.db");
    const db = new Database(legacyDbPath);
    db.pragma("journal_mode = WAL");
    db.close();

    writeFileSync(legacyDbPath + "-wal", "fake wal");
    writeFileSync(legacyDbPath + "-shm", "fake shm");

    initDb(tmpHome);

    expect(existsSync(join(dataDir, "mesh.db"))).toBe(true);
    expect(existsSync(join(dataDir, "mesh.db-wal"))).toBe(true);
  });

  it("both-main collision", () => {
    mkdirSync(dataDir, { recursive: true });
    const legacyDbPath = join(dataDir, "rusa.db");
    const meshDbPath = join(dataDir, "mesh.db");

    new Database(legacyDbPath).close();
    new Database(meshDbPath).close();

    initDb(tmpHome);

    expect(existsSync(meshDbPath)).toBe(true);
    expect(existsSync(legacyDbPath)).toBe(true); // Should be untouched
  });

  it("relevant partial/stray-file cases (only legacy -wal exists, no legacy main)", () => {
    mkdirSync(dataDir, { recursive: true });
    const legacyDbPath = join(dataDir, "rusa.db");
    writeFileSync(legacyDbPath + "-wal", "fake wal");

    initDb(tmpHome);

    expect(existsSync(join(dataDir, "mesh.db"))).toBe(true);
    // Should NOT rename the wal, because main file doesn't exist
    expect(existsSync(legacyDbPath + "-wal")).toBe(true);
    expect(existsSync(join(dataDir, "mesh.db-wal"))).toBe(true); // sqlite creates it
  });
});
