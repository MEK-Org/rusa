/**
 * The workspace a Slack event's sender verifiably belongs to, or undefined
 * (#1038). The answer is the receiving installation's own team id, and only
 * when every workspace field the envelope carries agrees with it:
 *
 * - the envelope's `team_id` must be present and equal the installation's;
 * - `event.team`, `event.user_team` and `event.source_team`, when present,
 *   must equal it too, so a sender from another workspace in a shared channel
 *   is never read as a local user;
 * - `context_team_id`, when present, must equal it as well;
 * - externally shared channels and Enterprise Grid envelopes are not covered
 *   by a verified contract yet, so they carry no workspace at all. An
 *   envelope is Grid when it names an enterprise in any documented place:
 *   `enterprise_id`, `context_enterprise_id`, or an authorization's
 *   `enterprise_id` or `is_enterprise_install`.
 *
 * An undefined result only withholds identity context; delivery is unchanged.
 */
export function verifiedSenderWorkspace(
  body: unknown,
  installationWorkspaceId: string | undefined
): string | undefined {
  if (!installationWorkspaceId || !body || typeof body !== "object") return undefined;
  const envelope = body as {
    team_id?: unknown;
    enterprise_id?: unknown;
    context_team_id?: unknown;
    context_enterprise_id?: unknown;
    is_ext_shared_channel?: unknown;
    authorizations?: unknown;
    event?: { team?: unknown; user_team?: unknown; source_team?: unknown };
  };
  if (envelope.team_id !== installationWorkspaceId) return undefined;
  if (envelope.is_ext_shared_channel === true) return undefined;
  if (isPresent(envelope.context_team_id) && envelope.context_team_id !== installationWorkspaceId) {
    return undefined;
  }
  if (namesEnterprise(envelope.enterprise_id) || namesEnterprise(envelope.context_enterprise_id)) {
    return undefined;
  }
  if (
    Array.isArray(envelope.authorizations) &&
    envelope.authorizations.some((authorization) => {
      const grant = authorization as {
        enterprise_id?: unknown;
        is_enterprise_install?: unknown;
      } | null;
      return namesEnterprise(grant?.enterprise_id) || grant?.is_enterprise_install === true;
    })
  ) {
    return undefined;
  }
  const event = envelope.event ?? {};
  for (const team of [event.team, event.user_team, event.source_team]) {
    if (team !== undefined && team !== installationWorkspaceId) return undefined;
  }
  return installationWorkspaceId;
}

/** Slack writes an absent optional id as null or omits it. */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Whether a Slack `enterprise_id` field names an enterprise: any value other
 * than an absent, null or empty one. The one definition both the envelope
 * check here and the startup `auth.test` read use, so they cannot disagree.
 */
export function namesEnterprise(value: unknown): boolean {
  return isPresent(value) && value !== "";
}
