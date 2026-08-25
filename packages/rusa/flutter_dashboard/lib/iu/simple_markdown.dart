import 'package:flutter/material.dart';

import '../theme.dart';
import 'markdown_blocks.dart';

/// A small Markdown renderer for the IU node-detail panel (ISSUE_NUM task 3) — the "simple
/// markdown renderer" starting point. Parses with [parseMarkdownBlocks] / [parseInline]
/// (pure Dart, separately unit-checked) and maps the result to themed widgets. No external
/// markdown dependency; richer rendering (tables, nested lists, images) can come later.
class SimpleMarkdown extends StatelessWidget {
  const SimpleMarkdown(this.data, {super.key});

  final String data;

  static const _baseColor = MeshColors.textPrimary;

  @override
  Widget build(BuildContext context) {
    final blocks = parseMarkdownBlocks(data);
    final children = <Widget>[];
    for (var i = 0; i < blocks.length; i++) {
      children.add(
        Padding(
          padding: EdgeInsets.only(top: i == 0 ? 0 : 8),
          child: _block(blocks[i]),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  Widget _block(MdBlock block) {
    switch (block.type) {
      case MdBlockType.heading:
        const sizes = {1: 22.0, 2: 19.0, 3: 17.0, 4: 15.0, 5: 14.0, 6: 13.0};
        return Text.rich(
          _inline(
            block.text,
            const TextStyle(color: _baseColor, fontWeight: FontWeight.w600),
          ),
          style: TextStyle(
            fontSize: sizes[block.level] ?? 14.0,
            fontWeight: FontWeight.w600,
            color: _baseColor,
          ),
        );
      case MdBlockType.paragraph:
        return Text.rich(_inline(block.text, _body));
      case MdBlockType.bullet:
        return _listRow('•  ', block.text);
      case MdBlockType.ordered:
        return _listRow('${block.ordinal}.  ', block.text);
      case MdBlockType.quote:
        return Container(
          padding: const EdgeInsets.only(left: 12),
          decoration: const BoxDecoration(
            border: Border(
              left: BorderSide(color: MeshColors.border, width: 3),
            ),
          ),
          child: Text.rich(
            _inline(
              block.text,
              _body.copyWith(
                color: MeshColors.textSecondary,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        );
      case MdBlockType.code:
        return Container(
          width: double.infinity,
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: MeshColors.bgConsole,
            border: Border.all(color: MeshColors.border),
            borderRadius: BorderRadius.circular(4),
          ),
          child: SelectableText(
            block.text,
            style: kMonoStyle.copyWith(color: MeshColors.textPrimary),
          ),
        );
      case MdBlockType.rule:
        return const Divider(color: MeshColors.border, height: 1);
    }
  }

  static const _body = TextStyle(color: _baseColor, fontSize: 14, height: 1.4);

  Widget _listRow(String marker, String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(marker, style: _body.copyWith(color: MeshColors.textSecondary)),
        Expanded(child: Text.rich(_inline(text, _body))),
      ],
    );
  }

  TextSpan _inline(String text, TextStyle base) {
    return TextSpan(
      style: base,
      children: [for (final s in parseInline(text)) _span(s, base)],
    );
  }

  TextSpan _span(MdSpan s, TextStyle base) {
    if (s.code) {
      return TextSpan(
        text: s.text,
        style: base
            .merge(kMonoStyle)
            .copyWith(
              color: MeshColors.accentHover,
              backgroundColor: MeshColors.bgTertiary,
            ),
      );
    }
    var style = base;
    if (s.bold) style = style.copyWith(fontWeight: FontWeight.w700);
    if (s.italic) style = style.copyWith(fontStyle: FontStyle.italic);
    if (s.linkUrl != null) {
      style = style.copyWith(
        color: MeshColors.accent,
        decoration: TextDecoration.underline,
        decorationColor: MeshColors.accent,
      );
    }
    return TextSpan(text: s.text, style: style);
  }
}
