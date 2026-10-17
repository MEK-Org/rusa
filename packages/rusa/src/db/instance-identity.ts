import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type Database from "better-sqlite3";
import type { InstanceRole } from "../config/types.js";

export interface InstanceIdentityRecord {
  instanceId: string;
  role: InstanceRole;
  createdAt: string;
  bootId: string;
  updatedAt: string;
}

export type InstanceIdentity = InstanceIdentityRecord;

export interface InitInstanceIdentityOptions {
  role: InstanceRole;
  configuredInstanceId?: string;
  bootId?: string;
}

interface RawInstanceIdentityRow {
  instance_id: string;
  role: string;
  created_at: string;
  boot_id: string;
  updated_at: string;
}

function normalizeInstanceId(id: string): string {
  return id.trim();
}

export function defaultInstanceId(): string {
  const host = hostname().replace(/[^a-zA-Z0-9_-]/g, "-");
  const suffix = randomUUID().slice(0, 8);
  return host.length > 0 ? `${host}-${suffix}` : `inst-${suffix}`;
}

/**
 * Initialize or update the stable instance identity and boot identity in mesh.db (#1019).
 *
 * Ensures:
 * 1. The stable instanceId persists across restarts.
 * 2. The bootId changes on every boot.
 * 3. Conflicting configured instance IDs or roles fail before services run.
 */
export function initInstanceIdentity(
  db: Database.Database,
  options: InitInstanceIdentityOptions
): InstanceIdentityRecord {
  const role = options.role;
  const configuredId = options.configuredInstanceId
    ? normalizeInstanceId(options.configuredInstanceId)
    : undefined;
  if (configuredId !== undefined && configuredId.length === 0) {
    throw new Error("Configured instance ID cannot be blank");
  }

  const existing = db.prepare("SELECT * FROM instance_identity WHERE singleton = 1").get() as
    | RawInstanceIdentityRow
    | undefined;

  if (existing) {
    if (configuredId !== undefined && configuredId !== existing.instance_id) {
      throw new Error(
        `Configured instance ID "${configuredId}" conflicts with existing database instance ID "${existing.instance_id}"`
      );
    }
    if (existing.role !== role) {
      throw new Error(
        `Configured role "${role}" conflicts with existing database instance role "${existing.role}"`
      );
    }

    const bootId = options.bootId ?? randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE instance_identity
      SET boot_id = ?, updated_at = ?
      WHERE singleton = 1
    `).run(bootId, now);

    return {
      instanceId: existing.instance_id,
      role: existing.role as InstanceRole,
      createdAt: existing.created_at,
      bootId,
      updatedAt: now,
    };
  }

  const instanceId = configuredId ?? defaultInstanceId();
  const bootId = options.bootId ?? randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO instance_identity (singleton, instance_id, role, created_at, boot_id, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(instanceId, role, now, bootId, now);

  return {
    instanceId,
    role,
    createdAt: now,
    bootId,
    updatedAt: now,
  };
}

/**
 * Read the current instance identity record from mesh.db, or null if not yet initialized.
 */
export function getInstanceIdentity(db: Database.Database): InstanceIdentityRecord | null {
  const row = db.prepare("SELECT * FROM instance_identity WHERE singleton = 1").get() as
    | RawInstanceIdentityRow
    | undefined;
  if (!row) return null;
  return {
    instanceId: row.instance_id,
    role: row.role as InstanceRole,
    createdAt: row.created_at,
    bootId: row.boot_id,
    updatedAt: row.updated_at,
  };
}
