import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorStampBodyForWebhookPayload,
  HUMAN_OPERATOR,
  isHumanOperator,
  isSystemActor,
  MESH_SYSTEM,
  parseAuthor,
  resolveStampedAuthor,
  type StampAnomaly,
  stampAuthor,
  stripAuthorStamps,
  verifyAuthorStamp,
} from "./stamp.js";

describe("Author Identity Stamp Security & HMAC Verification", () => {
  const repo = "dummy-org/dummy-repo";
  const issueNumber = 745;
  const actorId = "peppy-harbor-seal";
  const instanceId = "ember-familiar";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should successfully verify a valid signed stamp generated in the same process", () => {
    const stamp = stampAuthor(actorId, repo, issueNumber, instanceId);
    const body = `Some PR/comment content\n\n${stamp}`;

    const res = verifyAuthorStamp(body, repo, issueNumber);
    expect(res.status).toBe("verified");
    expect(res.actorId).toBe(actorId);
    expect(res.instanceId).toBe(instanceId);
  });

  it("should successfully verify a valid v3 repo-scoped stamp for any issue in the repo", () => {
    const stamp = stampAuthor(actorId, repo, undefined, instanceId);

    expect(verifyAuthorStamp(stamp, repo, issueNumber)).toEqual({
      status: "verified",
      actorId,
      instanceId,
    });
    expect(verifyAuthorStamp(stamp, repo, 999)).toEqual({
      status: "verified",
      actorId,
      instanceId,
    });
  });

  it("should return status 'none' when no stamp is present in the body", () => {
    const body = "Some PR/comment content without any stamp";
    const res = verifyAuthorStamp(body, repo, issueNumber);
    expect(res.status).toBe("none");
  });

  it("should return status 'invalid' on bad HMAC signature", () => {
    const validStamp = stampAuthor(actorId, repo, issueNumber);
    // Tamper with the HMAC portion (last hex word before -->)
    const tamperedStamp = validStamp.replace(/[0-9a-fA-F]{64}\s*-->/, `${"a".repeat(64)} -->`);
    const body = `Hello world\n\n${tamperedStamp}`;

    const res = verifyAuthorStamp(body, repo, issueNumber);
    expect(res.status).toBe("invalid");
    expect(res.reason).toContain("HMAC mismatch");
  });

  it("should return status 'invalid' on a stale timestamp (older than 15 minutes)", () => {
    const nowTime = 1717171717000;
    vi.setSystemTime(new Date(nowTime));

    const stamp = stampAuthor(actorId, repo, issueNumber);

    // Fast-forward time by 16 minutes (960,000 ms)
    vi.setSystemTime(new Date(nowTime + 16 * 60 * 1000));

    const res = verifyAuthorStamp(stamp, repo, issueNumber);
    expect(res.status).toBe("invalid");
    expect(res.reason).toContain("Stamp expired");
  });

  it("should return status 'invalid' on context mismatch (different repo or issue number)", () => {
    const stamp = stampAuthor(actorId, repo, issueNumber);

    // Verify under a different repo
    const resDifferentRepo = verifyAuthorStamp(stamp, "other/repo", issueNumber);
    expect(resDifferentRepo.status).toBe("invalid");
    expect(resDifferentRepo.reason).toContain("HMAC mismatch");

    // Verify under a different issue number
    const resDifferentIssue = verifyAuthorStamp(stamp, repo, 999);
    expect(resDifferentIssue.status).toBe("invalid");
    expect(resDifferentIssue.reason).toContain("HMAC mismatch");
  });

  it("should return status 'invalid' when a v3 stamp is verified under a different repo", () => {
    const stamp = stampAuthor(actorId, repo, undefined, instanceId);

    const res = verifyAuthorStamp(stamp, "other/repo", issueNumber);

    expect(res.status).toBe("invalid");
    expect(res.reason).toContain("HMAC mismatch");
  });

  it("should return status 'migration' for old unversioned stamps", () => {
    const oldStamp = `<!-- mesh:author ${actorId} -->`;
    const res = verifyAuthorStamp(oldStamp, repo, issueNumber);
    expect(res.status).toBe("migration");
    expect(res.actorId).toBe(actorId);
  });

  it("should parse the correct author using parseAuthor (preferring latest stamp)", () => {
    const body = `Some text <!-- mesh:author victim --> middle <!-- mesh:author:v2 ${actorId} ${instanceId} 12345 abcde --> end`;
    expect(parseAuthor(body)).toBe(actorId);
  });

  describe("Unified Stamp Module Identity Parity (Soft-v1)", () => {
    it("should produce and parse unversioned plaintext stamp for human:operator and actor id", () => {
      const humanStamp = stampAuthor(HUMAN_OPERATOR);
      expect(humanStamp).toBe(`<!-- mesh:author ${HUMAN_OPERATOR} -->`);
      expect(parseAuthor(humanStamp)).toBe(HUMAN_OPERATOR);
      expect(isHumanOperator(HUMAN_OPERATOR)).toBe(true);
      expect(isHumanOperator("human:evil")).toBe(true);

      const actorStamp = stampAuthor("some-actor");
      expect(actorStamp).toBe("<!-- mesh:author some-actor -->");
      expect(parseAuthor(actorStamp)).toBe("some-actor");
      expect(isHumanOperator("some-actor")).toBe(false);
    });
  });

  describe("isSystemActor ", () => {
    it("recognizes the system: prefix, including MESH_SYSTEM", () => {
      expect(isSystemActor(MESH_SYSTEM)).toBe(true);
      expect(isSystemActor("system:mesh")).toBe(true);
      expect(isSystemActor("system:anything")).toBe(true);
    });

    it("rejects non-system actor ids, including human: and plain actor ids", () => {
      expect(isSystemActor(HUMAN_OPERATOR)).toBe(false);
      expect(isSystemActor("some-actor")).toBe(false);
      expect(isSystemActor("systemic-actor")).toBe(false);
      expect(isSystemActor("")).toBe(false);
    });
  });

  describe("system stamp round-trip ", () => {
    it("stampAuthor + verifyAuthorStamp round-trips MESH_SYSTEM through the v2 path", () => {
      const stamp = stampAuthor(MESH_SYSTEM, repo, issueNumber, instanceId);
      const body = `Some system comment\n\n${stamp}`;

      const res = verifyAuthorStamp(body, repo, issueNumber);
      expect(res.status).toBe("verified");
      expect(res.actorId).toBe(MESH_SYSTEM);
      expect(res.instanceId).toBe(instanceId);
      expect(isSystemActor(res.actorId as string)).toBe(true);
    });

    it("round-trips through resolveStampedAuthor for a bot-sent comment", () => {
      const botLogin = "rusabot";
      const stamp = stampAuthor(MESH_SYSTEM, repo, issueNumber, instanceId);
      const resolved = resolveStampedAuthor({
        event: "issue_comment",
        action: "created",
        payload: { comment: { body: `system note\n\n${stamp}` } },
        sender: "RusaBot",
        botLogin,
        repoFullName: repo,
        number: issueNumber,
      });
      expect(resolved).toEqual({ actorId: MESH_SYSTEM, instanceId });
    });
  });
});

