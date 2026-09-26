import { readFileSync } from "node:fs";
import { assertSecretContainment, secretsDirPath } from "./secrets.js";

/**
 * Read the optional host-plane JEV credential. A missing, invalid, or empty
 * file leaves the shadow classifier unavailable; it must not prevent the
 * normal scheduler from starting. The filename and value never leave here.
 */
export function readJevApiKeyFile(filename: string | undefined, home: string): string | undefined {
  if (!filename) return undefined;
  try {
    const path = assertSecretContainment(filename, secretsDirPath(home));
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
