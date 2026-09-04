import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const wakeTokenPath = (mcHome: string): string => join(mcHome, "wake-token");
export const wakePortPath = (mcHome: string): string => join(mcHome, "wake-port");

/** Mint and persist the bearer token used by host-scheduled callbacks. */
export function ensureWakeToken(mcHome: string): string {
  const path = wakeTokenPath(mcHome);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Atomically publish the callback server's live port for host jobs. */
export function writeWakePort(mcHome: string, port: number): void {
  const path = wakePortPath(mcHome);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, String(port));
  renameSync(tmp, path);
}
