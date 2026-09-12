import type { DecodedIdToken } from "firebase-admin/auth";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { UserPrincipal } from "../principals/principal-ref.js";

/** Called only after Firebase verification and the configured admission check.
 * Resolves identity, not permissions: this slice does not assign roots or migrate attribution. */
export class DashboardIdentityResolver {
  constructor(private readonly repository: () => PrincipalRepository) {}

  resolve(token: DecodedIdToken): UserPrincipal {
    if (!token.iss || !token.sub || token.uid !== token.sub || !token.email) {
      throw new Error("Invalid verified identity");
    }
    const repo = this.repository();
    const identity = { issuer: token.iss, subject: token.sub };
    let user = repo.findUserByExternalIdentity(identity);
    if (!user) {
      try {
        user = repo.createUser({
          identity,
          email: token.email,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        // Another serving process may have inserted this same verified identity.
        // Never fall back to email or bind an existing pending/foreign identity implicitly.
        user = repo.findUserByExternalIdentity(identity);
        if (!user) throw error;
      }
    }
    if (user.disabledAt) throw new Error("User disabled");
    const email = token.email.trim().toLowerCase();
    if (user.email !== email) user = repo.updateEmail(user.id, email);
    return user;
  }

  recordAuthentication(user: UserPrincipal, at: string): void {
    this.repository().recordAuthentication(user.id, at);
  }
}
