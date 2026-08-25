import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseJsonObjectBody } from "../webhook/server.js";
import type {
  LocalTracker,
  ReviewState,
  TrackerIssue,
  TrackerPr,
  TrackerReview,
} from "./local-tracker.js";

const REVIEW_STATES: ReviewState[] = ["approved", "changes_requested", "commented"];

/**
 * The agent-facing HTTP surface for the local tracker. These are the verbs a
 * driving agent uses in place of the GitHub UI: file an issue, list/inspect
 * issues, comment, close, and read the PRs the orchestrator opened. Mutations
 * flow through {@link LocalTracker}, which emits the in-process intake events.
 *
 * Routes (single configured repo; `<repo>` = `owner/name`):
 *   POST   /repos/<repo>/issues                 { title, body, author?, assign? }
 *   GET    /repos/<repo>/issues
 *   GET    /repos/<repo>/issues/:n
 *   POST   /repos/<repo>/issues/:n/comments     { body, author? }
 *   POST   /repos/<repo>/issues/:n/close
 *   GET    /repos/<repo>/pulls
 *   GET    /repos/<repo>/pulls/:n
 *   GET    /repos/<repo>/pulls/:n/diff            (text/plain; real git diff)
 *   GET    /repos/<repo>/pulls/:n/reviews
 *   POST   /repos/<repo>/pulls/:n/reviews         { state, body?, comments?, author? }
 *
 * See devlog/2026-06-07-self-contained-runner/design.md §5.3.
 */
export interface TrackerServerOptions {
  port: number;
  tracker: LocalTracker;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function serializeIssue(issue: TrackerIssue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    htmlUrl: issue.htmlUrl,
    state: issue.state,
    author: issue.author,
    assignees: issue.assignees,
    labels: issue.labels,
    parent: issue.parent,
    comments: issue.comments,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function serializePr(pr: TrackerPr) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    htmlUrl: pr.htmlUrl,
    headRef: pr.headRef,
    base: pr.base,
    state: pr.state,
    author: pr.author,
    labels: pr.labels,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
  };
}

function serializeReview(review: TrackerReview) {
  return {
    id: review.id,
    prNumber: review.prNumber,
    state: review.state,
    body: review.body,
    author: review.author,
    comments: review.comments,
    createdAt: review.createdAt,
  };
}

