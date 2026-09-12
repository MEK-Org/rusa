import { describe, expect, it } from "vitest";
import { validateDashboardAuth } from "./dashboard-auth.js";

describe("optional single-user auth config", () => {
  const valid = () => ({
    email: " Owner@Example.com ",
    firebase: {
      projectId: "project",
      apiKey: "key",
      authDomain: "project.firebaseapp.com",
      serviceAccountKeyPath: "/keys/admin.json",
    },
  });
  it("normalizes the sole email and accepts absent auth", () => {
    expect(() => validateDashboardAuth(undefined)).not.toThrow();
    const config = valid();
    validateDashboardAuth(config);
    expect(config.email).toBe("owner@example.com");
  });
  it.each([
    null,
    false,
    {},
    [],
    { ...valid(), email: ["a@example.com"] },
    { ...valid(), email: "" },
    { ...valid(), allowedEmails: ["a@example.com"] },
    { ...valid(), firebase: {} },
  ])("fails closed for malformed configuration: %j", (config) => {
    expect(() => validateDashboardAuth(config)).toThrow(/auth/);
  });
  it("never includes a credential value in errors", () => {
    expect(() =>
      validateDashboardAuth({
        ...valid(),
        firebase: { ...valid().firebase, authDomain: "https://secret.example" },
      })
    ).toThrow("config.yaml: auth.firebase.authDomain must be a hostname");
  });
});
