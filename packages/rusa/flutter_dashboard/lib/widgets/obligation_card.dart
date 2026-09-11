import 'package:flutter/material.dart';

import '../actor_display.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'header.dart';
import 'obligation_dialogs.dart';
import 'obligation_status.dart';

class ObligationRow extends StatelessWidget {
  const ObligationRow({
    super.key,
    required this.obligation,
    required this.store,
    this.blockers,
    this.onMoveUp,
    this.onMoveDown,
    this.onMutated,
    this.onSelectView,
    this.openLink,
    this.showOwner = false,
    this.showActions = true,
    this.showReorder = false,
    this.contentPadding = const EdgeInsets.all(16),
  });

  final ObligationDto obligation;
  final DashboardStore store;
  final List<ObligationDto>? blockers;
  final VoidCallback? onMoveUp;
  final VoidCallback? onMoveDown;
  final VoidCallback? onMutated;
  final void Function(DashboardView)? onSelectView;
  final void Function(String url)? openLink;
  final bool showOwner;
  final bool showActions;
  final bool showReorder;
  final EdgeInsetsGeometry contentPadding;

  @override
  Widget build(BuildContext context) {
    final body = obligation.body;
    final isWaiting = obligation.isWaiting;
    // A terminal note only exists on a terminal obligation, but read the field
    // rather than the status so a note that somehow outlives a transition is
    // visible rather than silently swallowed.
    final hasTerminalNote =
        obligation.terminalNote != null && obligation.terminalNote!.trim().isNotEmpty;

    final titleAndOwner = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          obligation.heading,
          style: const TextStyle(
            color: MeshColors.textPrimary,
            fontWeight: FontWeight.w600,
            fontSize: 13.5,
          ),
        ),
        if (body != null) ...[
          const SizedBox(height: 4),
          Text(
            body,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12, height: 1.35),
          ),
        ],
        if (showOwner) ...[
          const SizedBox(height: 2),
          Text(
            'Owner: ${store.actor(obligation.ownerId)?.handle ?? obligation.ownerId}',
            style: const TextStyle(color: MeshColors.textMuted, fontSize: 11),
          ),
        ],
      ],
    );

    final actionButtons = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (showReorder) ...[
          IconButton(
            icon: const Icon(Icons.arrow_upward, size: 16),
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
            tooltip: 'Move Up in Priority',
            onPressed: onMoveUp,
          ),
          const SizedBox(width: 4),
          IconButton(
            icon: const Icon(Icons.arrow_downward, size: 16),
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
            tooltip: 'Move Down in Priority',
            onPressed: onMoveDown,
          ),
        ],
        if (showActions && !obligation.isTerminal) ...[
          if (showReorder) const SizedBox(width: 4),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, size: 18, color: MeshColors.textSecondary),
            padding: EdgeInsets.zero,
            tooltip: 'Obligation Actions',
            color: MeshColors.bgTertiary,
            onSelected: (val) {
              switch (val) {
                case 'done':
                  confirmAndSetObligationStatus(context, store, obligation, 'done', onUpdated: onMutated);
                  break;
                case 'cancelled':
                  confirmAndSetObligationStatus(context, store, obligation, 'cancelled', onUpdated: onMutated);
                  break;
                case 'reparent':
                  showReparentObligationDialog(context, store, obligation, onReparented: onMutated);
                  break;
                case 'add_child':
                  showCreateObligationDialog(
                    context,
                    store,
                    defaultParentId: obligation.id,
                    defaultOwnerId: obligation.ownerId,
                    onCreated: onMutated,
                  );
                  break;
              }
            },
            itemBuilder: (context) => [
              if (obligation.isReady)
                PopupMenuItem(
                  value: 'done',
                  child: Row(
                    children: [
                      // Blue for done, matching the chip: green is reserved for
                      // an obligation an actor is working right now.
                      Icon(
                        Icons.check_circle_outline,
                        size: 16,
                        color: ObligationStatusColors.done.chipForeground,
                      ),
                      const SizedBox(width: 8),
                      const Text('Mark Done', style: TextStyle(color: MeshColors.textPrimary, fontSize: 13)),
                    ],
                  ),
                ),
              const PopupMenuItem(
                value: 'cancelled',
                child: Row(
                  children: [
                    Icon(Icons.cancel_outlined, size: 16, color: Color(0xFFF87171)),
                    SizedBox(width: 8),
                    Text('Cancel', style: TextStyle(color: MeshColors.textPrimary, fontSize: 13)),
                  ],
                ),
              ),
              const PopupMenuDivider(),
              const PopupMenuItem(
                value: 'reparent',
                child: Row(
                  children: [
                    Icon(Icons.drive_file_move_outlined, size: 16, color: MeshColors.accent),
                    SizedBox(width: 8),
                    Text('Reparent...', style: TextStyle(color: MeshColors.textPrimary, fontSize: 13)),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'add_child',
                child: Row(
                  children: [
                    Icon(Icons.add_task, size: 16, color: MeshColors.accent),
                    SizedBox(width: 8),
                    Text('Add Child...', style: TextStyle(color: MeshColors.textPrimary, fontSize: 13)),
                  ],
                ),
              ),
            ],
          ),
        ],
      ],
    );

    return InkWell(
      onTap: () {
        store.setFocusedObligationId(obligation.id);
        onSelectView?.call(DashboardView.work);
      },
      child: Padding(
        padding: contentPadding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ObligationStatusChip(obligation: obligation, store: store),
                const SizedBox(width: 12),
                Expanded(child: titleAndOwner),
                const SizedBox(width: 8),
                actionButtons,
              ],
            ),
            if (obligation.hasCheckpoint) ...[
              const SizedBox(height: 10),
              ObligationCheckpointPanel(
                obligation: obligation,
                lookupHandle: (id) => store.actor(id)?.handle,
                maxLines: 4,
              ),
            ],
            if (obligation.externalRef != null && obligation.externalRef!.trim().isNotEmpty) ...[
              const SizedBox(height: 8),
              Builder(
                builder: (context) {
                  final refUrl = externalRefUrl(obligation.externalRef);
                  return Row(
                    children: [
                      const Text(
                        'Reference: ',
                        style: TextStyle(color: MeshColors.textSecondary, fontSize: 11.5),
                      ),
                      Expanded(
                        child: InkWell(
                          onTap: (openLink != null && refUrl != null)
                              ? () => openLink!(refUrl)
                              : null,
                          child: Text(
                            obligation.externalRef!,
                            style: const TextStyle(
                              color: MeshColors.accent,
                              fontSize: 11.5,
                              fontFamily: kMonoFontFamily,
                            ),
                          ),
                        ),
                      ),
                      if (openLink != null && refUrl != null)
                        IconButton(
                          icon: const Icon(Icons.open_in_new, size: 14),
                          color: MeshColors.textSecondary,
                          tooltip: 'Open in external system',
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                          onPressed: () => openLink!(refUrl),
                        ),
                    ],
                  );
                },
              ),
            ],
            if (obligation.isScheduled && obligation.nextReadyAt != null) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  const Icon(Icons.schedule, size: 13, color: MeshColors.textMuted),
                  const SizedBox(width: 4),
                  Text(
                    'Returns ${formatReturnsIn(obligation.nextReadyAt!)} '
                    '(${formatTs(obligation.nextReadyAt!)})',
                    style: const TextStyle(color: MeshColors.textMuted, fontSize: 11.5),
                  ),
                ],
              ),
            ],
            if (hasTerminalNote) ...[
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: MeshColors.bgTertiary,
                  border: Border(
                    left: BorderSide(
                      color: obligation.isDone
                          ? ObligationStatusColors.done.dot
                          : ObligationStatusColors.cancelled.dot,
                      width: 3,
                    ),
                  ),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      obligation.isDone ? 'Completed because:' : 'Cancelled because:',
                      style: const TextStyle(
                        color: MeshColors.textSecondary,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      obligation.terminalNote!,
                      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 11.5),
                    ),
                  ],
                ),
              ),
            ],
            if (isWaiting && blockers != null && blockers!.isNotEmpty) ...[
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: const Color(0xFF1E1313),
                  border: const Border(
                    left: BorderSide(color: MeshColors.statusHalted, width: 3),
                  ),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Blocked by direct children:',
                      style: TextStyle(
                        color: Color(0xFFFDA4AF),
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    for (final blocker in blockers!) ...[
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          '• ${blocker.intent ?? blocker.id} (${store.actor(blocker.ownerId)?.handle ?? blocker.ownerId})',
                          style: const TextStyle(
                            color: Color(0xFFFECDD3),
                            fontSize: 11.5,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Who last said where this obligation stands, and when — `handle · timestamp`.
///
/// Both halves are present whenever a checkpoint is present: the database
/// coherence constraint and single write statement make a partial stamp
/// unrepresentable on this API.
String checkpointStampLabel(
  ObligationDto obligation,
  String? Function(String id) lookupHandle,
) {
  final author = actorDisplayLabel(obligation.checkpointBy!, lookupHandle);
  final when = formatTs(obligation.checkpointAt!);
  return '$author · $when';
}

/// The owner's account of where this obligation's work stands.
///
/// Rendered directly under the heading, and above the evidence, because it is
/// the thing a reader wants first: what is true *now*. It is deliberately
/// styled apart from [ObligationDto.body] — intent says why the work exists and
/// does not change; a checkpoint is rewritten at every milestone, so reading
/// one as the other would mislead in both directions.
class ObligationCheckpointPanel extends StatelessWidget {
  const ObligationCheckpointPanel({
    super.key,
    required this.obligation,
    required this.lookupHandle,
    this.maxLines,
    this.selectable = false,
  });

  final ObligationDto obligation;
  final String? Function(String id) lookupHandle;

  /// Cap the standing's height where the surrounding surface is a summary. Null
  /// shows it whole, which is what a detail view owes a reader.
  final int? maxLines;
  final bool selectable;

  @override
  Widget build(BuildContext context) {
    const bodyStyle = TextStyle(
      color: MeshColors.textPrimary,
      fontSize: 11.5,
      height: 1.4,
    );
    final text = obligation.checkpoint!.trim();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        border: const Border(
          left: BorderSide(color: MeshColors.accent, width: 3),
        ),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.flag_outlined, size: 13, color: MeshColors.accent),
              const SizedBox(width: 4),
              const Text(
                'Standing',
                style: TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  checkpointStampLabel(obligation, lookupHandle),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: MeshColors.textMuted, fontSize: 11),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          if (selectable)
            SelectableText(text, style: bodyStyle)
          else
            Text(text, maxLines: maxLines, overflow: TextOverflow.ellipsis, style: bodyStyle),
        ],
      ),
    );
  }
}
