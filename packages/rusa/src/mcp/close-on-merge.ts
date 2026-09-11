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

const DIRECTIVE_PREFIX = /^mesh:close-on-merge/i;
const DIRECTIVE_GRAMMAR = /^mesh:close-on-merge(?:[ \t]+#[1-9]\d*)+[ \t]*$/;

function maskMarkdownCode(body: string): string {
  const masked = body.split("");
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (masked[index] !== "\r" && masked[index] !== "\n") masked[index] = " ";
    }
  };

  for (let index = 0; index < body.length; ) {
    const fence =
      (index === 0 || body[index - 1] === "\n") &&
      body.slice(index).match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/);
    if (fence) {
      const marker = fence[1];
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?$`);
      let end = index + fence[0].length;
      while (end < body.length) {
        const nextLineEnd = body.indexOf("\n", end);
        const lineEnd = nextLineEnd === -1 ? body.length : nextLineEnd;
        if (closing.test(body.slice(end, lineEnd))) {
          end = nextLineEnd === -1 ? lineEnd : nextLineEnd + 1;
          break;
        }
        end = nextLineEnd === -1 ? body.length : nextLineEnd + 1;
      }
      mask(index, end);
      index = end;
      continue;
    }

    if (body[index] === "`") {
      let markerEnd = index;
      while (body[markerEnd] === "`") markerEnd++;
      const markerLength = markerEnd - index;
      let closingStart = markerEnd;
      while (closingStart < body.length) {
        if (body[closingStart] !== "`") {
          closingStart++;
          continue;
        }
        let closingEnd = closingStart;
        while (body[closingEnd] === "`") closingEnd++;
        if (closingEnd - closingStart === markerLength) {
          mask(index, closingEnd);
          index = closingEnd;
          break;
        }
        closingStart = closingEnd;
      }
      if (closingStart >= body.length) index = markerEnd;
      continue;
    }

    index++;
  }

  return masked.join("");
}

function htmlComments(body: string): HtmlComment[] {
  const comments: HtmlComment[] = [];
  const executableBody = maskMarkdownCode(body);
  const commentRe = /<!--([\s\S]*?)(-->|$)/g;
  for (const match of executableBody.matchAll(commentRe)) {
    const start = match.index ?? 0;
    comments.push({
      body: match[1],
      source: body.slice(start, start + match[0].length),
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
