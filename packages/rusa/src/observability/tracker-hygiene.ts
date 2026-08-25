import type {
  IssueClient,
  IssueComment,
  OpenIssue,
  OpenPullRequest,
} from "../gitops/issue-client.js";
import { SYSTEM_TRACKER_HYGIENE, stampAuthor } from "../mcp/stamp.js";

export interface TrackerHygieneThresholds {
  staleAfterMs: number;
  closeAfterMs: number;
  pingBackoffMs: number[];
}

export interface TrackerHygieneOptions {
  repo: string;
  areaStewardHandle: string;
  automationAuthor?: string;
  closeAction?: "log" | "close";
  now?: Date;
  thresholds?: Partial<TrackerHygieneThresholds>;
  log?: (message: string) => void;
  /**
   * Instance id baked into the v2 author stamp appended to every posted
   * comment (matches the `instanceId` passed to `mesh.deliverEvent` for this
   * instance, e.g. `rootHandle` in start.ts) — required for
   * ActorMesh.deliverEvent's system-suppression rule to recognize the stamp
   * as this instance's own write .
   */
  instanceId?: string;
}

export interface MeshNotifier {
  resolveHandle(handle: string): string | null;
  sendMessage(
    toId: string,
    body: string
  ): { delivered: true } | { delivered: false; status?: string };
}

export interface TrackerHygieneAction {
  kind: "surface_unowned" | "ping_stale_owner" | "close_stale";
  repo: string;
  number: number;
  artifactKind: "issue" | "pull_request";
  ownerHandle: string | null;
  areaStewardHandle?: string;
  reason: string;
  pingCount?: number;
  staleSince?: string;
  snoozeLapsed?: boolean;
}

interface IssueContext {
  issue: OpenIssue;
  comments: IssueComment[];
}

interface PullRequestContext {
  pullRequest: OpenPullRequest;
  comments: IssueComment[];
}

export const DEFAULT_TRACKER_HYGIENE_THRESHOLDS: TrackerHygieneThresholds = {
  staleAfterMs: 24 * 60 * 60 * 1000,
  closeAfterMs: 7 * 24 * 60 * 60 * 1000,
  pingBackoffMs: [0, 24 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000, 4 * 24 * 60 * 60 * 1000],
};

const OWNER_LABEL_RE = /^owner:([a-z0-9][a-z0-9-]*)$/i;
const UNOWNED_MARKER = "<!-- rusa:owner-needed";
const STALE_MARKER_RE = /<!--\s*rusa:stale-ping\s+staleSince="([^"]+)"\s+ping="(\d+)"\s*-->/;
const CLOSE_MARKER = "<!-- rusa:stale-closed -->";
const SNOOZE_MARKER_RE = /<!--\s*rusa:snooze\s+until="([^"]+)"\s+by="([^"]+)"\s*-->/;
const SNOOZE_ERROR_MARKER_RE = /<!--\s*rusa:snooze-error\s+for="([^"]+)"\s*-->/;
const SNOOZE_COMMAND_RE = /^\/snooze(?:\s+until\s+(.+)|\s+(\S+))$/;
const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export function containsSnoozeCommand(body: string): boolean {
  return body.split("\n").some((line) => SNOOZE_COMMAND_RE.test(line.trim()));
}

