import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'header.dart';
import 'obligation_dialogs.dart';

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
  final bool showOwner;
  final bool showActions;
  final bool showReorder;
  final EdgeInsetsGeometry contentPadding;

  @override
  Widget build(BuildContext context) {
    final hasIntent = obligation.intent != null && obligation.intent!.trim().isNotEmpty;
    final isWaiting = obligation.isWaiting;

    final titleAndOwner = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          hasIntent ? obligation.intent! : 'Untitled Obligation',
          style: const TextStyle(
            color: MeshColors.textPrimary,
            fontWeight: FontWeight.w600,
            fontSize: 13.5,
          ),
        ),
        if (showOwner) ...[
          const SizedBox(height: 2),
          Text(
            'Owner: ${obligation.owner.kind}:${obligation.owner.kind == 'actor' ? (store.actor(obligation.owner.id)?.handle ?? obligation.owner.id) : obligation.owner.id}',
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
                    defaultOwnerId: obligation.owner.kind == 'actor' ? obligation.owner.id : null,
                    defaultOwnerKind: obligation.owner.kind,
                    onCreated: onMutated,
                  );
                  break;
              }
            },
            itemBuilder: (context) => [
              if (obligation.isReady)
                const PopupMenuItem(
                  value: 'done',
                  child: Row(
                    children: [
                      Icon(Icons.check_circle_outline, size: 16, color: Color(0xFF34D399)),
                      SizedBox(width: 8),
                      Text('Mark Done', style: TextStyle(color: MeshColors.textPrimary, fontSize: 13)),
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
                _StatusChip(status: obligation.status),
                const SizedBox(width: 12),
                Expanded(child: titleAndOwner),
                const SizedBox(width: 8),
                actionButtons,
              ],
            ),
            if (obligation.externalRef != null && obligation.externalRef!.trim().isNotEmpty) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  const Text(
                    'Reference: ',
                    style: TextStyle(color: MeshColors.textSecondary, fontSize: 11.5),
                  ),
                  Expanded(
                    child: Text(
                      obligation.externalRef!,
                      style: const TextStyle(
                        color: MeshColors.accent,
                        fontSize: 11.5,
                        fontFamily: kMonoFontFamily,
                      ),
                    ),
                  ),
                ],
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
                          '• ${blocker.intent ?? blocker.id} (${blocker.owner.kind}: ${blocker.owner.kind == 'actor' ? (store.actor(blocker.owner.id)?.handle ?? blocker.owner.id) : blocker.owner.id})',
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

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    Color bg, fg;
    switch (status) {
      case 'ready':
        bg = const Color(0xFF064E3B);
        fg = const Color(0xFF34D399);
        break;
      case 'waiting':
        bg = const Color(0xFF78350F);
        fg = const Color(0xFFFBBF24);
        break;
      case 'active':
        bg = const Color(0xFF1E3A8A);
        fg = const Color(0xFF60A5FA);
        break;
      case 'done':
        bg = const Color(0xFF34D399).withValues(alpha: 0.1);
        fg = const Color(0xFF34D399);
        break;
      case 'cancelled':
        bg = const Color(0xFFF87171).withValues(alpha: 0.1);
        fg = const Color(0xFFF87171);
        break;
      default:
        bg = MeshColors.bgTertiary;
        fg = MeshColors.textSecondary;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        status.toUpperCase(),
        style: kMonoStyle.copyWith(
          color: fg,
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}
