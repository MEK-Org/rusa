// Headless check for the IU node-detail Markdown parser (ISSUE_NUM task 3).
//
// The renderer's parsing layer (markdown_blocks.dart) is pure Dart, so its block + inline
// parse can be exercised without Flutter — the cheap discipline before the widget layer
// renders it. Run:
//   PUB_CACHE=... CI=true <flutter>/bin/cache/dart-sdk/bin/dart run tool/iu_markdown_parse_check.dart
import 'dart:io';

import 'package:rusa_dashboard/iu/markdown_blocks.dart';

void main() {
  final failures = <String>[];
  void check(String label, bool ok) {
    stdout.writeln('  ${ok ? "ok" : "FAIL"} $label');
    if (!ok) failures.add(label);
  }

  const src = '''
# Title

A paragraph with **bold**, *italic* and `code` plus a [link](https://x.y).

- first
- second

1. one
2. two

> quoted line one
> quoted line two

```dart
final x = 1;
```

---
''';

  final blocks = parseMarkdownBlocks(src);
  final types = blocks.map((b) => b.type).toList();

  check('parses a heading', blocks.first.type == MdBlockType.heading);
  check('heading level is 1', blocks.first.level == 1);
  check('heading text stripped', blocks.first.text == 'Title');
  check('has a paragraph', types.contains(MdBlockType.paragraph));
  check('has two bullets',
      types.where((t) => t == MdBlockType.bullet).length == 2);
  check('has two ordered items',
      types.where((t) => t == MdBlockType.ordered).length == 2);
  final ordered = blocks.where((b) => b.type == MdBlockType.ordered).toList();
  check('ordinals are 1 and 2',
      ordered[0].ordinal == 1 && ordered[1].ordinal == 2);
  final quotes = blocks.where((b) => b.type == MdBlockType.quote).toList();
  check('consecutive quote lines coalesce into one block', quotes.length == 1);
  check('quote keeps both lines',
      quotes.single.text.contains('one') && quotes.single.text.contains('two'));
  final code = blocks.firstWhere((b) => b.type == MdBlockType.code);
  check('code fence language captured', code.language == 'dart');
  check('code body preserved', code.text.contains('final x = 1;'));
  check('has a horizontal rule', types.contains(MdBlockType.rule));

  // Inline parsing of the paragraph.
  final para =
      blocks.firstWhere((b) => b.type == MdBlockType.paragraph).text;
  final spans = parseInline(para);
  check('inline: a bold span', spans.any((s) => s.bold && s.text == 'bold'));
  check('inline: an italic span',
      spans.any((s) => s.italic && s.text == 'italic'));
  check('inline: a code span', spans.any((s) => s.code && s.text == 'code'));
  check(
      'inline: a link span',
      spans.any((s) =>
          s.linkUrl == 'https://x.y' && s.text == 'link'));
  check('inline: no marker characters leak into plain text',
      !spans.where((s) => !s.code).any((s) => s.text.contains('**')));

  // Unterminated markers must degrade to literal text, never drop content.
  final unterminated = parseInline('a **b and `c');
  check('unterminated markers preserved literally',
      unterminated.map((s) => s.text).join() == 'a **b and `c');

  stdout.writeln(
      'IU markdown parse-check: ${failures.isEmpty ? "PASS" : "FAIL"} '
      '(${blocks.length} blocks)');
  exit(failures.isEmpty ? 0 : 1);
}