export function createTrackerRequestHandler(tracker: LocalTracker) {
  const repoPrefix = `/repos/${tracker.repo}`;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    // Scope every route to the single configured repo.
    if (!pathname.startsWith(`${repoPrefix}/`)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const rest = pathname.slice(repoPrefix.length); // e.g. "/issues/3/comments"
    const parts = rest.split("/").filter(Boolean); // ["issues","3","comments"]

    try {
      // ── Issues ──────────────────────────────────────────────────────────
      if (parts[0] === "issues" && parts.length === 1) {
        if (method === "POST") {
          const parsed = parseJsonObjectBody(await readBody(req));
          if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
          const title = typeof parsed.value.title === "string" ? parsed.value.title.trim() : "";
          const body = typeof parsed.value.body === "string" ? parsed.value.body : "";
          if (!title) return sendJson(res, 400, { error: "Missing 'title'" });
          const author = typeof parsed.value.author === "string" ? parsed.value.author : undefined;
          const assign = parsed.value.assign !== false;
          const issue = await tracker.createIssue({ title, body, author, assign });
          return sendJson(res, 201, serializeIssue(issue));
        }
        if (method === "GET") {
          return sendJson(res, 200, tracker.listIssues().map(serializeIssue));
        }
      }

      if (parts[0] === "issues" && parts.length >= 2) {
        const issueNumber = Number.parseInt(parts[1], 10);
        if (!Number.isFinite(issueNumber)) {
          return sendJson(res, 400, { error: "Invalid issue number" });
        }

        // GET /issues/:n
        if (parts.length === 2 && method === "GET") {
          const issue = tracker.getIssue(issueNumber);
          if (!issue) return sendJson(res, 404, { error: "Issue not found" });
          return sendJson(res, 200, serializeIssue(issue));
        }

        // POST /issues/:n/comments
        if (parts.length === 3 && parts[2] === "comments" && method === "POST") {
          if (!tracker.getIssue(issueNumber)) {
            return sendJson(res, 404, { error: "Issue not found" });
          }
          const parsed = parseJsonObjectBody(await readBody(req));
          if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
          const body = typeof parsed.value.body === "string" ? parsed.value.body : "";
          if (!body.trim()) return sendJson(res, 400, { error: "Missing 'body'" });
          const author = typeof parsed.value.author === "string" ? parsed.value.author : undefined;
          const comment = await tracker.addIssueComment(issueNumber, { body, author });
          return sendJson(res, 201, comment);
        }

        // POST /issues/:n/close
        if (parts.length === 3 && parts[2] === "close" && method === "POST") {
          if (!tracker.getIssue(issueNumber)) {
            return sendJson(res, 404, { error: "Issue not found" });
          }
          await tracker.closeIssue(issueNumber);
          return sendJson(res, 200, { ok: true });
        }
      }

      // ── Pull requests ───────────────────────────────────────────────────
      if (parts[0] === "pulls" && parts.length === 1 && method === "GET") {
        return sendJson(res, 200, tracker.listPrs().map(serializePr));
      }
      if (parts[0] === "pulls" && parts.length >= 2) {
        const prNumber = Number.parseInt(parts[1], 10);
        if (!Number.isFinite(prNumber)) {
          return sendJson(res, 400, { error: "Invalid PR number" });
        }

        // GET /pulls/:n
        if (parts.length === 2 && method === "GET") {
          const pr = tracker.getPr(prNumber);
          if (!pr) return sendJson(res, 404, { error: "Pull request not found" });
          return sendJson(res, 200, serializePr(pr));
        }

        // GET /pulls/:n/diff — the real git diff of the branch against its base.
        if (parts.length === 3 && parts[2] === "diff" && method === "GET") {
          if (!tracker.getPr(prNumber)) {
            return sendJson(res, 404, { error: "Pull request not found" });
          }
          return sendText(res, 200, tracker.getPrDiff(prNumber));
        }

        // GET /pulls/:n/reviews
        if (parts.length === 3 && parts[2] === "reviews" && method === "GET") {
          if (!tracker.getPr(prNumber)) {
            return sendJson(res, 404, { error: "Pull request not found" });
          }
          return sendJson(res, 200, tracker.listReviews(prNumber).map(serializeReview));
        }

        // POST /pulls/:n/reviews — submit a review; emits a pr_review intake event.
        if (parts.length === 3 && parts[2] === "reviews" && method === "POST") {
          if (!tracker.getPr(prNumber)) {
            return sendJson(res, 404, { error: "Pull request not found" });
          }
          const parsed = parseJsonObjectBody(await readBody(req));
          if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
          const state = parsed.value.state;
          if (typeof state !== "string" || !REVIEW_STATES.includes(state as ReviewState)) {
            return sendJson(res, 400, {
              error: `Missing or invalid 'state' (one of: ${REVIEW_STATES.join(", ")})`,
            });
          }
          const body = typeof parsed.value.body === "string" ? parsed.value.body : "";
          const author = typeof parsed.value.author === "string" ? parsed.value.author : undefined;
          const comments = Array.isArray(parsed.value.comments)
            ? (parsed.value.comments as TrackerReview["comments"])
            : undefined;
          const review = await tracker.submitReview(prNumber, {
            state: state as ReviewState,
            body,
            author,
            comments,
          });
          return sendJson(res, 201, serializeReview(review));
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("[tracker] Error handling request:", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
    }
  };
}

export async function startTrackerServer(
  options: TrackerServerOptions
): Promise<{ close: () => Promise<void> }> {
  const { port, tracker } = options;
  const server = createServer(createTrackerRequestHandler(tracker));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      console.log(`[tracker] 🌐 Listening on port ${port}`);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