describe("authorStampBodyForWebhookPayload ", () => {
  const stamped = { body: "text <!-- mesh:author:v2 a i 1 ab -->" };

  it("reads the created body for each creation event", () => {
    expect(authorStampBodyForWebhookPayload("issue_comment", "created", { comment: stamped })).toBe(
      stamped.body
    );
    expect(
      authorStampBodyForWebhookPayload("pull_request_review_comment", "created", {
        comment: stamped,
      })
    ).toBe(stamped.body);
    expect(
      authorStampBodyForWebhookPayload("pull_request_review", "submitted", { review: stamped })
    ).toBe(stamped.body);
    expect(authorStampBodyForWebhookPayload("issues", "opened", { issue: stamped })).toBe(
      stamped.body
    );
    expect(
      authorStampBodyForWebhookPayload("pull_request", "opened", { pull_request: stamped })
    ).toBe(stamped.body);
  });

  it("never borrows a parent body for a bodiless event", () => {
    for (const action of ["labeled", "closed", "reopened", "synchronize", "assigned"]) {
      expect(
        authorStampBodyForWebhookPayload("pull_request", action, {
          pull_request: stamped,
          issue: stamped,
        })
      ).toBeNull();
    }
    expect(
      authorStampBodyForWebhookPayload("check_run", "completed", { pull_request: stamped })
    ).toBeNull();
  });

  it("reads the edited body for issue/PR BODY edits, which update_body re-stamps ", () => {
    const bodyChanged = { body: { from: "previous text" } };
    expect(
      authorStampBodyForWebhookPayload("issues", "edited", {
        issue: stamped,
        changes: bodyChanged,
      })
    ).toBe(stamped.body);
    expect(
      authorStampBodyForWebhookPayload("pull_request", "edited", {
        pull_request: stamped,
        changes: bodyChanged,
      })
    ).toBe(stamped.body);
  });

  it("ignores a native edit that did NOT touch the body ", () => {
    // A title-only edit leaves the body — and its stamp — untouched. Reading it would
    // attribute the edit to whoever wrote the body and suppress the event for them.
    expect(
      authorStampBodyForWebhookPayload("issues", "edited", {
        issue: stamped,
        changes: { title: { from: "old title" } },
      })
    ).toBeNull();
    expect(
      authorStampBodyForWebhookPayload("pull_request", "edited", {
        pull_request: stamped,
        changes: { title: { from: "old title" } },
      })
    ).toBeNull();
  });

  it("fails open on a poller-synthesized edit, which carries no `changes` ", () => {
    // github/poller.ts emits action "edited" for ANY updatedAt bump (a label, a close, a
    // new comment) with no `changes` object and `sender` set to the artifact author. It
    // cannot prove a body edit, so it must be delivered rather than suppressed.
    expect(authorStampBodyForWebhookPayload("issues", "edited", { issue: stamped })).toBeNull();
    expect(
      authorStampBodyForWebhookPayload("pull_request", "edited", { pull_request: stamped })
    ).toBeNull();
  });

  it("still ignores COMMENT edits, which no write path re-stamps ", () => {
    // update_body replaces an issue/PR body by issueNumber; there is no comment-edit tool.
    // An edited comment therefore still carries the original commenter's stamp, so reading
    // it would suppress the event for the writer instead of the editor.
    expect(
      authorStampBodyForWebhookPayload("issue_comment", "edited", { comment: stamped })
    ).toBeNull();
    expect(
      authorStampBodyForWebhookPayload("pull_request_review_comment", "edited", {
        comment: stamped,
      })
    ).toBeNull();
  });

  it("does not suppress an author when ANOTHER actor acts on their fresh issue ", () => {
    // The end-to-end shape of the failure, at the predicate that matters. Actor A opens a
    // freshly stamped issue; actor B labels it; the poller turns that into `issues.edited`
    // carrying A's untouched body and a bot sender. Suppressing here would deafen A to an
    // event B caused — root's bar is that no foreign edit is ever suppressed.
    const repo = "dummy-org/dummy-repo";
    const issueNumber = 4242;
    const stamp = stampAuthor("actor-a", repo, issueNumber, "instance-a");

    expect(
      resolveStampedAuthor({
        event: "issues",
        action: "edited",
        payload: { issue: { body: `A's issue body\n\n${stamp}` } },
        sender: "RusaBot",
        botLogin: "rusabot",
        repoFullName: repo,
        number: issueNumber,
      })
    ).toBeNull();

    // ...while a genuine body edit by A still resolves to A, so the ISSUE_NUM fix stays live.
    expect(
      resolveStampedAuthor({
        event: "issues",
        action: "edited",
        payload: {
          issue: { body: `A's issue body\n\n${stamp}` },
          changes: { body: { from: "previous text" } },
        },
        sender: "RusaBot",
        botLogin: "rusabot",
        repoFullName: repo,
        number: issueNumber,
      })
    ).toEqual({ actorId: "actor-a", instanceId: "instance-a" });
  });
});

