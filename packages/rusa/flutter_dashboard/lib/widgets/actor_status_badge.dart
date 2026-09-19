import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';

/// The textual actor state used anywhere the full status chip is needed.
///
/// The phone detail header and desktop detail body share this widget so a
/// state change cannot leave their labels or colors out of sync.
class ActorStatusBadge extends StatelessWidget {
  const ActorStatusBadge({super.key, required this.actor, required this.store});

  final ThreadDto actor;
  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    final state = store.actorStates.value.actors[actor.id];
    final runState = state?.runState ?? RunState.unknown;

    final (text, color) = switch ((actor.isRetired, runState)) {
      (true, _) => ('RETIRED', MeshColors.statusRetired),
      (_, RunState.running || RunState.windingDown) => (
        'RUNNING',
        MeshColors.statusActive,
      ),
      (_, RunState.queued) => ('QUEUED', MeshColors.statusIdle),
      _ => ('IDLE', MeshColors.statusRetired),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}
