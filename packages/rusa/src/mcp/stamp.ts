import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STAMP_UNVERSIONED_RE = /<!--\s*mesh:author\s+([^\s<>]+)\s*-->/gi;
const STAMP_V1_RE = /<!--\s*mesh:author:v1\s+([^\s<>]+)\s+(\d+)\s+([0-9a-fA-F]+)\s*-->/gi;
const STAMP_V2_RE =
  /<!--\s*mesh:author:v2\s+([^\s<>]+)\s+([^\s<>]+)\s+(\d+)\s+([0-9a-fA-F]+)\s*-->/gi;
const STAMP_V3_RE =
  /<!--\s*mesh:author:v3\s+([^\s<>]+)\s+([^\s<>]+)\s+(\d+)\s+([0-9a-fA-F]+)\s*-->/gi;

// Ephemeral host-plane secret generated at process start.
// This is host-plane ONLY; worker sandboxes cannot access this in-memory secret.
// Ephemeral generation on restart is acceptable and intended. Do NOT persist this key to disk or config.
const STAMP_SECRET = randomBytes(32).toString("hex");

/**
 * Computes the HMAC signature for an author stamp.
 */
function computeHmac(
  actorId: string,
  instanceId: string | undefined,
  issuedAt: number,
  repo: string,
  issueNumber: number
): string {
  const payload = `${actorId}:${instanceId ?? ""}:${issuedAt}:${repo}:${issueNumber}`;
  return createHmac("sha256", STAMP_SECRET).update(payload).digest("hex");
}

function computeRepoHmac(
  actorId: string,
  instanceId: string | undefined,
  issuedAt: number,
  repo: string
): string {
  const payload = `${actorId}:${instanceId ?? ""}:${issuedAt}:${repo}`;
  return createHmac("sha256", STAMP_SECRET).update(payload).digest("hex");
}

/**
 * Formats the authenticated actor id as an HTML comment stamp.
 * If repo is provided, produces a versioned, HMAC-signed stamp.
 * If issueNumber is also provided, uses v2's issue-scoped HMAC. Otherwise,
 * uses v3's repo-scoped HMAC so issue bodies can be stamped before creation.
 * Without repo, produces a standard unversioned stamp.
 */
export function stampAuthor(
  actorId: string,
  repo?: string,
  issueNumber?: number,
  instanceId = "default"
): string {
  if (repo !== undefined && issueNumber !== undefined) {
    const issuedAt = Date.now();
    const hmac = computeHmac(actorId, instanceId, issuedAt, repo, issueNumber);
    return `<!-- mesh:author:v2 ${actorId} ${instanceId} ${issuedAt} ${hmac} -->`;
  }
  if (repo !== undefined) {
    const issuedAt = Date.now();
    const hmac = computeRepoHmac(actorId, instanceId, issuedAt, repo);
    return `<!-- mesh:author:v3 ${actorId} ${instanceId} ${issuedAt} ${hmac} -->`;
  }
  return `<!-- mesh:author ${actorId} -->`;
}

/**
 * Removes every author stamp from a body, in all four forms.
 *
 * Clearing ALL forms is load-bearing, not defensive tidiness: verifyAuthorStamp compares
 * last-match indices ACROSS versions, so a single leftover stamp of an older form sitting
 * after the freshly appended one would win the comparison and attribute the body to the
 * wrong actor. Stripping by current version only would reintroduce exactly the confusion
 * this is here to remove.
 *
 * Used by the re-stamp path (update_body), where the body being replaced legitimately
 * carries the previous author's stamp. Creation paths stay append-only — see
 * appendAuthorStamp in tracker-mcp.ts.
 */
export function stripAuthorStamps(body: string): string {
  return body
    .replace(STAMP_V3_RE, "")
    .replace(STAMP_V2_RE, "")
    .replace(STAMP_V1_RE, "")
    .replace(STAMP_UNVERSIONED_RE, "")
    .trimEnd();
}

/**
 * Parses the author actor id from the markdown body (fallback/migration helper).
 * Always prefers the last stamp in the body.
 */
