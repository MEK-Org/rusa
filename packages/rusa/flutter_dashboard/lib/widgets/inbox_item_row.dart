import 'package:flutter/material.dart';

import '../link_opener.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'header.dart';
import 'inbox_event.dart';
import 'obligation_reference_card.dart';
import 'reference_preview.dart';

class InboxChip extends StatelessWidget {
  const InboxChip(this.label, {super.key});
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
    decoration: BoxDecoration(
      color: const Color(0xFF173654),
      border: Border.all(color: const Color(0xFF24527D)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      label.toUpperCase(),
      style: const TextStyle(
        fontSize: 10,
        color: Color(0xFFB8DFFC),
        fontFamily: kMonoFontFamily,
      ),
    ),
  );
}

class _ResponsiveBadge extends StatelessWidget {
  const _ResponsiveBadge();

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
    decoration: BoxDecoration(
      color: MeshColors.accent.withValues(alpha: 0.15),
      border: Border.all(color: MeshColors.accent.withValues(alpha: 0.35)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      'RESPONSIVE',
      style: kMonoStyle.copyWith(
        fontSize: 10,
        fontWeight: FontWeight.w600,
        color: MeshColors.accent,
      ),
    ),
  );
}

/// A compact row showing an actor's selected inbox item on their overview card.
/// When more items exist for this actor, a `(+N more)` badge is displayed.
///
/// An item whose reference renders on its own terms is that reference's card,
/// with the badges in its header, rather than a card nested in this row; see
/// [rendersOwnFrame].
class InboxItemRow extends StatelessWidget {
  const InboxItemRow({
    super.key,
    required this.entry,
    this.moreCount,
    required this.store,
    this.onSelectView,
    this.openLink = openInNewTab,
    this.contentPadding = const EdgeInsets.all(12),
  });

  final InboxEntryDto entry;
  final int? moreCount;
  final DashboardStore store;
  final void Function(DashboardView)? onSelectView;
  final void Function(String url) openLink;
  final EdgeInsetsGeometry contentPadding;

  /// Whether this row draws its own card, so a caller should not frame it.
  static bool rendersOwnFrame(InboxEntryDto entry) =>
      ReferencePreview.rendersOwnContent(entry.reference) ||
      ObligationReferenceCard.obligationIdFor(entry.payload) != null;

  Widget _referenceCard(Widget? action) {
    final event = presentGitHubInboxEvent(
      payload: entry.payload,
      reference: entry.reference,
      eventReference: entry.eventReference,
    );
    return ReferencePreview(
      reference: entry.reference!,
      lookupActorHandle: (id) => store.actor(id)?.handle,
      isViewer: store.isViewer,
      humanDisplayName: store.operatorDisplayName,
      openLink: openLink,
      margin: EdgeInsets.zero,
      action: action,
      kindLabel: event?.kindLabel,
      detail: event?.detail,
      summary: event?.summary,
      showBody: !(event?.bodyless ?? false),
    );
  }

  void _openActor(BuildContext context) {
    store.clickActor(entry.actorId);
    onSelectView?.call(DashboardView.actors);
  }

  @override
  Widget build(BuildContext context) {
    final showMoreCount = moreCount != null && moreCount! > 0;
    final content = entry.contentText;
    final moreLabel = showMoreCount
        ? Text(
            '(+$moreCount more)',
            style: kMonoStyle.copyWith(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: MeshColors.accent,
            ),
          )
        : null;

    if (rendersOwnFrame(entry)) {
      final badges = [
        if (entry.isResponsive) const _ResponsiveBadge(),
        ?moreLabel,
      ];
      final action = badges.isEmpty
          ? null
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < badges.length; i++) ...[
                  if (i > 0) const SizedBox(width: 6),
                  badges[i],
                ],
              ],
            );
      final obligationId = ObligationReferenceCard.obligationIdFor(
        entry.payload,
      );
      return InkWell(
        onTap: () => _openActor(context),
        borderRadius: BorderRadius.circular(6),
        child: obligationId != null
            ? ObligationReferenceCard(
                obligationId: obligationId,
                store: store,
                fallbackText: entry.payload['intent']?.toString(),
                action: action,
                onSelectView: onSelectView,
              )
            : _referenceCard(action),
      );
    }

    return InkWell(
      onTap: () => _openActor(context),
      borderRadius: BorderRadius.circular(5),
      child: Padding(
        padding: contentPadding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              runSpacing: 4,
              children: [
                InboxChip(entry.type),
                if (entry.isResponsive) const _ResponsiveBadge(),
                if (entry.source.isNotEmpty)
                  Text(
                    entry.source,
                    style: const TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 11,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ?moreLabel,
              ],
            ),
            const SizedBox(height: 6),
            if (entry.reference != null)
              ReferencePreview(
                reference: entry.reference!,
                lookupActorHandle: (id) => store.actor(id)?.handle,
                isViewer: store.isViewer,
                humanDisplayName: store.operatorDisplayName,
                openLink: openLink,
              )
            else
              Text(
                content.isEmpty ? 'No attached contents.' : content,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 12,
                  height: 1.35,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
