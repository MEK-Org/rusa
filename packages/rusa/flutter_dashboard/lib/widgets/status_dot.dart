import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';

/// The per-actor status dot in the tree, matching the mockup `.status-dot`:
/// active = filled green with a soft glow (and a gentle pulse), queued = amber,
/// idle = muted grey, retired = hollow muted ring.
class StatusDot extends StatefulWidget {
  const StatusDot({super.key, required this.state, this.size = 8});

  final DotState state;
  final double size;

  @override
  State<StatusDot> createState() => _StatusDotState();
}

class _StatusDotState extends State<StatusDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    // Created eagerly (not lazily): an idle/retired dot never reads `_pulse` in
    // build(), so a `late` initializer would otherwise first run inside dispose()
    // — creating a Ticker on a deactivated element and crashing.
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    )..repeat();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.size;
    switch (widget.state) {
      case DotState.retired:
        return Container(
          width: s,
          height: s,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: MeshColors.statusRetired, width: 2),
          ),
        );
      case DotState.idle:
        return _glowDot(MeshColors.statusRetired, s, glow: 0);
      case DotState.queued:
        return _glowDot(MeshColors.statusIdle, s);
      case DotState.active:
        // Subtle opacity pulse to convey "live".
        return AnimatedBuilder(
          animation: _pulse,
          builder: (_, _) {
            final t = (_pulse.value - 0.5).abs() * 2; // 1→0→1
            return _glowDot(MeshColors.statusActive, s, glow: 4 + (1 - t) * 4);
          },
        );
    }
  }

  Widget _glowDot(Color color, double s, {double glow = 6}) => Container(
    width: s,
    height: s,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      boxShadow: [
        BoxShadow(color: color.withValues(alpha: 0.7), blurRadius: glow),
      ],
    ),
  );
}
