import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

/// The textual actor state used anywhere the full status chip is needed.
///
/// The phone detail header and desktop detail body share this widget so a
/// state change cannot leave their labels or colors out of sync. It is purely
/// presentational: it renders the [DotState] the store already derives for the
/// status dot and header actions (`store.dotFor(actor)`), so retirement and
/// live run state are combined in exactly one place. This widget does not
/// subscribe to anything — callers must be rebuilt on `actorStates` for the
/// chip to stay fresh.
class ActorStatusBadge extends StatelessWidget {
  const ActorStatusBadge({super.key, required this.state});

  final DotState state;

  @override
  Widget build(BuildContext context) {
    final (text, color) = switch (state) {
      DotState.retired => ('RETIRED', MeshColors.statusRetired),
      DotState.active => ('RUNNING', MeshColors.statusActive),
      DotState.queued => ('QUEUED', MeshColors.statusIdle),
      DotState.idle => ('IDLE', MeshColors.statusRetired),
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
