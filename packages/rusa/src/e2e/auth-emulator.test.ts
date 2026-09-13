import { afterEach, expect, it } from "vitest";
import { createE2EDashboardAuth } from "./auth-emulator.js";

const previous = process.env.FIREBASE_AUTH_EMULATOR_HOST;
afterEach(() => {
  if (previous === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = previous;
});

it.each([
  "example.com:9099",
  "0.0.0.0:9099",
  "http://localhost:9099",
  "localhost:0",
  "localhost:65536",
])("rejects unsafe emulator address %s", (host) => {
  expect(() => createE2EDashboardAuth(host, "operator@example.com")).toThrow();
});

it("uses a demo project and advertises the emulator without credentials", async () => {
  const auth = createE2EDashboardAuth("127.0.0.1:9099", "operator@example.com");
  try {
    expect(auth.clientConfig()).toEqual({
      enabled: true,
      firebase: { projectId: "demo-rusa-auth", apiKey: "e2e-key", authDomain: "localhost" },
      emulatorUrl: "http://127.0.0.1:9099",
    });
    expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe("127.0.0.1:9099");
  } finally {
    await auth.close();
  }
});
