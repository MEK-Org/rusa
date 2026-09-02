import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';
import '../util.dart';

/// One rendering for any resolved reference.
///
/// Shared by the obligation and inbox call sites so source metadata is presented
/// consistently without two copies of the same card.
///
/// In v1 only mesh chat resolves to real text. Everything else arrives with
/// [ReferenceDto.unavailable] set and renders as a citation we can name but not
/// yet expand — which is the honest state, and visibly different from a
/// citation with nothing behind it.
class ReferencePreview extends StatelessWidget {
  const ReferencePreview({
    super.key,
    required this.reference,
    this.label,
    this.attachedBy,
  });

  final ReferenceDto reference;

  /// Optional gloss from whoever cited it: why this is attached.
  final String? label;
  final String? attachedBy;

  @override
  Widget build(BuildContext context) {
    var displayTitle = reference.title;
    var displayBody = reference.body?.trim() ?? '';

    if (reference.entity != null) {
      final e = reference.entity!;
      final type = e['type'] as String?;
      if (type == 'github_issue' || type == 'github_pull_request') {
        displayTitle = e['title'] as String? ?? displayTitle;
        displayBody = (e['description'] as String?)?.trim() ?? '';
      } else if (type == 'gchat_space') {
        displayTitle = e['name'] as String? ?? displayTitle;
        displayBody = '';
      } else if (type == 'gchat_message') {
        displayBody = (e['contents'] as String?)?.trim() ?? displayBody;
      }
    }

    final hasBody = displayBody.isNotEmpty;

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: MeshColors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _SchemeChip(reference.scheme),
              if (reference.cacheState != null && reference.cacheState != 'local') ...[
                const SizedBox(width: 8),
                _StateChip(reference.cacheState!),
              ],
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  displayTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: MeshColors.textPrimary,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (reference.timestamp != null) ...[
                const SizedBox(width: 8),
                Text(
                  formatTs(reference.timestamp!),
                  style: const TextStyle(
                    color: MeshColors.textMuted,
                    fontSize: 10.5,
                    fontFamily: kMonoFontFamily,
                  ),
                ),
              ],
            ],
          ),
          if (label != null && label!.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              label!,
              style: const TextStyle(
                color: MeshColors.accent,
                fontSize: 11.5,
                fontStyle: FontStyle.italic,
              ),
            ),
          ],
          if (reference.author != null && reference.author!.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              'by ${reference.author}',
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 10.5,
              ),
            ),
          ],
          const SizedBox(height: 8),
          if (hasBody)
            // No `maxLines`: SelectableText wraps an EditableText, which sizes
            // itself to `maxLines` rather than to its content, so a one-line
            // citation rendered eight lines tall. The card is meant to be as
            // tall as what it is quoting.
            SelectableText(
              displayBody,
              style: const TextStyle(
                color: Color(0xFFCBD5E1),
                fontSize: 12,
                height: 1.45,
              ),
            )
          else
            Text(
              reference.unavailable ?? 'No content.',
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 11.5,
                fontStyle: FontStyle.italic,
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: SelectableText(
                  reference.ref,
                  style: const TextStyle(
                    color: MeshColors.textMuted,
                    fontSize: 10.5,
                    fontFamily: kMonoFontFamily,
                  ),
                ),
              ),
              if (attachedBy != null) ...[
                const SizedBox(width: 8),
                Text(
                  'cited by $attachedBy',
                  style: const TextStyle(color: MeshColors.textMuted, fontSize: 10.5),
                ),
              ],
            ],
          ),
          if (reference.url != null && reference.url!.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            SelectableText(
              reference.url!,
              style: const TextStyle(
                color: MeshColors.accent,
                fontSize: 10.5,
                fontFamily: kMonoFontFamily,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SchemeChip extends StatelessWidget {
  const _SchemeChip(this.scheme);
  final String scheme;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: MeshColors.bgPrimary,
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: MeshColors.border),
    ),
    child: Text(
      scheme.toUpperCase(),
      style: const TextStyle(
        color: MeshColors.accent,
        fontSize: 9.5,
        fontWeight: FontWeight.bold,
        letterSpacing: 0.5,
        fontFamily: kMonoFontFamily,
      ),
    ),
  );
}

class _StateChip extends StatelessWidget {
  const _StateChip(this.state);
  final String state;

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (state) {
      case 'fresh':
        color = const Color(0xFF10B981);
        break;
      case 'stale':
        color = const Color(0xFFF59E0B);
        break;
      case 'pending':
        color = const Color(0xFF3B82F6);
        break;
      case 'unavailable':
        color = const Color(0xFFEF4444);
        break;
      default:
        color = MeshColors.textMuted;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Text(
        state.toUpperCase(),
        style: TextStyle(
          color: color,
          fontSize: 8.5,
          fontWeight: FontWeight.bold,
          letterSpacing: 0.5,
          fontFamily: kMonoFontFamily,
        ),
      ),
    );
  }
}
