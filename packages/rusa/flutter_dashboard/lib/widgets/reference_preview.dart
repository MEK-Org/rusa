import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';
import '../util.dart';

/// One rendering for any resolved reference.
///
/// Shared deliberately: an obligation's cited artifacts and an actor's inbox
/// items are the same thing seen from two directions — something that was said
/// somewhere, which the mesh is pointing at. Rendering them through one widget
/// keeps them recognisable as the same kind of object, and means a new source
/// only has to teach the *server* how to resolve it.
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
    this.maxLines = 8,
  });

  final ReferenceDto reference;

  /// Optional gloss from whoever cited it: why this is attached.
  final String? label;
  final String? attachedBy;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final body = reference.body?.trim() ?? '';
    final hasBody = body.isNotEmpty;

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
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _SchemeChip(reference.scheme),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  reference.title,
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
          const SizedBox(height: 8),
          if (hasBody)
            SelectableText(
              body,
              maxLines: maxLines,
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