export async function runTrackerHygiene(
  issueClient: IssueClient,
  meshNotifier: MeshNotifier | null,
  opts: TrackerHygieneOptions
): Promise<TrackerHygieneAction[]> {
  const [issues, pullRequests] = await Promise.all([
    issueClient.listIssues(opts.repo, { state: "open" }),
    issueClient.getOpenPullRequests(opts.repo),
  ]);
  const issueContexts = await Promise.all(
    issues.map(async (issue) => ({
      issue,
      comments: await issueClient.listIssueComments(opts.repo, issue.number),
    }))
  );
  await recordSnoozeMarkers(
    issueClient,
    opts.repo,
    issueContexts,
    opts.automationAuthor,
    opts.now ?? new Date(),
    opts.instanceId
  );
  const pullRequestContexts = await Promise.all(
    pullRequests.map(async (pullRequest) => ({
      pullRequest,
      comments: await issueClient.listIssueComments(opts.repo, pullRequest.number),
    }))
  );
  const actions = planTrackerHygieneActions({
    repo: opts.repo,
    issues: issueContexts,
    pullRequests: pullRequestContexts,
    areaStewardHandle: opts.areaStewardHandle,
    automationAuthor: opts.automationAuthor,
    now: opts.now,
    thresholds: opts.thresholds,
  });

  for (const action of actions) {
    const openState = await artifactIsOpen(issueClient, opts.repo, action);
    if (!openState.open) {
      (opts.log ?? console.log)(
        `[tracker-hygiene] dropping ${action.kind}#${action.number}: ${openState.reason}`
      );
      continue;
    }

    if (action.kind === "surface_unowned") {
      const body = renderUnownedComment(action);
      await issueClient.postComment(
        opts.repo,
        action.number,
        stampHygieneComment(body, opts.repo, action.number, opts.instanceId)
      );
      notifyHygieneRecipient(action, body, meshNotifier, opts.log);
    } else if (action.kind === "ping_stale_owner") {
      const body = renderStalePingComment(action);
      await issueClient.postComment(
        opts.repo,
        action.number,
        stampHygieneComment(body, opts.repo, action.number, opts.instanceId)
      );
      notifyHygieneRecipient(action, body, meshNotifier, opts.log);
    } else {
      if ((opts.closeAction ?? "log") === "close") {
        const body = renderStaleCloseComment(action);
        await issueClient.postComment(
          opts.repo,
          action.number,
          stampHygieneComment(body, opts.repo, action.number, opts.instanceId)
        );
        notifyHygieneRecipient(action, body, meshNotifier, opts.log);
        await issueClient.closeIssue(opts.repo, action.number);
      } else {
        (opts.log ?? console.log)(
          `would-have-closed #${action.number} (${action.reason}) [+stale-close comment]`
        );
      }
    }
  }

  return actions;
}

function notifyHygieneRecipient(
  action: TrackerHygieneAction,
  body: string,
  meshNotifier: MeshNotifier | null,
  log: ((message: string) => void) | undefined
): void {
  if (!meshNotifier) return;
  const recipientHandle =
    action.ownerHandle ?? (action.kind === "surface_unowned" ? action.areaStewardHandle : null);
  if (!recipientHandle) return;

  const toId = meshNotifier.resolveHandle(recipientHandle);
  if (!toId) {
    (log ?? console.warn)(
      `[tracker-hygiene] no live actor handle resolved for owner:${recipientHandle} on ` +
        `${action.repo}#${action.number}`
    );
    return;
  }

  const message = [
    `Tracker hygiene ${action.kind} for ${action.repo}#${action.number}`,
    "",
    body,
  ].join("\n");
  const result = meshNotifier.sendMessage(toId, message);
  if (!result.delivered) {
    (log ?? console.warn)(
      `[tracker-hygiene] mesh ping to owner:${recipientHandle} (${toId}) for ` +
        `${action.repo}#${action.number} was not delivered; status=${result.status ?? "unknown"}`
    );
  }
}

