/**
 * Deterministic markdown → speakable-text cleanup for reply TTS .
 * Actors write for the eye (fences, links, headings); the walkie channel reads
 * for the ear. Simple regex passes, intentionally NOT an LLM rewrite — the
 * "written for the ear" style comes from the memo marker convention, this just
 * keeps the synthesizer from reading URL soup and backticks aloud.
 */

/** Strip markdown structure down to plain speakable sentences. */
export function speakableText(markdown: string): string {
  let text = markdown;
  // Fenced code blocks: content is unreadable aloud — replace with a marker.
  text = text.replace(/```[\s\S]*?```/g, " (code omitted) ");
  // Inline code: keep the inner text, drop the backticks.
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Images before links (same bracket syntax): speak the alt text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: speak the label, never the URL.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs (and autolinks) are noise on the ear.
  text = text.replace(/<(https?:\/\/[^>]+)>/g, " (link) ");
  text = text.replace(/https?:\/\/\S+/g, " (link) ");
  // Headings, blockquotes, list bullets at line starts.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // Emphasis/strong/strikethrough markers around words.
  text = text.replace(/(\*\*|__|\*|_|~~)(\S(?:[^*_~]*\S)?)\1/g, "$2");
  // Table/rule syntax reads as garbage.
  text = text.replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, " "));
  text = text.replace(/^\s*[-=_*]{3,}\s*$/gm, " ");
  // Collapse whitespace runs left behind by the removals.
  return text.replace(/\s+/g, " ").trim();
}
