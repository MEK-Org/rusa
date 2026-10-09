import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { UserPrincipal } from "./principal-ref.js";

/** Admission metadata for local bootstrap; never a principal ID or a login address. */
export const IMPLICIT_USER_EMAIL = "local-operator@rusa.invalid";

/** The slice of principal storage the local-mode resolver reads. */
export type OperatorPrincipalSource = Pick<PrincipalRepository, "listUsers">;

/** Users that may still act: provisioned rows whose access has not been denied. */
export function listActiveUsers(principals: OperatorPrincipalSource | undefined): UserPrincipal[] {
  if (!principals) return [];
  return principals.listUsers().filter((u) => !u.disabledAt);
}

export type SoleActiveUserResolution =
  | { ok: true; user: UserPrincipal }
  | { ok: false; reason: "none" | "ambiguous"; error: string };

/**
 * The durable identity behind an unauthenticated (auth-disabled, local-mode)
 * action. The local process boundary is the trust boundary, so the sole active
 * user IS the attribution — but only when there is exactly one. With none there
 * is nothing durable to attribute to; with several, picking one would be a
 * guess. Local startup creates a durable user when storage has no users;
 * this resolver only reads the identity already present.
 */
export function resolveSoleActiveUser(
  principals: OperatorPrincipalSource | undefined
): SoleActiveUserResolution {
  const active = listActiveUsers(principals);
  if (active.length === 1) return { ok: true, user: active[0] };
  if (active.length === 0) {
    return {
      ok: false,
      reason: "none",
      error:
        "no active durable user principal exists to attribute this action to; start in local mode to bootstrap a user, or configure dashboard auth",
    };
  }
  return {
    ok: false,
    reason: "ambiguous",
    error: `${active.length} active durable user principals exist, so an unauthenticated action cannot be attributed; configure dashboard auth so each action carries an authenticated identity`,
  };
}