export function planTrackerHygieneActions(opts: {
  repo: string;
  issues: IssueContext[];
  pullRequests: PullRequestContext[];
  areaStewardHandle: string;
  automationAuthor?: string;
  now?: Date;
  thresholds?: Partial<TrackerHygieneThresholds>;
}): TrackerHygieneAction[] {
  const now = opts.now ?? new Date();
  const thresholds = { ...DEFAULT_TRACKER_HYGIENE_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const actions: TrackerHygieneAction[] = [];

  const openPrIssueNumbers = new Set<number>();
  for (const { pullRequest, comments } of opts.pullRequests) {
    for (const issueNumber of referencedIssueNumbers(pullRequest)) {
      openPrIssueNumbers.add(issueNumber);
    }
    const isBlessPr =
      pullRequest.title.startsWith("Bless ") || pullRequest.headRefName.startsWith("bless-");
    if (
      !isBlessPr &&
      !ownerFromLabels(pullRequest.labels) &&
      !hasUnownedMarker(comments, opts.automationAuthor)
    ) {
      actions.push({
        kind: "surface_unowned",
        repo: opts.repo,
        number: pullRequest.number,
        artifactKind: "pull_request",
        ownerHandle: null,
        areaStewardHandle: opts.areaStewardHandle,
        reason: `Open PR #${pullRequest.number} has no owner:<handle> label.`,
      });
    }
  }

  for (const { issue, comments } of opts.issues) {
    const ownerHandle = ownerFromLabels(issue.labels);
    if (!ownerHandle) {
      if (!hasUnownedMarker(comments, opts.automationAuthor)) {
        actions.push({
          kind: "surface_unowned",
          repo: opts.repo,
          number: issue.number,
          artifactKind: "issue",
          ownerHandle: null,
          areaStewardHandle: opts.areaStewardHandle,
          reason: `Open issue #${issue.number} has no owner:<handle> label.`,
        });
      }
      continue;
    }

    if (openPrIssueNumbers.has(issue.number)) continue;

    const staleState = deriveStaleState(issue, comments, opts.automationAuthor);
    const silenceMs = ageMs(now, staleState.silentSince);
    if (silenceMs < thresholds.staleAfterMs) continue;

    const snooze = findSnoozeMarker(comments, opts.automationAuthor);
    if (snooze && snooze.until.getTime() > now.getTime()) continue;

    if (staleState.pingCount > 0 && silenceMs >= thresholds.closeAfterMs) {
      actions.push({
        kind: "close_stale",
        repo: opts.repo,
        number: issue.number,
        artifactKind: "issue",
        ownerHandle,
        reason: `Issue #${issue.number} has no open PR and has been silent since ${staleState.silentSince}.`,
        pingCount: staleState.pingCount,
        staleSince: staleState.silentSince,
      });
      continue;
    }

    const nextPingIndex = staleState.pingCount;
    const requiredSilenceMs =
      thresholds.pingBackoffMs[Math.min(nextPingIndex, thresholds.pingBackoffMs.length - 1)];
    const lastPingGapMs = staleState.lastPingAt ? ageMs(now, staleState.lastPingAt) : Infinity;
    if (silenceMs >= requiredSilenceMs && lastPingGapMs >= requiredSilenceMs) {
      actions.push({
        kind: "ping_stale_owner",
        repo: opts.repo,
        number: issue.number,
        artifactKind: "issue",
        ownerHandle,
        reason: `Issue #${issue.number} has no open PR and no owner-visible activity since ${staleState.silentSince}.`,
        pingCount: staleState.pingCount + 1,
        staleSince: staleState.silentSince,
        snoozeLapsed: snooze != null && snooze.until.getTime() <= now.getTime(),
      });
    }
  }

  return actions;
}

function ownerFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const match = label.match(OWNER_LABEL_RE);
    if (match) return match[1];
  }
  return null;
}

