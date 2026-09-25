import type { ChatClient } from "../chat/types.js";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import type { IssueClient } from "../gitops/issue-client.js";
import type { InboxEntry, InboxRepository } from "../repositories/inbox-repository.js";
import type { SlackClient } from "../slack/slack-client.js";
import type { ResolveJevInboxEntry } from "./jev-decision-client.js";

export interface JevInboxTextResolverDeps {
  inbox: Pick<InboxRepository, "read">;
  chatClient?: Pick<ChatClient, "getMessage">;
  slackClient?: Pick<SlackClient, "getMessage">;
  meshChat: Pick<{ getById(id: string): MeshChat | null }, "getById">;
  issueClient: Pick<
    IssueClient,
    | "getIssue"
    | "getPullRequestDetails"
    | "getPrReviewComments"
    | "getPullRequestReview"
    | "listIssueComments"
  >;
}

/**
 * Resolve an inbox row at the host edge just before the opt-in JEV request.
 * This is intentionally a read-only projection: source text is neither added
 * to `inbox_items` nor returned to the scheduler/audit layer.
 */
export function createJevInboxTextResolver(deps: JevInboxTextResolverDeps): ResolveJevInboxEntry {
  return async (actorId, entryId, signal) => {
    signal?.throwIfAborted();
    const entry = deps.inbox.read(actorId, entryId);
    if (!entry) throw new Error("JEV inbox entry was not found");
    const text = await textForEntry(entry, deps, signal);
    signal?.throwIfAborted();
    return { id: entry.id, source: entry.source, text };
  };
}

async function textForEntry(
  entry: InboxEntry,
  deps: JevInboxTextResolverDeps,
  signal?: AbortSignal
): Promise<string> {
  const payload = entry.payload;
  if (payload.type === "gchat.message") {
    const messageName = requiredString(payload.messageName, "Google Chat message name");
    if (!deps.chatClient) throw new Error("Google Chat text is unavailable");
    return (await deps.chatClient.getMessage(messageName)).text ?? "";
  }
  if (payload.type === "slack.message") {
    const channel = requiredString(payload.channel, "Slack channel");
    const ts = requiredString(payload.ts, "Slack message timestamp");
    if (!deps.slackClient) throw new Error("Slack text is unavailable");
    return (await deps.slackClient.getMessage(channel, ts)).text;
  }
  if (payload.type === "mesh.message" || payload.type === "human.message") {
    const messageId = requiredString(payload.messageId, "mesh message id");
    const message = deps.meshChat.getById(messageId);
    if (!message) throw new Error("mesh message text is unavailable");
    return message.body;
  }
  if (entry.source.startsWith("github:")) return githubText(entry, deps, signal);

  // Test and locally-generated payloads may carry literal text. Production
  // integrations use the source-specific reads above; if neither path exists,
  // fail closed instead of treating scheduling metadata as a message.
  if (typeof payload.content === "string") return payload.content;
  throw new Error("inbox source has no readable text");
}

async function githubText(
  entry: InboxEntry,
  deps: JevInboxTextResolverDeps,
  signal?: AbortSignal
): Promise<string> {
  const match = /^github:([^/]+\/[^/]+)\/(issues|pulls)\/([1-9]\d*)$/.exec(entry.source);
  if (!match) throw new Error("GitHub inbox source has no readable issue or pull request");
  const [, repo, collection, numberText] = match;
  const number = Number(numberText);
  const commentId = numberId(entry.payload.commentId);
  const reviewId = numberId(entry.payload.reviewId);
  signal?.throwIfAborted();

  if (commentId !== undefined && entry.payload.type.startsWith("issue_comment.")) {
    const comment = (await deps.issueClient.listIssueComments(repo, number)).find(
      (candidate) => candidate.id === commentId
    );
    if (!comment) throw new Error("GitHub issue comment text is unavailable");
    return comment.body;
  }
  if (commentId !== undefined && entry.payload.type.startsWith("pull_request_review_comment.")) {
    if (collection !== "pulls") throw new Error("GitHub review comment has no pull request source");
    const comment = (await deps.issueClient.getPrReviewComments(repo, number)).find(
      (candidate) => candidate.id === commentId
    );
    if (!comment) throw new Error("GitHub review comment text is unavailable");
    return comment.body;
  }
  if (reviewId !== undefined && entry.payload.type.startsWith("pull_request_review.")) {
    if (collection !== "pulls") throw new Error("GitHub review has no pull request source");
    const review = await deps.issueClient.getPullRequestReview(repo, number, reviewId);
    if (!review) throw new Error("GitHub review text is unavailable");
    return review.body;
  }
  if (collection === "issues") {
    const issue = await deps.issueClient.getIssue(repo, number);
    return `${issue.title}\n\n${issue.body}`;
  }
  const pull = await deps.issueClient.getPullRequestDetails(repo, number);
  return `${pull.title}\n\n${pull.body}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is unavailable`);
  return value.trim();
}

function numberId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
