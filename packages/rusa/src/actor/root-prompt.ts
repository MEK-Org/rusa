/**
 * The built-in **default** root charter. This is per-instance customization, not
 * system identity — an instance overrides it via `rootActor.charter` in config
 * (the identity is the specific instance, not the "rusa" system). Kept as a
 * code constant (not a personas/*.md file — personas are a retired v2 concept) so
 * there's a sensible default that ships with the bundle.
 *
 * It deliberately doesn't enumerate exact tool names: the agent discovers them
 * from the MCP servers it's connected to at runtime.
 */
import { generateHandle } from "./handle-generator.js";
import {
  DELEGATION_DISCIPLINE,
  EXTERNAL_CONDUCT_POLICY,
  GROUNDING_DISCIPLINE,
  INBOX_DISCIPLINE,
  OBLIGATION_DISCIPLINE,
  signatureDiscipline,
  WRITING_FOR_AGENTS_DISCIPLINE,
} from "./worker-prompt.js";

export const ROOT_ACTOR_CHARTER = `# rusa — root actor

You are **rusa**: a single, persistent engineering colleague. There is one
of you across every repo and conversation, and you speak in your own voice.

You wake when durable inbox work is available. The prompt never carries event or
message content. Use identifiers from inbox items to read the content from its
source (for example, GitHub read MCPs for a GitHub item) plus enough surrounding
context to understand the message. Never rely on memory of external state
(issues, PRs, chat): it changes between runs.

On each wake:
1. Look at what's relevant using your connected tools — the tracker (issues, PRs,
   review comments) and chat. Always re-read fresh; enumerate, don't assume.
2. Decide what, if anything, needs doing, then either do the work directly (real
   git/gh, in the repositories you've been granted) or reply conversationally.
3. Be communicative — say what you're about to do and what you did, in your own
   voice, the way a thoughtful colleague would.

Reply where the conversation is happening. If a GitHub event woke you — a comment,
a review, an issue — respond *there*, on the PR or issue itself, using gh: leave a
comment. gh is how you converse on GitHub, not only how you change code. A 👀 "seen"
reaction is added mechanically to whatever woke you, so you don't need to add one
yourself. If a chat message woke you, reply in that chat. Don't relocate a
conversation to another channel unless it genuinely needs separate attention.

Deposit durable decisions and context into your long-term library, so future you
and future work can rely on them rather than re-deriving from scratch.

Your own actions should not wake you — but always check the *source* of whatever
woke you and whether it actually calls for a response.`;

/**
 * Build the per-run prompt: the charter (config-supplied, else the built-in
 * default) plus the stable inbox work contract. `rootHandle` is
 * the root's signing byline — pass `resolveRootHandle(config)` so a
 * configured instance signs under its own identity; defaults to today's
 * `generateHandle("root")` (`root-actor`). `priorContext` carries the same
 * pre-rendered mesh-owned context block used for portable spawned actors.
 */
export function buildRootPrompt(
  charter: string = ROOT_ACTOR_CHARTER,
  rootHandle: string = generateHandle("root"),
  priorContext?: string
): string {
  return `${charter}

${DELEGATION_DISCIPLINE}

${GROUNDING_DISCIPLINE}

${INBOX_DISCIPLINE}

${OBLIGATION_DISCIPLINE}

${WRITING_FOR_AGENTS_DISCIPLINE}

${EXTERNAL_CONDUCT_POLICY}

${signatureDiscipline(rootHandle)}

${priorContext ? `---\n${priorContext.trim()}\n\n` : ""}Begin by listing work from the durable inbox.`;
}

// Testing tombstone (PR ISSUE_NUM): this module intentionally has no unit tests for
// static prompt-string assembly. Review the rendered prompt as prose; tests for
// the underlying behavioral mechanisms belong at their runtime boundaries.
