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
  if (Object.keys(value).some((key) => !["email", "allowedEmails", "firebase"].includes(key))) {
    throw new Error("config.yaml: unknown auth field");
  }
  if ("email" in value === "allowedEmails" in value) {
    throw new Error("config.yaml: auth requires exactly one of email or allowedEmails");
  }
  const normalize = (email: unknown): string => {
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      throw new Error("config.yaml: auth admission entries must be email addresses");
    }
    return email.trim().toLowerCase();
  };
  if ("email" in value) value.email = normalize(value.email);
  else {
    if (!Array.isArray(value.allowedEmails) || value.allowedEmails.length === 0) {
      throw new Error("config.yaml: auth.allowedEmails must be a non-empty array");
    }
    const emails = value.allowedEmails.map(normalize);
    if (new Set(emails).size !== emails.length)
      throw new Error("config.yaml: duplicate auth.allowedEmails entry");
    value.allowedEmails = emails;
  }
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

export function allowedDashboardEmails(config: DashboardAuthConfig): readonly string[] {
  return config.allowedEmails ?? (config.email ? [config.email] : []);
}
