import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { UserPrincipal } from "./principal-ref.js";

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

const BOOTSTRAP_HINT =
  "bootstrap one with `pnpm --filter rusa run migrate:legacy-principal -- --database <mesh.db> --email <email> --apply`, or configure dashboard auth";

/**
 * The durable identity behind an unauthenticated (auth-disabled, local-mode)
 * action. The local process boundary is the trust boundary, so the sole active
 * user IS the attribution — but only when there is exactly one. With none there
 * is nothing durable to attribute to; with several, picking one would be a
 * guess. Neither case falls back to the legacy `human:operator` alias: that
 * alias is what the #460 migration retires, and minting it again would undo
 * the cutover one action at a time.
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
      error: `no durable user principal exists to attribute this action to; ${BOOTSTRAP_HINT}`,
    };
  }
  return {
    ok: false,
    reason: "ambiguous",
    error: `${active.length} active durable user principals exist, so an unauthenticated action cannot be attributed; configure dashboard auth so each action carries an authenticated identity`,
  };
}

/**
 * Translate the legacy `human:operator` owner alias to the durable principal it
 * now names. Exactly one active user → that user's id, so no new authoritative
 * `human:operator` row is minted after the cutover. No users → the literal is
 * kept: nothing durable exists yet and the migration will sweep the row once a
 * user is bootstrapped. Several users → refused as ambiguous; the caller must
 * name the durable principal id.
 */
export function resolveLegacyOperatorAlias(
  ownerId: string,
  principals: OperatorPrincipalSource | undefined
): { ok: true; ownerId: string } | { ok: false; error: string } {
  if (ownerId !== HUMAN_OPERATOR) return { ok: true, ownerId };
  const sole = resolveSoleActiveUser(principals);
  if (sole.ok) return { ok: true, ownerId: sole.user.id };
  if (sole.reason === "none") return { ok: true, ownerId };
  return {
    ok: false,
    error: `${HUMAN_OPERATOR} is ambiguous: ${listActiveUsers(principals).length} active durable user principals exist; name the durable user principal id instead`,
  };
}
