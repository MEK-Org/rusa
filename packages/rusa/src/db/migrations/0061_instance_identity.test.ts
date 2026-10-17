import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

describe("0061_instance_identity", () => {
  it("creates instance_identity table through migration runner", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(instance_identity)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;

    expect(columns.map((c) => c.name)).toEqual([
      "singleton",
      "instance_id",
      "role",
      "created_at",
      "boot_id",
      "updated_at",
    ]);

    expect(columns.find((c) => c.name === "singleton")?.pk).toBe(1);
    expect(columns.every((c) => c.notnull === 1)).toBe(true);
  });

  it("enforces role check constraint and valid fields", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Valid leader insert
    db.prepare(`
      INSERT INTO instance_identity (instance_id, role, created_at, boot_id, updated_at)
      VALUES ('inst-1', 'leader', '2026-10-12T00:00:00.000Z', 'boot-1', '2026-10-12T00:00:00.000Z')
    `).run();

    const row = db
      .prepare("SELECT * FROM instance_identity WHERE instance_id = 'inst-1'")
      .get() as {
      instance_id: string;
      role: string;
      boot_id: string;
    };
    expect(row.instance_id).toBe("inst-1");
    expect(row.role).toBe("leader");
    expect(row.boot_id).toBe("boot-1");

    // Invalid role rejected
    expect(() => {
      db.prepare(`
        INSERT INTO instance_identity (instance_id, role, created_at, boot_id, updated_at)
        VALUES ('inst-2', 'invalid_role', '2026-10-12T00:00:00.000Z', 'boot-1', '2026-10-12T00:00:00.000Z')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Blank instance_id rejected
    expect(() => {
      db.prepare(`
        INSERT INTO instance_identity (instance_id, role, created_at, boot_id, updated_at)
        VALUES ('  ', 'follower', '2026-10-12T00:00:00.000Z', 'boot-1', '2026-10-12T00:00:00.000Z')
      `).run();
    }).toThrow(/CHECK constraint failed/);
  });
});
