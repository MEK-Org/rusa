import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'header.dart';
import 'obligation_card.dart';
import 'reference_preview.dart';

/// An inbox entry that names an obligation (`obligation.ready_head`), shown
/// as that obligation in the same card frame as a resolved reference rather
/// than as the entry's raw payload.
class ObligationReferenceCard extends StatelessWidget {
  const ObligationReferenceCard({
    super.key,
    required this.obligationId,
    required this.store,
    this.fallbackText,
    this.action,
    this.onSelectView,
    this.margin = EdgeInsets.zero,
  });

  final String obligationId;
  final DashboardStore store;

  /// Shown while the obligation loads, or if it can't be: the intent the
  /// entry itself carried.
  final String? fallbackText;

  /// Optional action widget rendered at the trailing edge of the header row.
  final Widget? action;
  final void Function(DashboardView)? onSelectView;
  final EdgeInsetsGeometry margin;

  /// The obligation an inbox entry's payload names, or null when it is not a
  /// ready-head signal this card can stand in for.
  static String? obligationIdFor(Map<String, dynamic> payload) {
    if (payload['type'] != 'obligation.ready_head') return null;
    final id = payload['obligationId'];
    return id is String && id.isNotEmpty ? id : null;
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: margin,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: MeshColors.border),
      ),
      child: FutureBuilder<ObligationDto?>(
        future: store.obligationById(obligationId),
        builder: (context, snapshot) {
          final obligation = snapshot.data;
          if (obligation != null) {
            return ObligationRow(
              obligation: obligation,
              store: store,
              showActions: false,
              onSelectView: onSelectView,
              contentPadding: EdgeInsets.zero,
              trailing: action,
            );
          }
          // Until it loads (or if it can't), the same header over the intent
          // the entry itself carried.
          final text = fallbackText?.trim() ?? '';
          return Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const ReferenceKindChip('OBLIGATION'),
                  const Spacer(),
                  ?action,
                ],
              ),
              const SizedBox(height: 4),
              Text(
                text.isEmpty ? 'Ready obligation' : text,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 12,
                  height: 1.35,
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
