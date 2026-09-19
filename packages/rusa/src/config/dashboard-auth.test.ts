import { describe, expect, it } from "vitest";
import { validateDashboardAuth } from "./dashboard-auth.js";

describe("optional shared-human auth config", () => {
  const valid = () => ({
    email: " Owner@Example.com ",
    firebase: {
      projectId: "project",
      apiKey: "key",
      authDomain: "project.firebaseapp.com",
      appId: "app-id",
      messagingSenderId: "sender-id",
      serviceAccountKeyPath: "/keys/admin.json",
    },
  });
  it("normalizes the sole email and accepts absent auth", () => {
    expect(() => validateDashboardAuth(undefined)).not.toThrow();
    const config = valid();
    validateDashboardAuth(config);
    expect(config.email).toBe("owner@example.com");
  });
  it("normalizes an explicit shared allowlist", () => {
    const config = {
      firebase: valid().firebase,
      allowedEmails: [" Owner@Example.com ", "OTHER@example.com"],
    };
    validateDashboardAuth(config);
    expect(config.allowedEmails).toEqual(["owner@example.com", "other@example.com"]);
  });
  it("accepts programmatic configurations with explicit undefined omitted keys", () => {
    const configWithUndefinedEmail = {
      firebase: valid().firebase,
      email: undefined,
      allowedEmails: [" Owner@Example.com "],
    };
    validateDashboardAuth(configWithUndefinedEmail);
    expect(configWithUndefinedEmail.allowedEmails).toEqual(["owner@example.com"]);

    const configWithUndefinedAllowlist = {
      firebase: valid().firebase,
      email: " Owner@Example.com ",
      allowedEmails: undefined,
    };
    validateDashboardAuth(configWithUndefinedAllowlist);
    expect(configWithUndefinedAllowlist.email).toBe("owner@example.com");
  });
  it.each([
    [],
    "owner@example.com",
    null,
    [null],
    ["invalid"],
    ["owner@example.com", " OWNER@example.com "],
  ])("rejects invalid allowlists: %j", (allowedEmails) => {
    expect(() => validateDashboardAuth({ firebase: valid().firebase, allowedEmails })).toThrow(
      /auth/
    );
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
  it("fails closed with the required FlutterFire upgrade field for legacy auth configs", () => {
    const legacy = valid();
    delete (legacy.firebase as Partial<typeof legacy.firebase>).appId;
    expect(() => validateDashboardAuth(legacy)).toThrow(
      "config.yaml: auth.firebase.appId must be a non-empty string"
    );
  });
});