export function parseAuthor(body: string | null | undefined): string | null {
  if (!body) return null;
  const v3Matches = [...body.matchAll(STAMP_V3_RE)];
  const v2Matches = [...body.matchAll(STAMP_V2_RE)];
  const v1Matches = [...body.matchAll(STAMP_V1_RE)];
  const unversionedMatches = [...body.matchAll(STAMP_UNVERSIONED_RE)];

  const lastV3 = v3Matches[v3Matches.length - 1];
  const lastV2 = v2Matches[v2Matches.length - 1];
  const lastV1 = v1Matches[v1Matches.length - 1];
  const lastUnversioned = unversionedMatches[unversionedMatches.length - 1];

  const lastV3Index = lastV3?.index ?? -1;
  const lastV2Index = lastV2?.index ?? -1;
  const lastV1Index = lastV1?.index ?? -1;
  const lastUnversionedIndex = lastUnversioned?.index ?? -1;

  if (
    lastV3Index === -1 &&
    lastV2Index === -1 &&
    lastV1Index === -1 &&
    lastUnversionedIndex === -1
  ) {
    return null;
  }

  if (
    lastV3Index > lastV2Index &&
    lastV3Index > lastV1Index &&
    lastV3Index > lastUnversionedIndex
  ) {
    return lastV3[1];
  }
  if (lastV2Index > lastV1Index && lastV2Index > lastUnversionedIndex) {
    return lastV2[1];
  }
  if (lastV1Index > lastUnversionedIndex) {
    return lastV1[1];
  }
  return lastUnversioned[1];
}

export interface VerificationResult {
  status: "verified" | "migration" | "foreign" | "expired" | "unverifiable" | "none";
  actorId?: string;
  instanceId?: string;
  reason?: string;
}

/**
 * Resolves the body whose author stamp is allowed to speak for this event's sender.
 *
 * The invariant this follows from — key on the ACTION, never the field:
 *
 *   A stamp proves authorship of a BODY. It proves authorship of an EVENT only when
 *   the event is that body's creation.
 *
 * Field-based reasoning cannot express that: `pull_request.body` is correct authorship
 * for `pull_request/opened` and wrong for `pull_request/labeled` — same field, opposite
 * answers. So the table below is derived, not memorized; settle any event it omits by
 * asking whether the event created the body, not by which field carries it.
 *
 * Everything that isn't a creation resolves to null (no author stamp → fail open → deliver):
 * - Bodiless events (labeled/closed/merged/synchronize) have no body of their own. Reading
 *   the enclosing issue/PR body would attribute the event to the issue/PR *author* rather
 *   than the actor who acted, suppressing it for the wrong actor.
 *
 * `issues.edited` / `pull_request.edited` ARE included, because a re-write makes the editor
 * the body's author . The old exclusion rested on "the sender is the editor, but the
 * stamp is the original author's" — update_body now strips before it stamps, so the single
 * surviving stamp IS the editor's by construction. This is not the freshness-window
 * discriminator that was ruled out: nothing here infers WHO edited, it reads a stamp the
 * write path guaranteed.
 *
 * That guarantee is only as wide as an actual BODY edit, so `edited` alone is not enough
 * to lean on it. `edited` is broader than "the body changed" from two directions:
 * GitHub fires it for a title-only edit, and the poller (github/poller.ts) synthesizes
 * `action: "edited"` for ANY updatedAt bump — a label, a close, a new comment — carrying no
 * `changes` object and a `sender` set to the ARTIFACT AUTHOR rather than whoever acted.
 * Reading the untouched body in either case attributes the event to the original author and
 * suppresses it for them: the bodiless-event failure above, wearing an `edited` label.
 *
 * Hence the `changes.body` gate. A native webhook proves a body edit by sending that key;
 * anything that cannot prove it — every synthetic poller payload, since it has no `changes`
 * at all — falls through to null and is delivered. Revisit only if the poller starts
 * carrying the prior body or the change kind.
 *
 * That guarantee is exactly as wide as update_body, which is why comment edits stay
 * excluded:
 * - `issue_comment.edited` / `pull_request_review_comment.edited` → null. There is no
 *   comment-edit tool on the mesh write path (update_body takes an issueNumber and replaces
 *   an issue/PR body), so an edited comment still carries the ORIGINAL commenter's stamp
 *   with nothing to re-stamp it. Including them would suppress the event for whoever wrote
 *   the comment rather than whoever edited it — silent deafness, the failure this whole
 *   table exists to avoid. Add them only alongside a re-stamping comment-edit write path.
 *
 * Deliberately distinct from directiveBodyForWebhookPayload, which walks a parent fallback
 * chain. That chain is correct for reading a directive off the enclosing issue/PR and wrong
 * for attributing authorship; both questions used to share one resolved body.
 */
