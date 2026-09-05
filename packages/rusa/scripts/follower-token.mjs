import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/follower-token.mjs /path/to/new/token");
const path = resolve(process.argv[2]);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
console.log(`Created enrollment token at ${path}`);
