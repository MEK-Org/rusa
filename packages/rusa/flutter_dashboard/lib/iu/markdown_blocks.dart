/// A deliberately small, dependency-free Markdown parser for the IU node-detail panel
/// (ISSUE_NUM task 3). It is the "simple markdown renderer" starting point — pure Dart (no
/// Flutter imports) so it can be unit-checked headlessly, with [SimpleMarkdown] mapping its
/// output to widgets.
///
/// Supported: ATX headings (`#`..`######`), unordered list items (`-`/`*`/`+`), ordered
/// list items (`1.`), fenced code blocks (```), block quotes (`>`), horizontal rules, and
/// paragraphs. Inline: `**bold**`/`__bold__`, `*italic*`/`_italic_`, `` `code` ``, and
/// `[text](url)` links. No nested emphasis or tables — intentionally; richer rendering can
/// come later.
library;

enum MdBlockType { heading, paragraph, bullet, ordered, code, quote, rule }

class MdBlock {
  final MdBlockType type;

  /// Inline (still-unparsed) content for heading/paragraph/bullet/ordered/quote; the raw
  /// code text for [MdBlockType.code]; empty for [MdBlockType.rule].
  final String text;

  /// Heading level 1–6; 0 for non-headings.
  final int level;

  /// 1-based number for an ordered list item; 0 otherwise.
  final int ordinal;

  /// Fence info string (language) for a code block; null otherwise.
  final String? language;

  const MdBlock(
    this.type,
    this.text, {
    this.level = 0,
    this.ordinal = 0,
    this.language,
  });
}

final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _bullet = RegExp(r'^\s*[-*+]\s+(.*)$');
final _ordered = RegExp(r'^\s*(\d+)\.\s+(.*)$');
final _quote = RegExp(r'^\s*>\s?(.*)$');
final _rule = RegExp(r'^\s*(-{3,}|\*{3,}|_{3,})\s*$');
final _fence = RegExp(r'^\s*```(.*)$');

/// Parses [src] into a flat list of block-level elements. Soft-wrapped paragraph lines are
/// joined with a space; consecutive block-quote lines coalesce into one quote block.
List<MdBlock> parseMarkdownBlocks(String src) {
  final lines = src.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  final blocks = <MdBlock>[];

  final paragraph = <String>[];
  void flushParagraph() {
    if (paragraph.isNotEmpty) {
      blocks.add(MdBlock(MdBlockType.paragraph, paragraph.join(' ').trim()));
      paragraph.clear();
    }
  }

  final quote = <String>[];
  void flushQuote() {
    if (quote.isNotEmpty) {
      blocks.add(MdBlock(MdBlockType.quote, quote.join('\n').trim()));
      quote.clear();
    }
  }

  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];

    final fence = _fence.firstMatch(line);
    if (fence != null) {
      flushParagraph();
      flushQuote();
      final lang = fence.group(1)!.trim();
      final code = <String>[];
      i++;
      while (i < lines.length && _fence.firstMatch(lines[i]) == null) {
        code.add(lines[i]);
        i++;
      }
      // i now sits on the closing fence (or past EOF if unterminated) — fine either way.
      blocks.add(
        MdBlock(
          MdBlockType.code,
          code.join('\n'),
          language: lang.isEmpty ? null : lang,
        ),
      );
      continue;
    }

    // A quote line continues an in-progress quote; anything else flushes it.
    final quoteMatch = _quote.firstMatch(line);
    if (quoteMatch != null) {
      flushParagraph();
      quote.add(quoteMatch.group(1)!);
      continue;
    }
    flushQuote();

    if (line.trim().isEmpty) {
      flushParagraph();
      continue;
    }

    if (_rule.hasMatch(line)) {
      flushParagraph();
      blocks.add(const MdBlock(MdBlockType.rule, ''));
      continue;
    }

    final h = _heading.firstMatch(line);
    if (h != null) {
      flushParagraph();
      blocks.add(
        MdBlock(
          MdBlockType.heading,
          h.group(2)!.trim(),
          level: h.group(1)!.length,
        ),
      );
      continue;
    }

    final o = _ordered.firstMatch(line);
    if (o != null) {
      flushParagraph();
      blocks.add(
        MdBlock(
          MdBlockType.ordered,
          o.group(2)!.trim(),
          ordinal: int.parse(o.group(1)!),
        ),
      );
      continue;
    }

    final b = _bullet.firstMatch(line);
    if (b != null) {
      flushParagraph();
      blocks.add(MdBlock(MdBlockType.bullet, b.group(1)!.trim()));
      continue;
    }

    paragraph.add(line.trim());
  }

  flushParagraph();
  flushQuote();
  return blocks;
}

class MdSpan {
  final String text;
  final bool bold;
  final bool italic;
  final bool code;

  /// Non-null when this span is a link; [text] is the visible label.
  final String? linkUrl;

  const MdSpan(
    this.text, {
    this.bold = false,
    this.italic = false,
    this.code = false,
    this.linkUrl,
  });
}

final _link = RegExp(r'\[([^\]]*)\]\(([^)\s]+)\)');

/// Parses inline Markdown into styled spans. Single-pass, non-nesting: the first marker
/// wins and its run is emitted as one span. Unterminated markers are treated as literal
/// text so nothing is ever dropped.
List<MdSpan> parseInline(String src) {
  final spans = <MdSpan>[];
  final plain = StringBuffer();
  void flushPlain() {
    if (plain.isNotEmpty) {
      spans.add(MdSpan(plain.toString()));
      plain.clear();
    }
  }

  var i = 0;
  while (i < src.length) {
    final rest = src.substring(i);

    // `code`
    if (src[i] == '`') {
      final end = src.indexOf('`', i + 1);
      if (end > i) {
        flushPlain();
        spans.add(MdSpan(src.substring(i + 1, end), code: true));
        i = end + 1;
        continue;
      }
    }

    // **bold** or __bold__
    final boldMarker = rest.startsWith('**')
        ? '**'
        : rest.startsWith('__')
        ? '__'
        : null;
    if (boldMarker != null) {
      final end = src.indexOf(boldMarker, i + 2);
      // Require non-empty content so an unterminated `**` isn't half-consumed by the
      // single-`*` italic branch below (which would drop the markers).
      if (end > i + 2) {
        flushPlain();
        spans.add(MdSpan(src.substring(i + 2, end), bold: true));
        i = end + 2;
        continue;
      }
    }

    // *italic* or _italic_
    if (src[i] == '*' || src[i] == '_') {
      final marker = src[i];
      final end = src.indexOf(marker, i + 1);
      if (end > i + 1) {
        flushPlain();
        spans.add(MdSpan(src.substring(i + 1, end), italic: true));
        i = end + 1;
        continue;
      }
    }

    // [text](url)
    if (src[i] == '[') {
      final m = _link.matchAsPrefix(src, i);
      if (m != null) {
        flushPlain();
        spans.add(MdSpan(m.group(1)!, linkUrl: m.group(2)));
        i = m.end;
        continue;
      }
    }

    plain.write(src[i]);
    i++;
  }

  flushPlain();
  return spans;
}
