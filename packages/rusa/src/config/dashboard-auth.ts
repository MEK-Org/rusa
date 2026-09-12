import type { DashboardAuthConfig } from "./types.js";

/** Reject malformed auth rather than silently starting an unprotected dashboard. */
export function validateDashboardAuth(
  value: unknown
): asserts value is DashboardAuthConfig | undefined {
  if (value === undefined) return;
  const mapping = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!mapping(value) || !mapping(value.firebase)) {
    throw new Error("config.yaml: auth and auth.firebase must be mappings");
  }
  if (Object.keys(value).some((key) => !["email", "firebase"].includes(key))) {
    throw new Error("config.yaml: auth supports only email and firebase in single-user mode");
  }
  if (typeof value.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())) {
    throw new Error("config.yaml: auth.email must be one email address");
  }
  value.email = value.email.trim().toLowerCase();
  const fields = ["projectId", "apiKey", "authDomain", "serviceAccountKeyPath"];
  if (Object.keys(value.firebase).some((key) => !fields.includes(key))) {
    throw new Error("config.yaml: unknown auth.firebase field");
  }
  for (const key of fields) {
    const field = value.firebase[key];
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(`config.yaml: auth.firebase.${key} must be a non-empty string`);
    }
    value.firebase[key] = field.trim();
  }
  if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(value.firebase.authDomain as string)) {
    throw new Error("config.yaml: auth.firebase.authDomain must be a hostname");
  }
}