function referencedIssueNumbers(pr: OpenPullRequest): number[] {
  const numbers = new Set<number>();
  if (pr.issueNumber != null) numbers.add(pr.issueNumber);
  for (const text of [pr.title, pr.body, pr.headRef, pr.headRefName]) {
    for (const match of text.matchAll(/(?:#|issue-)(\d+)/gi)) {
      numbers.add(Number.parseInt(match[1], 10));
    }
  }
  return [...numbers].filter((number) => Number.isFinite(number));
}

function isAutomationComment(comment: IssueComment, automationAuthor: string | undefined): boolean {
  return (
    automationAuthor !== undefined &&
    comment.author.toLowerCase() === automationAuthor.toLowerCase()
  );
}

/**
 * True when a comment is one of the hygiene bot's own markers/receipts rather
 * than genuine activity or an actor-issued command.
 *
 * Every mesh actor — and the hygiene bot itself — posts under the same shared
 * automation login, so the login alone cannot tell an actor-issued `/snooze`
 * apart from the bot's own machinery . The hygiene *markers* are the
 * reliable signal: the bot always stamps its own comments with one, an actor's
 * raw command never carries one. This mirrors the escape hatch `deriveStaleState`
 * already applies when it decides whether a later automation-login comment is
 * genuine activity.
 */
function carriesHygieneMarker(body: string): boolean {
  return (
    body.includes(UNOWNED_MARKER) ||
    STALE_MARKER_RE.test(body) ||
    body.includes(CLOSE_MARKER) ||
    SNOOZE_MARKER_RE.test(body) ||
    SNOOZE_ERROR_MARKER_RE.test(body)
  );
}

function hasUnownedMarker(comments: IssueComment[], automationAuthor: string | undefined): boolean {
  return comments.some(
    (comment) =>
      isAutomationComment(comment, automationAuthor) && comment.body.includes(UNOWNED_MARKER)
  );
}

function deriveStaleState(
  issue: OpenIssue,
  comments: IssueComment[],
  automationAuthor: string | undefined
): { silentSince: string; pingCount: number; lastPingAt: string | null } {
  const pings = comments
    .filter((comment) => isAutomationComment(comment, automationAuthor))
    .map((comment) => {
      const match = comment.body.match(STALE_MARKER_RE);
      if (!match) return null;
      return {
        staleSince: match[1],
        ping: Number.parseInt(match[2], 10),
        createdAt: comment.createdAt,
      };
    })
    .filter(
      (ping): ping is { staleSince: string; ping: number; createdAt: string } => ping !== null
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const lastPing = pings[pings.length - 1];
  if (!lastPing) {
    return { silentSince: issue.updatedAt, pingCount: 0, lastPingAt: null };
  }

  const laterNonAutomation = comments
    .filter((comment) => comment.createdAt > lastPing.createdAt)
    .filter(
      (comment) =>
        !isAutomationComment(comment, automationAuthor) ||
        (!comment.body.includes(UNOWNED_MARKER) &&
          !comment.body.match(STALE_MARKER_RE) &&
          !comment.body.includes(CLOSE_MARKER) &&
          !comment.body.match(SNOOZE_MARKER_RE) &&
          !comment.body.match(SNOOZE_ERROR_MARKER_RE))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (laterNonAutomation) {
    return { silentSince: laterNonAutomation.createdAt, pingCount: 0, lastPingAt: null };
  }

  return {
    silentSince: lastPing.staleSince,
    pingCount: pings.length,
    lastPingAt: lastPing.createdAt,
  };
}

function renderUnownedComment(action: TrackerHygieneAction): string {
  return [
    `${UNOWNED_MARKER} -->`,
    `Ownership needed: this ${action.artifactKind === "issue" ? "issue" : "PR"} has no \`owner:<handle>\` label.`,
    "",
    `Area steward: owner:${action.areaStewardHandle} should assign an owner label so tracker automation can route follow-ups to a person.`,
  ].join("\n");
}

function renderStalePingComment(action: TrackerHygieneAction): string {
  const lines = [
    `<!-- rusa:stale-ping staleSince="${action.staleSince}" ping="${action.pingCount}" -->`,
    `Staleness check ${action.pingCount}: owner:${action.ownerHandle}, this issue has no open PR and has been quiet since ${action.staleSince}.`,
  ];
  if (action.snoozeLapsed) {
    lines.push("Snooze lapsed — re-evaluating.");
  }
  lines.push(
    "",
    "Comment here to reset the clock, or close/reopen if the work has moved elsewhere."
  );
  return lines.join("\n");
}

function renderStaleCloseComment(action: TrackerHygieneAction): string {
  return [
    CLOSE_MARKER,
    `Closed as stale: owner:${action.ownerHandle}, ${action.pingCount ?? 0} ping(s), no open PR, and no owner-visible activity since ${action.staleSince}.`,
    "",
    "Reopen if this is still live.",
  ].join("\n");
}

function ageMs(now: Date, iso: string): number {
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis)) return 0;
  return Math.max(0, now.getTime() - millis);
}

async function artifactIsOpen(
  issueClient: IssueClient,
  repo: string,
  action: TrackerHygieneAction
): Promise<{ open: true } | { open: false; reason: string }> {
  try {
    if (action.artifactKind === "issue") {
      const details = await issueClient.getIssue(repo, action.number);
      return details.state === "open"
        ? { open: true }
        : { open: false, reason: `issue is ${details.state}` };
    } else {
      const details = await issueClient.getPullRequestDetails(repo, action.number);
      return details.state === "open"
        ? { open: true }
        : { open: false, reason: `PR is ${details.state}` };
    }
  } catch (err) {
    return {
      open: false,
      reason: `state check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function recordSnoozeMarkers(
  issueClient: IssueClient,
  repo: string,
  contexts: IssueContext[],
  automationAuthor: string | undefined,
  now: Date,
  instanceId: string | undefined
): Promise<void> {
  for (const { issue, comments } of contexts) {
    const latestCommand = findLatestSnoozeCommand(comments, automationAuthor, now);
    if (!latestCommand) continue;

    const ownerHandle = ownerFromLabels(issue.labels);
    if (!ownerHandle) {
      const existingError = findSnoozeErrorMarker(comments, automationAuthor);
      if (existingError && existingError.createdAt >= latestCommand.createdAt) continue;

      const body = renderUnownedSnoozeErrorComment(latestCommand.raw);
      const stampedBody = stampHygieneComment(body, repo, issue.number, instanceId);
      await issueClient.postComment(repo, issue.number, stampedBody);
      comments.push({
        id: 0,
        author: automationAuthor ?? "",
        body: stampedBody,
        createdAt: now.toISOString(),
      });
      continue;
    }

    const by =
      latestCommand.author.toLowerCase() === ownerHandle.toLowerCase()
        ? `owner:${ownerHandle}`
        : latestCommand.author;

    if (latestCommand.kind === "valid") {
      const existingMarker = findSnoozeMarker(comments, automationAuthor);
      if (existingMarker && existingMarker.createdAt >= latestCommand.createdAt) continue;

      const cappedUntil = capSnooze(latestCommand.until, now);
      const wasCapped = cappedUntil.getTime() !== latestCommand.until.getTime();
      const markerBody = renderSnoozeConfirmationComment(
        cappedUntil,
        by,
        latestCommand.until,
        wasCapped
      );
      const stampedBody = stampHygieneComment(markerBody, repo, issue.number, instanceId);

      // Durable suppression state must be recorded before any success receipt is emitted.
      // A failure here is loud: the whole hygiene scan fails and no receipt is added.
      await issueClient.postComment(repo, issue.number, stampedBody);
      comments.push({
        id: 0,
        author: automationAuthor ?? "",
        body: stampedBody,
        createdAt: now.toISOString(),
      });

      // Success receipt: only emitted after the durable suppression marker is persisted.
      await issueClient.addCommentReaction(repo, latestCommand.commentId, "eyes", "issue");
    } else {
      const existingError = findSnoozeErrorMarker(comments, automationAuthor);
      if (existingError && existingError.createdAt >= latestCommand.createdAt) continue;

      const body = renderSnoozeErrorComment(latestCommand.raw);
      const stampedBody = stampHygieneComment(body, repo, issue.number, instanceId);
      await issueClient.postComment(repo, issue.number, stampedBody);
      comments.push({
        id: 0,
        author: automationAuthor ?? "",
        body: stampedBody,
        createdAt: now.toISOString(),
      });
    }
  }
}

/** Appends the v2 author stamp for `system:tracker-hygiene` to a comment body. */
function stampHygieneComment(
  body: string,
  repo: string,
  issueNumber: number,
  instanceId: string | undefined
): string {
  const stamp = stampAuthor(SYSTEM_TRACKER_HYGIENE, repo, issueNumber, instanceId);
  return body ? `${body}\n\n${stamp}` : stamp;
}

type SnoozeCommandResult =
  | {
      kind: "valid";
      raw: string;
      until: Date;
      author: string;
      createdAt: string;
      commentId: number;
    }
  | { kind: "invalid"; raw: string; author: string; createdAt: string; commentId: number };

function findLatestSnoozeCommand(
  comments: IssueComment[],
  automationAuthor: string | undefined,
  now: Date
): SnoozeCommandResult | null {
  const commands = comments
    // An actor-issued /snooze posts under the shared automation login, so we
    // cannot exclude by login . Skip only the hygiene bot's own
    // marker/receipt comments; honor everything else, including automation-login
    // commands that carry no marker.
    .filter(
      (comment) =>
        !isAutomationComment(comment, automationAuthor) || !carriesHygieneMarker(comment.body)
    )
    .map((comment) => {
      for (const line of comment.body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.match(SNOOZE_COMMAND_RE)) continue;
        const parsed = parseSnoozeCommandLine(trimmed, now);
        if (parsed)
          return {
            kind: "valid" as const,
            raw: trimmed,
            until: parsed.until,
            author: comment.author,
            createdAt: comment.createdAt,
            commentId: comment.id,
          };
        return {
          kind: "invalid" as const,
          raw: trimmed,
          author: comment.author,
          createdAt: comment.createdAt,
          commentId: comment.id,
        };
      }
      return null;
    })
    .filter((cmd): cmd is SnoozeCommandResult => cmd !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return commands[commands.length - 1] ?? null;
}

function parseSnoozeCommandLine(line: string, now: Date): { until: Date } | null {
  const match = line.match(SNOOZE_COMMAND_RE);
  if (!match) return null;
  const arg = (match[1] ?? match[2]).trim();
  if (match[1]) {
    const date = new Date(arg);
    if (!Number.isNaN(date.getTime())) return { until: date };
  } else {
    const ms = parseDurationMs(arg);
    if (ms != null) return { until: new Date(now.getTime() + ms) };
  }
  return null;
}

function parseDurationMs(text: string): number | null {
  const match = text.match(/^(\d+)([dDwW])$/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  if (unit === "w") return value * 7 * 24 * 60 * 60 * 1000;
  return null;
}

function capSnooze(until: Date, now: Date): Date {
  const maxUntil = new Date(now.getTime() + MAX_SNOOZE_MS);
  return until.getTime() > maxUntil.getTime() ? maxUntil : until;
}

function findSnoozeMarker(
  comments: IssueComment[],
  automationAuthor: string | undefined
): { until: Date; by: string; createdAt: string } | null {
  const markers = comments
    .filter((comment) => isAutomationComment(comment, automationAuthor))
    .map((comment) => {
      const match = comment.body.match(SNOOZE_MARKER_RE);
      if (!match) return null;
      const until = new Date(match[1]);
      if (Number.isNaN(until.getTime())) return null;
      return { until, by: match[2], createdAt: comment.createdAt };
    })
    .filter((marker): marker is { until: Date; by: string; createdAt: string } => marker !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return markers[markers.length - 1] ?? null;
}

function findSnoozeErrorMarker(
  comments: IssueComment[],
  automationAuthor: string | undefined
): { raw: string; createdAt: string } | null {
  const markers = comments
    .filter((comment) => isAutomationComment(comment, automationAuthor))
    .map((comment) => {
      const match = comment.body.match(SNOOZE_ERROR_MARKER_RE);
      if (!match) return null;
      return { raw: match[1], createdAt: comment.createdAt };
    })
    .filter((marker): marker is { raw: string; createdAt: string } => marker !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return markers[markers.length - 1] ?? null;
}

function renderSnoozeConfirmationComment(
  effectiveUntil: Date,
  by: string,
  requestedUntil: Date,
  wasCapped: boolean
): string {
  const lines = [
    `<!-- rusa:snooze until="${effectiveUntil.toISOString()}" by="${by}" -->`,
    `Snoozed until ${effectiveUntil.toISOString()} by ${by}.`,
  ];
  if (wasCapped) {
    lines.push(
      `The requested until date (${requestedUntil.toISOString()}) exceeds the 30-day maximum; the snooze was capped to ${effectiveUntil.toISOString()}.`
    );
  }
  lines.push(
    "",
    "Re-snooze with `/snooze <duration>` (e.g. `/snooze 2w`) or `/snooze until <ISO-date>` if needed."
  );
  return lines.join("\n");
}

function renderSnoozeErrorComment(raw: string): string {
  const escaped = raw.replace(/"/g, "&quot;");
  return [
    `<!-- rusa:snooze-error for="${escaped}" -->`,
    `Could not parse \`${raw}\` as a snooze command.`,
    "",
    "Accepted forms:",
    "- `/snooze 2d` or `/snooze 2w` (duration in days or weeks)",
    "- `/snooze until 2026-07-27T00:00:00Z` (ISO date)",
    "",
    "The maximum single snooze is 30 days.",
  ].join("\n");
}

function renderUnownedSnoozeErrorComment(raw: string): string {
  const escaped = raw.replace(/"/g, "&quot;");
  return [
    `<!-- rusa:snooze-error for="${escaped}" -->`,
    `Cannot snooze an unowned issue: \`/snooze\` requires an \`owner:<handle>\` label.`,
    "",
    "Assign an owner label before snoozing so tracker automation knows whose staleness pings to suppress.",
  ].join("\n");
}
