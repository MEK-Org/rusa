import type { DecodedIdToken } from "firebase-admin/auth";
import {
  normalizeEmail,
  type PrincipalRepository,
} from "../db/repositories/principal-repository.js";
import { type Logger, nullLogger } from "../observability/logger.js";
import type { UserPrincipal } from "../principals/principal-ref.js";

/** Safe response text for an admitted, verified account that cannot claim its
 * explicitly provisioned principal. It intentionally names no email, user id,
 * or competing external identity. */
export const DASHBOARD_IDENTITY_CLAIM_ERROR = "Account setup needs administrator action";

export class DashboardIdentityClaimError extends Error {
  constructor(cause?: unknown) {
    super(DASHBOARD_IDENTITY_CLAIM_ERROR, { cause });
    this.name = "DashboardIdentityClaimError";
  }
}

/** Called only after Firebase verification and the configured admission check.
 * Resolves identity, not permissions: this slice does not assign roots or migrate attribution. */
export class DashboardIdentityResolver {
  constructor(
    private readonly repository: () => PrincipalRepository,
    private readonly projectId: string,
    private readonly logger: Logger = nullLogger
  ) {}

  /** The durable key is derived here rather than read off the token: ID tokens and session
   * cookies carry different transport issuers for the same SDK-verified project, so a caller
   * cannot resolve the same person into two identity rows. */
  resolve(token: DecodedIdToken): UserPrincipal {
    if (!token.sub || token.uid !== token.sub || !token.email) {
      throw new Error("Invalid verified identity");
    }
    const repo = this.repository();
    const identity = {
      issuer: `https://securetoken.google.com/${this.projectId}`,
      subject: token.sub,
    };
    const email = normalizeEmail(token.email);
    let user = repo.findUserByExternalIdentity(identity);
    if (!user) {
      try {
        user = repo.claimUnboundUserByEmail(email, identity, new Date().toISOString());
        if (!user) user = repo.createUser({ identity, email, createdAt: new Date().toISOString() });
      } catch (error) {
        // Another serving process may have claimed this same provisioned email.
        // Resolve only that durable key; a different email is the first-sign-in
        // conflict the claim error intentionally reports without exposing it.
        user = repo.findUserByExternalIdentity(identity);
        if (!user || user.email !== email) throw this.conflict(error, email);
      }
    }
    if (user.disabledAt) throw new Error("User disabled");
    if (user.email !== email) {
      // Returning users preserve the existing generic authentication failure
      // for an email collision; account-setup guidance is first-sign-in only.
      user = repo.updateEmail(user.id, email);
    }
    return user;
  }

  recordAuthentication(user: UserPrincipal, at: string): void {
    this.repository().recordAuthentication(user.id, at);
  }

  /** A verified identity whose email another row already holds fails closed.
   * Without this record the operator sees a permanent sign-in loop and nothing else; the
   * address itself stays out of the log, so the row that holds it is named by id. */
  private conflict(error: unknown, email: string): unknown {
    const holder = this.repository().findUserByEmail(email);
    if (!holder) return error;
    this.logger.warn("dashboard_identity_email_conflict", {
      holderId: holder.id,
      holderBound: holder.identity !== undefined,
    });
    return new DashboardIdentityClaimError(error);
  }
}
