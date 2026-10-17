import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getInstanceIdentity, initInstanceIdentity } from "./instance-identity.js";
import { runMigrations } from "./migrations/runner.js";

describe("instance-identity", () => {
  it("initializes new identity on first boot and reads it back", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    expect(getInstanceIdentity(db)).toBeNull();

    const identity = initInstanceIdentity(db, {
      role: "leader",
      configuredInstanceId: "test-leader-1",
      bootId: "boot-uuid-1",
    });

    expect(identity).toMatchObject({
      instanceId: "test-leader-1",
      role: "leader",
      bootId: "boot-uuid-1",
    });

    const readback = getInstanceIdentity(db);
    expect(readback).toEqual(identity);
  });

  it("survives restart: stable identity preserved while bootId changes", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const boot1 = initInstanceIdentity(db, {
      role: "follower",
      configuredInstanceId: "follower-node-A",
      bootId: "boot-first",
    });
    expect(boot1.instanceId).toBe("follower-node-A");

    // Second boot (restart)
    const boot2 = initInstanceIdentity(db, {
      role: "follower",
      bootId: "boot-second",
    });
    expect(boot2.instanceId).toBe("follower-node-A");
    expect(boot2.role).toBe("follower");
    expect(boot2.bootId).toBe("boot-second");
    expect(boot2.createdAt).toBe(boot1.createdAt);

    // Third boot (restart) with matching configured ID
    const boot3 = initInstanceIdentity(db, {
      role: "follower",
      configuredInstanceId: "follower-node-A",
      bootId: "boot-third",
    });
    expect(boot3.instanceId).toBe("follower-node-A");
    expect(boot3.bootId).toBe("boot-third");
  });

  it("fails fast before services run when configured instance ID conflicts with DB", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    initInstanceIdentity(db, {
      role: "leader",
      configuredInstanceId: "original-id",
    });

    expect(() => {
      initInstanceIdentity(db, {
        role: "leader",
        configuredInstanceId: "conflicting-id",
      });
    }).toThrow(/conflicts with existing database instance ID/);
  });

  it("fails fast before services run when configured role conflicts with DB", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    initInstanceIdentity(db, {
      role: "leader",
      configuredInstanceId: "shared-id",
    });

    expect(() => {
      initInstanceIdentity(db, {
        role: "follower",
        configuredInstanceId: "shared-id",
      });
    }).toThrow(/conflicts with existing database instance role/);
  });

  it("rejects blank configured instance ID", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    expect(() => {
      initInstanceIdentity(db, {
        role: "leader",
        configuredInstanceId: "   ",
      });
    }).toThrow(/cannot be blank/);
  });

  it("enforces singleton constraint: table cannot hold more than one row", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    initInstanceIdentity(db, { role: "leader", configuredInstanceId: "node-1" });

    // Inserting with singleton = 1 fails with UNIQUE / PRIMARY KEY constraint
    expect(() => {
      db.prepare(`
        INSERT INTO instance_identity (singleton, instance_id, role, created_at, boot_id, updated_at)
        VALUES (1, 'node-2', 'follower', 'now', 'boot-2', 'now')
      `).run();
    }).toThrow();

    // Inserting with singleton != 1 fails with CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO instance_identity (singleton, instance_id, role, created_at, boot_id, updated_at)
        VALUES (2, 'node-2', 'follower', 'now', 'boot-2', 'now')
      `).run();
    }).toThrow();
  });
});