export function authorStampBodyForWebhookPayload(
  event: string,
  action: string | undefined,
  payload: Record<string, unknown>
): string | null {
  const bodyOf = (key: string): string | null => {
    const body = (payload[key] as { body?: unknown } | undefined)?.body;
    return typeof body === "string" ? body : null;
  };

  // Affirmative proof that THIS edit touched the body. Absent proof we deliver, so a
  // title-only edit or a synthetic poller "edited" can never suppress the wrong actor.
  const bodyWasEdited = (): boolean => {
    const changes = payload.changes;
    return typeof changes === "object" && changes !== null && "body" in changes;
  };

  if (event === "issue_comment" && action === "created") return bodyOf("comment");
  if (event === "pull_request_review_comment" && action === "created") return bodyOf("comment");
  if (event === "pull_request_review" && action === "submitted") return bodyOf("review");
  if (event === "issues" && action === "opened") return bodyOf("issue");
  if (event === "pull_request" && action === "opened") return bodyOf("pull_request");
  // Body edits to issues/PRs only — update_body re-stamps these, so the stamp is the
  // editor's. Comment edits have no re-stamping write path; see the doc comment above.
  if (event === "issues" && action === "edited") return bodyWasEdited() ? bodyOf("issue") : null;
  if (event === "pull_request" && action === "edited")
    return bodyWasEdited() ? bodyOf("pull_request") : null;
  return null;
}

/**
 * Verifies the author stamp found in the body against the provided context.
 *
 * ACCEPTED BY DESIGN:
 * - Scope: This layer does not defend against a compromised worker; the VM sandbox
 *   and the future token-isolation epic own that security boundary.
 * - Known Residual: A valid stamp can be lifted and re-appended to different content
 *   within the freshness window (replay-onto-new-content), suppressing that actor's
 *   webhook for one event. For v2, the target is another comment on the same issue:
 *   the HMAC covers actorId:instanceId:issuedAt:repo:issueNumber, not the body or
 *   comment id. For v3, the target widens to the same repo: the HMAC covers
 *   actorId:instanceId:issuedAt:repo so the stamp is computable before issue
 *   creation. This is accepted because exploiting it requires an already-compromised
 *   worker. v1 stamps do not carry this residual: the v1 branch returns migration
 *   without verifying HMAC or freshness, so the event is delivered.
 * - Re-evaluation Trigger: If stamps ever gain authority beyond webhook suppression
 *   and event routing, this residual MUST be re-weighed (to satisfy the no-authority-creep
 *   condition).
 *
 * `localInstanceId`, when given, is this process's own instance handle. A v2/v3 stamp
 * whose `instanceId` doesn't match it came from another instance sharing the same bot
 * login (#201) — that is short-circuited to `foreign` before the HMAC is ever
 * computed or compared, since a foreign instance's HMAC can never match ours anyway and
 * the comparison would just relabel "not ours" as "invalid". Omitting it (legacy callers)
 * skips the check and verifies purely against this instance's own secret, as before.
 */
