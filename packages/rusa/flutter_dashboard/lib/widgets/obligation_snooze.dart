import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../api.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';

/// The yellow of the card's Snoozed panel: a snooze is the owner's choice.
const Color kSnoozeColor = Color(0xFFEAB308);

final DateFormat _previewFormat = DateFormat('EEE yyyy-MM-dd HH:mm');

/// Whether the viewer may snooze [obligation] from the dashboard (#893).
///
/// Snoozing is owner-only on the server (#722), unlike Done/Cancel, so the
/// action is offered only on the viewer's own non-terminal rows — under either
/// of their ids, since the server resolves the legacy alias the same way. An
/// actor-owned row offers no snooze. The server still decides; this only
/// avoids offering a write it would refuse.
bool canSnoozeObligation(DashboardStore store, ObligationDto obligation) =>
    !obligation.isTerminal && store.isViewer(obligation.ownerId);

/// The relative snoozes the action menu offers.
enum SnoozePreset {
  hour('1 hour'),
  day('1 day'),
  week('1 week'),
  month('1 month');

  const SnoozePreset(this.label);
  final String label;
}

/// When a [preset] snooze chosen at [from] ends. Hour, day and week are fixed
/// durations; a month is one calendar month at the same wall-clock time,
/// clamped to the target month's last day (Jan 31 → Feb 28/29).
DateTime snoozePresetDeadline(SnoozePreset preset, DateTime from) =>
    switch (preset) {
      SnoozePreset.hour => from.add(const Duration(hours: 1)),
      SnoozePreset.day => from.add(const Duration(days: 1)),
      SnoozePreset.week => from.add(const Duration(days: 7)),
      SnoozePreset.month => addCalendarMonth(from),
    };

/// [from] moved one calendar month later, keeping its time of day and clamping
/// the day to the target month's length.
DateTime addCalendarMonth(DateTime from) {
  final build = from.isUtc ? DateTime.utc : DateTime.new;
  // Day 0 of the month after next is the next month's last day.
  final lastDay = build(from.year, from.month + 2, 0).day;
  return build(
    from.year,
    from.month + 1,
    from.day > lastDay ? lastDay : from.day,
    from.hour,
    from.minute,
    from.second,
    from.millisecond,
    from.microsecond,
  );
}

enum _SnoozeChoice { hour, day, week, month, custom, clear }

extension on _SnoozeChoice {
  SnoozePreset? get preset => switch (this) {
    _SnoozeChoice.hour => SnoozePreset.hour,
    _SnoozeChoice.day => SnoozePreset.day,
    _SnoozeChoice.week => SnoozePreset.week,
    _SnoozeChoice.month => SnoozePreset.month,
    _ => null,
  };
}

/// Snooze, re-snooze or clear the snooze on [obligation] through the existing
/// owner-only endpoint, then report the persisted deadline and refresh.
///
/// Presets are computed when chosen, not when the dialog opened. A custom
/// deadline comes from the standard date then time pickers in local time and
/// must be in the future. Dismissing any step writes nothing. [now] is the
/// clock, injectable for tests.
Future<void> showSnoozeObligationDialog(
  BuildContext context,
  DashboardStore store,
  ObligationDto obligation, {
  VoidCallback? onUpdated,
  DateTime Function() now = DateTime.now,
}) async {
  final choice = await showDialog<_SnoozeChoice>(
    context: context,
    builder: (_) => _SnoozeDialog(obligation: obligation, now: now),
  );
  if (choice == null || !context.mounted) return;

  final DateTime? until;
  if (choice == _SnoozeChoice.clear) {
    until = null;
  } else if (choice == _SnoozeChoice.custom) {
    final picked = await _pickCustomDeadline(context, obligation, now());
    if (picked == null || !context.mounted) return;
    if (!picked.isAfter(now())) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Snooze not changed: ${_previewFormat.format(picked)} is not in the future.',
          ),
          backgroundColor: MeshColors.statusHalted,
        ),
      );
      return;
    }
    until = picked;
  } else {
    until = snoozePresetDeadline(choice.preset!, now());
  }

  try {
    final result = await store.mutateObligations(
      () => store.api.setObligationSnooze(obligation.id, until),
    );
    if (!context.mounted) return;
    final persisted = result.obligation.snoozedUntil;
    final saved = persisted == null
        ? 'Snooze cleared'
        : 'Snoozed until ${formatTs(persisted)}';
    final warning = result.warning;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(warning == null ? saved : '$saved. Warning: $warning'),
        backgroundColor: warning == null ? null : MeshColors.statusIdle,
      ),
    );
    onUpdated?.call();
  } catch (err) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${until == null ? 'Failed to clear snooze' : 'Failed to snooze'}: '
            '${_describeError(err)}',
          ),
          backgroundColor: MeshColors.statusHalted,
        ),
      );
    }
  }
}

