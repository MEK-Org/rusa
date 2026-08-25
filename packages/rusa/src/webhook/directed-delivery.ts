const DIRECTED_DELIVERY_RE = /<!--\s*mesh:deliver\s+([^\s<>]+)\s*-->/i;

export function parseDirectedDeliveryDirective(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = DIRECTED_DELIVERY_RE.exec(body);
  return match?.[1] ?? null;
}

export function directiveBodyForWebhookPayload(payload: Record<string, unknown>): string | null {
  const commentBody = (payload.comment as { body?: unknown } | undefined)?.body;
  if (typeof commentBody === "string") return commentBody;

  const reviewBody = (payload.review as { body?: unknown } | undefined)?.body;
  if (typeof reviewBody === "string") return reviewBody;

  const pullRequestBody = (payload.pull_request as { body?: unknown } | undefined)?.body;
  if (typeof pullRequestBody === "string") return pullRequestBody;

  const issueBody = (payload.issue as { body?: unknown } | undefined)?.body;
  if (typeof issueBody === "string") return issueBody;

  return null;
}
