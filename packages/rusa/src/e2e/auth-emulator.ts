import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { validateDashboardAuth } from "../config/dashboard-auth.js";
import { DashboardAuth } from "../dashboard/auth.js";
import { DashboardIdentityResolver } from "../dashboard/identity.js";
import { getRepositories } from "../db/index.js";

/** Explicit disposable-instance seam. Production auth still rejects emulator mode. */
export function createE2EDashboardAuth(host: string, email: string): DashboardAuth {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
    throw new Error("Auth emulator must be a loopback host:port");
  }
  const port = Number(host.split(":")[1]);
  if (port < 1 || port > 65535) throw new Error("Invalid auth emulator port");
  const config = {
    email,
    firebase: {
      projectId: "demo-rusa-auth",
      apiKey: "e2e-key",
      authDomain: "localhost",
      serviceAccountKeyPath: "/unused-e2e-credential",
    },
  };
  validateDashboardAuth(config);
  process.env.FIREBASE_AUTH_EMULATOR_HOST = host;
  const app = initializeApp({ projectId: config.firebase.projectId }, `rusa-e2e-${randomUUID()}`);
  return new DashboardAuth(
    config,
    getAuth(app),
    new DashboardIdentityResolver(() => getRepositories().principals),
    Date.now,
    () => deleteApp(app),
    `http://${host}`
  );
}
