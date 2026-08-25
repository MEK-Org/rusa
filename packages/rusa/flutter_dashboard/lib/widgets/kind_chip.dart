import 'package:flutter/material.dart';

import '../theme.dart';

/// Small inline event-kind chip (mockup `.inline-kind-chip`): a tinted pill with
/// the kind's signature color. This is the ONLY place kind is shown in the Events
/// list — there is no Kind column (the multi-column table was cut).
class KindChip extends StatelessWidget {
  const KindChip({super.key, required this.kind});

  final String kind;

  @override
  Widget build(BuildContext context) {
    final c = KindChipColors.forKind(kind);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: c.withValues(alpha: 0.25)),
      ),
      child: Text(kind, style: kMonoStyle.copyWith(fontSize: 11, color: c)),
    );
  }
}
