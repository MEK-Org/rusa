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

/**
 * The Google account id a verified token was signed in with (#890): the first
 * `firebase.identities["google.com"]` entry, which Google Chat names as
 * `users/{id}`. Undefined when the token carries no Google identity.
 */
export function googleAccountIdOf(token: DecodedIdToken): string | undefined {
  const id = token.firebase?.identities?.["google.com"]?.[0];
  return typeof id === "string" && id.length > 0 ? id : undefined;
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
        if (!user || user.email !== email) {
          throw new DashboardIdentityClaimError(this.conflict(error, email));
        }
      }
    }
    if (user.disabledAt) throw new Error("User disabled");
    if (user.email !== email) {
      // Returning users preserve the existing generic authentication failure
      // for an email collision; account-setup guidance is first-sign-in only.
      try {
        user = repo.updateEmail(user.id, email);
      } catch (error) {
        throw this.conflict(error, email);
      }
    }
    return user;
  }

  /**
   * Stamp a sign-in and record the Google account id from its verified ID
   * token, which is the only source for that column. A Google id already held
   * by another user is logged by holder id and left alone: sign-in still
   * succeeds, and this user's Chat messages stay unmatched until an operator
   * resolves the duplicate.
   */
  recordAuthentication(user: UserPrincipal, at: string, token?: DecodedIdToken): void {
    const repo = this.repository();
    repo.recordAuthentication(user.id, at);
    const googleAccountId = token === undefined ? undefined : googleAccountIdOf(token);
    if (googleAccountId === undefined || googleAccountId === user.googleAccountId) return;
    let holder = repo.findUserByGoogleAccountId(googleAccountId);
    if (holder === undefined || holder.id === user.id) {
      try {
        repo.setGoogleAccountId(user.id, googleAccountId);
        return;
      } catch (error) {
        // A concurrent sign-in can take the id between that read and this
        // write; the unique index refuses this one, which is the same conflict.
        holder = repo.findUserByGoogleAccountId(googleAccountId);
        if (holder === undefined || holder.id === user.id) throw error;
      }
    }
    this.logger.warn("dashboard_google_account_conflict", {
      userId: user.id,
      holderId: holder.id,
    });
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
    return new Error("Verified email is already registered to another user", { cause: error });
  }
}