export function verifyAuthorStamp(
  body: string | null | undefined,
  repo: string,
  issueNumber: number,
  localInstanceId?: string
): VerificationResult {
  if (!body) {
    return { status: "none" };
  }

  const v3Matches = [...body.matchAll(STAMP_V3_RE)];
  const v2Matches = [...body.matchAll(STAMP_V2_RE)];
  const v1Matches = [...body.matchAll(STAMP_V1_RE)];
  const unversionedMatches = [...body.matchAll(STAMP_UNVERSIONED_RE)];

  const lastV3 = v3Matches[v3Matches.length - 1];
  const lastV2 = v2Matches[v2Matches.length - 1];
  const lastV1 = v1Matches[v1Matches.length - 1];
  const lastUnversioned = unversionedMatches[unversionedMatches.length - 1];

  const lastV3Index = lastV3?.index ?? -1;
  const lastV2Index = lastV2?.index ?? -1;
  const lastV1Index = lastV1?.index ?? -1;
  const lastUnversionedIndex = lastUnversioned?.index ?? -1;

  if (
    lastV3Index === -1 &&
    lastV2Index === -1 &&
    lastV1Index === -1 &&
    lastUnversionedIndex === -1
  ) {
    return { status: "none" };
  }

  if (
    lastV3Index > lastV2Index &&
    lastV3Index > lastV1Index &&
    lastV3Index > lastUnversionedIndex
  ) {
    const actorId = lastV3[1];
    const instanceId = lastV3[2];
    const issuedAt = parseInt(lastV3[3], 10);
    const hmac = lastV3[4];

    if (localInstanceId !== undefined && instanceId !== localInstanceId) {
      return { status: "foreign", actorId, instanceId };
    }

    const expectedHmac = computeRepoHmac(actorId, instanceId, issuedAt, repo);
    return verifySignedStamp({
      actorId,
      instanceId,
      issuedAt,
      hmac,
      expectedHmac,
      context: `${repo}#${issueNumber}`,
    });
  }
  if (lastV2Index > lastV1Index && lastV2Index > lastUnversionedIndex) {
    const actorId = lastV2[1];
    const instanceId = lastV2[2];
    const issuedAt = parseInt(lastV2[3], 10);
    const hmac = lastV2[4];

    if (localInstanceId !== undefined && instanceId !== localInstanceId) {
      return { status: "foreign", actorId, instanceId };
    }

    const expectedHmac = computeHmac(actorId, instanceId, issuedAt, repo, issueNumber);
    return verifySignedStamp({
      actorId,
      instanceId,
      issuedAt,
      hmac,
      expectedHmac,
      context: `${repo}#${issueNumber}`,
    });
  } else if (lastV1Index > lastUnversionedIndex) {
    const actorId = lastV1[1];
    return { status: "migration", actorId };
  } else {
    const actorId = lastUnversioned[1];
    return { status: "migration", actorId };
  }
}

function verifySignedStamp(opts: {
  actorId: string;
  instanceId: string;
  issuedAt: number;
  hmac: string;
  expectedHmac: string;
  context: string;
}): VerificationResult {
  const { actorId, instanceId, issuedAt, hmac, expectedHmac, context } = opts;
  const hmacBuf = Buffer.from(hmac, "hex");
  const expectedHmacBuf = Buffer.from(expectedHmac, "hex");

  if (hmacBuf.length !== expectedHmacBuf.length || !timingSafeEqual(hmacBuf, expectedHmacBuf)) {
    // Same instanceId as ours, yet the HMAC doesn't match: post-restart key rotation and an
    // actual forged stamp are indistinguishable by this mechanism, so neither is claimed
    // (#201).
    return {
      status: "unverifiable",
      reason: `HMAC mismatch. Expected ${expectedHmac}, got ${hmac}. Context: ${context}`,
    };
  }

  // Check freshness
  const now = Date.now();
  const ageMs = now - issuedAt;
  // Must comfortably EXCEED the GitHub poll interval (default pollIntervalSeconds=300 / 5min).
  // issuedAt is set at post-time but the stamp is verified at poll-time, so a legit self-post can
  // age up to ~one poll interval (plus a missed cycle) before it is seen. A window <= the poll
  // cadence expires legit self-stamps and leaks self-echoes as delivered. 15min = 3x the default
  // cadence, surviving a missed cycle + propagation. If pollIntervalSeconds is raised, raise this.
  const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
  if (Math.abs(ageMs) > FRESHNESS_WINDOW_MS) {
    return {
      status: "expired",
      reason: `Stamp expired. Age: ${ageMs}ms, window: ${FRESHNESS_WINDOW_MS}ms`,
    };
  }

  return { status: "verified", actorId, instanceId };
}