/// The server's own refusal text where it sent one (non-owner, terminal, past
/// deadline, no timer), rather than the raw response envelope.
String _describeError(Object err) {
  if (err is DashboardApiException) {
    try {
      final body = jsonDecode(err.body);
      if (body case {'error': final String error}) return error;
    } catch (_) {}
    return 'HTTP ${err.status}';
  }
  return '$err';
}

/// Date then time, both standard pickers. Starts from the current snooze when
/// it is still ahead, otherwise an hour from now. Null when either is
/// dismissed.
Future<DateTime?> _pickCustomDeadline(
  BuildContext context,
  ObligationDto obligation,
  DateTime now,
) async {
  final current = obligation.snoozedUntil == null
      ? null
      : DateTime.tryParse(obligation.snoozedUntil!)?.toLocal();
  final initial = current != null && current.isAfter(now)
      ? current
      : now.add(const Duration(hours: 1));
  final today = DateTime(now.year, now.month, now.day);
  // Five years out, or further when the current snooze already is: the server
  // sets no upper bound.
  final horizon = DateTime(today.year + 5, today.month, today.day);
  final date = await showDatePicker(
    context: context,
    initialDate: initial,
    firstDate: today,
    lastDate: initial.isAfter(horizon) ? DateUtils.dateOnly(initial) : horizon,
    helpText: 'Snooze until',
  );
  if (date == null || !context.mounted) return null;
  final time = await showTimePicker(
    context: context,
    initialTime: TimeOfDay.fromDateTime(initial),
    helpText: 'Snooze until',
  );
  if (time == null) return null;
  return DateTime(date.year, date.month, date.day, time.hour, time.minute);
}

class _SnoozeDialog extends StatelessWidget {
  const _SnoozeDialog({required this.obligation, required this.now});

  final ObligationDto obligation;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    // Previews only; the deadline is recomputed when an option is chosen.
    final previewFrom = now();
    final until = obligation.snoozedUntil;
    Widget option(
      _SnoozeChoice choice,
      IconData icon,
      String label, {
      String? subtitle,
      Color? color,
    }) => ListTile(
      key: ValueKey('snooze-option-${choice.name}'),
      dense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
      leading: Icon(icon, size: 18, color: color ?? kSnoozeColor),
      title: Text(
        label,
        style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13),
      ),
      subtitle: subtitle == null
          ? null
          : Text(
              subtitle,
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 11.5,
              ),
            ),
      onTap: () => Navigator.of(context).pop(choice),
    );

    return AlertDialog(
      backgroundColor: MeshColors.bgSecondary,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: const BorderSide(color: MeshColors.border),
      ),
      title: const Text(
        'Snooze obligation',
        style: TextStyle(
          color: MeshColors.textPrimary,
          fontSize: 16,
          fontWeight: FontWeight.bold,
        ),
      ),
      content: SingleChildScrollView(
        child: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                obligation.heading,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 13,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                until == null
                    ? 'Not snoozed.'
                    : 'Snoozed until ${formatTs(until)}. A new choice replaces it.',
                style: TextStyle(
                  color: until == null
                      ? MeshColors.textMuted
                      : const Color(0xFFFDE047),
                  fontSize: 12,
                ),
              ),
              const SizedBox(height: 8),
              for (final choice in [
                _SnoozeChoice.hour,
                _SnoozeChoice.day,
                _SnoozeChoice.week,
                _SnoozeChoice.month,
              ])
                option(
                  choice,
                  Icons.snooze,
                  choice.preset!.label,
                  subtitle:
                      'Until ${_previewFormat.format(snoozePresetDeadline(choice.preset!, previewFrom))}',
                ),
              option(_SnoozeChoice.custom, Icons.event, 'Pick date & time…'),
              if (until != null)
                option(
                  _SnoozeChoice.clear,
                  Icons.alarm_off,
                  'Clear snooze',
                  subtitle: 'End the snooze now',
                  color: MeshColors.textSecondary,
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          // Not "Cancel": beside the obligation's own Cancel action that
          // would read as cancelling the obligation (#508).
          onPressed: () => Navigator.of(context).pop(),
          child: const Text(
            'Close',
            style: TextStyle(color: MeshColors.textSecondary),
          ),
        ),
      ],
    );
  }
}