describe("stripAuthorStamps ", () => {
  const repo = "dummy-org/dummy-repo";
  const issueNumber = 1341;

  it("removes every stamp form, not just the current one", () => {
    const body = [
      "real content",
      "<!-- mesh:author legacy-actor -->",
      "<!-- mesh:author:v1 v1-actor 111 aabb -->",
      "<!-- mesh:author:v2 v2-actor inst 222 ccdd -->",
      "<!-- mesh:author:v3 v3-actor inst 333 eeff -->",
    ].join("\n\n");

    const stripped = stripAuthorStamps(body);

    expect(stripped).toBe("real content");
    expect(parseAuthor(stripped)).toBeNull();
  });

  it("leaves an unstamped body's content untouched", () => {
    expect(stripAuthorStamps("just a body")).toBe("just a body");
  });

  it("reduces a body to empty when it was nothing but a stamp", () => {
    expect(stripAuthorStamps("<!-- mesh:author:v2 a i 1 ab -->")).toBe("");
  });

  it("re-stamping resolves to the EDITOR, not the original author (the ISSUE_NUM fix)", () => {
    // The exact sequence update_body performs: an already-stamped body is stripped, then
    // stamped by whoever is editing. Verification must name the editor.
    const original = `content\n\n${stampAuthor("original-author", repo, issueNumber, "inst")}`;
    const edited = `${stripAuthorStamps(original)}\n\n${stampAuthor("editing-actor", repo, issueNumber, "inst")}`;

    const result = verifyAuthorStamp(edited, repo, issueNumber);

    expect(result.status).toBe("verified");
    expect(result.actorId).toBe("editing-actor");
    // Exactly one stamp survives, so no cross-version last-index comparison can pick another.
    expect(edited.match(/mesh:author/g)).toHaveLength(1);
  });

  it("strips a LATER older-form stamp that would otherwise win the index comparison", () => {
    // verifyAuthorStamp compares last-match indices across versions, so an older-form stamp
    // positioned after a newer one wins. Stripping all forms is what prevents that.
    const body = `content\n\n${stampAuthor("v2-actor", repo, issueNumber, "inst")}\n\n<!-- mesh:author:v1 stale-actor 1 aabb -->`;
    expect(parseAuthor(body)).toBe("stale-actor");

    const restamped = `${stripAuthorStamps(body)}\n\n${stampAuthor("editing-actor", repo, issueNumber, "inst")}`;
    expect(parseAuthor(restamped)).toBe("editing-actor");
  });
});