export interface StampedAuthor {
  actorId: string;
  instanceId: string;
}

export interface StampAnomaly {
  detail: "migration" | "foreign_instance" | "expired" | "unverifiable";
  actorId?: string;
  reason?: string;
  body: string;
}

/**
 * Resolves the verified stamped author of a webhook event, or null when the event carries
 * no author we can vouch for (non-bot sender, no repo/number, bodiless event, unstamped,
 * foreign, expired, or unverifiable). Null means fail open: the caller delivers.
 *
 * This owns the pairing of "which body may speak for this sender" with "is that body's
 * stamp valid". Keeping the two together is the point — resolving the body at the call site
 * is what let the directive fallback chain leak into authorship .
 *
 * `localInstanceId` (this process's own instance handle) is threaded through to
 * verifyAuthorStamp so a stamp from another instance sharing the same bot login is
 * recognized as `foreign` — never HMAC-compared, never called a forgery (#201).
 */
export function resolveStampedAuthor(opts: {
  event: string;
  action: string | undefined;
  payload: Record<string, unknown>;
  sender: string | undefined;
  botLogin: string | undefined;
  repoFullName: string | undefined;
  number: number | undefined;
  localInstanceId?: string;
  onAnomaly?: (anomaly: StampAnomaly) => void;
}): StampedAuthor | null {
  const { event, action, payload, sender, botLogin, repoFullName, number, localInstanceId } = opts;
  if (botLogin == null || sender?.toLowerCase() !== botLogin) return null;
  if (!repoFullName || number == null) return null;

  const body = authorStampBodyForWebhookPayload(event, action, payload);
  const verification = verifyAuthorStamp(body, repoFullName, number, localInstanceId);

  if (verification.status === "verified" && verification.actorId && verification.instanceId) {
    return { actorId: verification.actorId, instanceId: verification.instanceId };
  }
  if (verification.status === "migration") {
    opts.onAnomaly?.({
      detail: "migration",
      actorId: verification.actorId,
      body: `Unversioned stamp (actor: ${verification.actorId}) on ${repoFullName}#${number}. Expected migration; delivering event.`,
    });
  } else if (verification.status === "foreign") {
    opts.onAnomaly?.({
      detail: "foreign_instance",
      actorId: verification.actorId,
      body: `Foreign-instance stamp (actor: ${verification.actorId}, instance: ${verification.instanceId}) on ${repoFullName}#${number}. Not ours; delivering event.`,
    });
  } else if (verification.status === "expired") {
    opts.onAnomaly?.({
      detail: "expired",
      actorId: verification.actorId,
      reason: verification.reason,
      body: `Expired stamp on ${repoFullName}#${number}: ${verification.reason}. Delivering event.`,
    });
  } else if (verification.status === "unverifiable") {
    opts.onAnomaly?.({
      detail: "unverifiable",
      actorId: verification.actorId,
      reason: verification.reason,
      body: `Unverifiable stamp on ${repoFullName}#${number}: ${verification.reason}. Delivering event.`,
    });
  }
  return null;
}

export const HUMAN_OPERATOR = "human:operator";
export const MESH_SYSTEM = "system:mesh";

export function isHumanOperator(actorId: string): boolean {
  return actorId.startsWith("human:");
}

/**
 * A `system:*` actor id marks a persistence-only write performed by mesh
 * infrastructure itself (e.g. system background tasks) rather than by a peer actor.
 * Used by ActorMesh.deliverEvent to withhold such events from every
 * destination, not just the actor that would match on author identity — see
 * the mesh-wide suppression rule there. Only a VERIFIED stamp may rely on
 * this (the caller must have gone through verifyAuthorStamp/resolveStampedAuthor);
 * an unverified or stale system-looking stamp must still fail open and deliver.
 */
export function isSystemActor(actorId: string): boolean {
  return actorId.startsWith("system:");
}
