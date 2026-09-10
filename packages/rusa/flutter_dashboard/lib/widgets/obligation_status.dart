import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';

/// The one colour table for every obligation-status surface (row chips, the
/// work-tree dot, the detail header), keyed on the derived presentation state
/// rather than the raw status string so no surface can drift from the others
/// or forget that `active` exists.
///
/// The hues deliberately echo the actor dot: waiting borrows the idle grey,
/// ready the queued amber, active the running green. Done is blue because the
/// previous green-on-green made a finished obligation read as a ready one.
class ObligationStatusColors {
  const ObligationStatusColors({
    required this.chipBackground,
    required this.chipForeground,
    required this.chipBorder,
    required this.dot,
  });

  final Color chipBackground;
  final Color chipForeground;
  final Color chipBorder;
  final Color dot;

  static const waiting = ObligationStatusColors(
    chipBackground: Color(0xFF1E293B),
    chipForeground: Color(0xFF94A3B8),
    chipBorder: Color(0xFF334155),
    dot: MeshColors.statusRetired,
  );
  static const ready = ObligationStatusColors(
    chipBackground: Color(0xFF78350F),
    chipForeground: Color(0xFFFBBF24),
    chipBorder: Color(0xFFB45309),
    dot: MeshColors.statusIdle,
  );
  static const active = ObligationStatusColors(
    chipBackground: Color(0xFF064E3B),
    chipForeground: Color(0xFF34D399),
    chipBorder: Color(0xFF047857),
    dot: MeshColors.statusActive,
  );
  static const scheduled = ObligationStatusColors(
    chipBackground: Color(0xFF312E81),
    chipForeground: Color(0xFFA5B4FC),
    chipBorder: Color(0xFF4338CA),
    dot: MeshColors.accent,
  );
  static const done = ObligationStatusColors(
    chipBackground: Color(0xFF1E3A8A),
    chipForeground: Color(0xFF60A5FA),
    chipBorder: Color(0xFF1D4ED8),
    dot: Color(0xFF3B82F6),
  );
  static const cancelled = ObligationStatusColors(
    chipBackground: Color(0xFF450A0A),
    chipForeground: Color(0xFFF87171),
    chipBorder: Color(0xFFB91C1C),
    dot: MeshColors.statusHalted,
  );

  /// Neutral, so an unrecognised status is visibly "none of the above" rather
  /// than passing for one of them.
  static const unknown = ObligationStatusColors(
    chipBackground: MeshColors.bgTertiary,
    chipForeground: MeshColors.textSecondary,
    chipBorder: MeshColors.border,
    dot: MeshColors.textMuted,
  );

  static ObligationStatusColors of(ObligationPresentationState state) =>
      switch (state) {
        ObligationPresentationState.waiting => waiting,
        ObligationPresentationState.ready => ready,
        ObligationPresentationState.active => active,
        ObligationPresentationState.scheduled => scheduled,
        ObligationPresentationState.done => done,
        ObligationPresentationState.cancelled => cancelled,
        ObligationPresentationState.unknown => unknown,
      };
}

/// The chip text: the synthetic state's own name when active, otherwise the
/// persisted status verbatim so an unknown status still says what it is.
String obligationStatusLabel(
  ObligationDto obligation,
  ObligationPresentationState state,
) => state == ObligationPresentationState.active
    ? 'ACTIVE'
    : obligation.status.toUpperCase();

/// Rebuilds [builder] with the obligation's current presentation state,
/// following the actor snapshot so a chip flips to and from green as the
/// owning run starts and ends — without waiting for the next obligation fetch.
class ObligationPresentationBuilder extends StatelessWidget {
  const ObligationPresentationBuilder({
    super.key,
    required this.obligation,
    required this.store,
    required this.builder,
  });

  final ObligationDto obligation;
  final DashboardStore store;
  final Widget Function(BuildContext, ObligationPresentationState) builder;

  @override
  Widget build(BuildContext context) => StreamBuilder<ActorStateSnapshot>(
    stream: store.actorStates,
    initialData: store.actorStates.value,
    builder: (context, snap) {
      final actors = snap.data ?? store.actorStates.value;
      final state = obligation.presentationState(
        activelyWorked: actors.isObligationActive(obligation.id),
      );
      return builder(context, state);
    },
  );
}

/// The status pill shown beside an obligation's heading.
class ObligationStatusChip extends StatelessWidget {
  const ObligationStatusChip({
    super.key,
    required this.obligation,
    required this.store,
    this.bordered = false,
  });

  final ObligationDto obligation;
  final DashboardStore store;

  /// The detail-header variant: slightly roomier with an outline, as the
  /// work tab has always drawn it.
  final bool bordered;

  @override
  Widget build(BuildContext context) => ObligationPresentationBuilder(
    obligation: obligation,
    store: store,
    builder: (context, state) {
      final colors = ObligationStatusColors.of(state);
      return Container(
        padding: bordered
            ? const EdgeInsets.symmetric(horizontal: 7, vertical: 3)
            : const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: colors.chipBackground,
          border: bordered ? Border.all(color: colors.chipBorder) : null,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          obligationStatusLabel(obligation, state),
          style: kMonoStyle.copyWith(
            color: colors.chipForeground,
            fontSize: 10,
            fontWeight: bordered ? FontWeight.w600 : FontWeight.w700,
            letterSpacing: bordered ? 0 : 0.5,
          ),
        ),
      );
    },
  );
}

/// The 8px status dot beside a node in the work tree.
class ObligationStatusDot extends StatelessWidget {
  const ObligationStatusDot({
    super.key,
    required this.obligation,
    required this.store,
  });

  final ObligationDto obligation;
  final DashboardStore store;

  @override
  Widget build(BuildContext context) => ObligationPresentationBuilder(
    obligation: obligation,
    store: store,
    builder: (context, state) => Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: ObligationStatusColors.of(state).dot,
        shape: BoxShape.circle,
      ),
    ),
  );
}
