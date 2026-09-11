/**
 * The only PR-body syntax that opts an issue into automatic closure after a
 * staging merge. A body can carry one directive with one or more canonical,
 * positive issue numbers:
 *
 * <!-- mesh:close-on-merge #123 #456 -->
 *
 * This parser deliberately does not inspect GitHub closing-keyword prose.
 */
export type CloseOnMergeDirective =
  | { kind: "absent" }
  | { kind: "close"; issueNumbers: number[] }
  | { kind: "malformed"; reason: string };

type HtmlComment = { body: string; source: string; terminated: boolean };

const DIRECTIVE_PREFIX = /^mesh:close-on-merge(?=$|[\s:])/i;
const DIRECTIVE_GRAMMAR = /^mesh:close-on-merge(?:[ \t]+#[1-9]\d*)+[ \t]*$/;

function htmlComments(body: string): HtmlComment[] {
  const comments: HtmlComment[] = [];
  const commentRe = /<!--([\s\S]*?)(-->|$)/g;
  for (const match of body.matchAll(commentRe)) {
    comments.push({
      body: match[1],
      source: match[0],
      terminated: match[2] === "-->",
    });
  }
  return comments;
}

export function parseCloseOnMergeDirective(body: string | null | undefined): CloseOnMergeDirective {
  if (!body) return { kind: "absent" };

  const directives = htmlComments(body).filter((comment) =>
    DIRECTIVE_PREFIX.test(comment.body.trim())
  );
  if (!directives.length) return { kind: "absent" };
  if (directives.length !== 1) {
    return {
      kind: "malformed",
      reason: "expected at most one mesh:close-on-merge directive",
    };
  }

  const directive = directives[0];
  const content = directive.body.trim();
  if (!directive.terminated || /[\r\n]/.test(directive.body) || !DIRECTIVE_GRAMMAR.test(content)) {
    return {
      kind: "malformed",
      reason: `invalid mesh:close-on-merge directive: ${directive.source}`,
    };
  }

  const issueNumbers = [
    ...new Set(
      content
        .split(/[ \t]+/)
        .slice(1)
        .map((ref) => Number(ref.slice(1)))
    ),
  ];
  if (!issueNumbers.every(Number.isSafeInteger)) {
    return {
      kind: "malformed",
      reason: "mesh:close-on-merge issue numbers must be safe positive integers",
    };
  }
  return { kind: "close", issueNumbers };
}