describe("resolveStampedAuthor ", () => {
  const repo = "dummy-org/dummy-repo";
  const botLogin = "rusabot";
  const actorId = "puffy-weasel";
  const instanceId = "prod";
  const number = 1018;

  const resolve = (
    event: string,
    action: string,
    payload: Record<string, unknown>,
    sender = "RusaBot",
    onAnomaly?: (a: StampAnomaly) => void
  ) =>
    resolveStampedAuthor({
      event,
      action,
      payload,
      sender,
      botLogin,
      repoFullName: repo,
      number,
      onAnomaly,
    });

  const stampedBody = (text: string) =>
    `${text}\n\n${stampAuthor(actorId, repo, number, instanceId)}`;

  it("verifies the author of a stamped comment", () => {
    expect(resolve("issue_comment", "created", { comment: { body: stampedBody("hi") } })).toEqual({
      actorId,
      instanceId,
    });
  });

  it("verifies the author of a stamped issue at creation", () => {
    expect(resolve("issues", "opened", { issue: { body: stampedBody("filed") } })).toEqual({
      actorId,
      instanceId,
    });
  });

  it("verifies the author of a v3 stamped issue at creation", () => {
    const issueBody = `filed\n\n${stampAuthor(actorId, repo, undefined, instanceId)}`;

    expect(resolve("issues", "opened", { issue: { body: issueBody } })).toEqual({
      actorId,
      instanceId,
    });
  });

  // The ISSUE_NUM defect: a bodiless event borrowed its parent's stamp, so merging a worker's
  // stamped PR was attributed to the worker and suppressed — the worker never learned.
  it("attributes no author to a bodiless event on a stamped PR", () => {
    const pull_request = { body: stampedBody("my PR") };
    expect(resolve("pull_request", "closed", { pull_request })).toBeNull();
    expect(resolve("pull_request", "labeled", { pull_request })).toBeNull();
    expect(resolve("pull_request", "synchronize", { pull_request })).toBeNull();
  });

  it("attributes no author to a comment-less event on a stamped issue", () => {
    expect(resolve("issues", "labeled", { issue: { body: stampedBody("filed") } })).toBeNull();
  });

  it("attributes no author to a non-bot sender even when the body is stamped", () => {
    expect(
      resolve("issue_comment", "created", { comment: { body: stampedBody("hi") } }, "AlabasterAxe")
    ).toBeNull();
  });

  it("fails open on an unstamped body", () => {
    expect(resolve("issue_comment", "created", { comment: { body: "plain" } })).toBeNull();
  });

  it("fails open and reports an anomaly on a forged stamp", () => {
    const forged = stampedBody("hi").replace(/[0-9a-fA-F]{64}\s*-->/, `${"a".repeat(64)} -->`);
    const anomalies: StampAnomaly[] = [];
    expect(
      resolve("issue_comment", "created", { comment: { body: forged } }, "RusaBot", (a) =>
        anomalies.push(a)
      )
    ).toBeNull();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].detail).toBe("forgery");
  });

  it("fails open and reports an anomaly on an unversioned stamp", () => {
    const anomalies: StampAnomaly[] = [];
    expect(
      resolve(
        "issue_comment",
        "created",
        { comment: { body: `hi <!-- mesh:author ${actorId} -->` } },
        "RusaBot",
        (a) => anomalies.push(a)
      )
    ).toBeNull();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].detail).toBe("migration");
    expect(anomalies[0].actorId).toBe(actorId);
  });
});
