import 'package:flutter/material.dart';
import 'dart:convert';
import 'package:rxdart/rxdart.dart';

import '../event_coalesce.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'kind_chip.dart';

/// All mesh event kinds, for the filter dropdown (mirrors MeshEventKind).
const _kKinds = [
  'run_queued',
  'run_start',
  'run_end',
  'run_yielded',
  'run_continued',
  'continuation_capped',
  'actor_spawned',
  'actor_retired',
  'message_sent',
  'message_acknowledged',
  'handle_granted',
  'root_control_action',
];

/// Events Log tab: kind filter + a merged, newest-first, paginated list. Each row
/// is timestamp + inline kind chip + detail (+ a handle badge when multiple
/// actors are selected). No multi-column table (cut).
class EventsTab extends StatelessWidget {
  const EventsTab({super.key, required this.store});

  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _filterBar(),
        const Divider(height: 1, color: MeshColors.border),
        Expanded(
          child: StreamBuilder<List<Object?>>(
            stream: Rx.combineLatestList<Object?>([
              store.events,
              store.selection,
              store.actorStates,
            ]),
            builder: (_, _) {
              final view = store.events.value;
              final multi = store.selection.value.length > 1;
              final handles = {
                for (final a in store.actorStates.value.actors.values) a.thread.id: a.thread.handle,
              };
              if (store.selection.value.isEmpty) {
                return _empty('Select an actor to see its events.');
              }
              if (view.events.isEmpty && !view.loading) {
                return _empty('No events.');
              }
              // Collapse each run's `run_yielded` + `run_end` into one row .
              final rows = coalesceRunEvents(view.events);
              return ListView.builder(
                itemCount: rows.length + 1,
                itemBuilder: (_, i) {
                  if (i == rows.length) return _loadMore(view);
                  return _row(rows[i], multi, handles);
                },
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _filterBar() => Padding(
    padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
    child: SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          const Text(
            'Kind filter:',
            style: TextStyle(color: MeshColors.textSecondary, fontSize: 12),
          ),
          const SizedBox(width: 8),
          StreamBuilder<String?>(
            stream: store.kindFilter,
            builder: (_, snap) => DropdownButton<String?>(
              value: snap.data,
              dropdownColor: MeshColors.bgTertiary,
              style: kMonoStyle.copyWith(
                color: MeshColors.textPrimary,
                fontSize: 12,
              ),
              underline: Container(height: 1, color: MeshColors.border),
              items: [
                const DropdownMenuItem(value: null, child: Text('All Events')),
                for (final k in _kKinds)
                  DropdownMenuItem(value: k, child: Text(k)),
              ],
              onChanged: store.setKindFilter,
            ),
          ),
        ],
      ),
    ),
  );

  Widget _row(EventRow row, bool multi, Map<String, String> handles) {
    final e = row.primary;
    // The event API resolves message bodies from the durable mesh-chat record.
    // Message-event details are delivery IDs, so render that prose instead.
    final isMessage = e.kind == 'message_sent' || e.kind == 'message_received';
    final detail = row.isCoalesced
        ? (row.yielded!.body ?? e.detail)
        : (isMessage ? (e.body ?? e.detail) : e.detail);

    Widget? peerLabel;
    String? directionPeer;
    bool hasDirection = false;
    if (e.payload != null && e.payload!.isNotEmpty) {
      try {
        final decoded = jsonDecode(e.payload!) as Map<String, dynamic>;
        if (e.kind == 'message_sent' && decoded.containsKey('to')) {
          directionPeer = decoded['to'] as String?;
          hasDirection = true;
        } else if (e.kind == 'message_received' && decoded.containsKey('from')) {
          directionPeer = decoded['from'] as String?;
          hasDirection = true;
        }
      } catch (_) {}
    }

    if ((e.kind == 'message_sent' || e.kind == 'message_received') && hasDirection) {
      final display = (directionPeer != null && directionPeer.isNotEmpty)
          ? (handles[directionPeer] ?? directionPeer)
          : 'unknown';
      final prep = e.kind == 'message_sent' ? 'to' : 'from';
      peerLabel = Text(
        '$prep $display',
        style: kMonoStyle.copyWith(
          color: MeshColors.textMuted,
          fontSize: 11,
        ),
      );
    } else if (e.parentId != null) {
      peerLabel = Tooltip(
        message: 'Parent',
        child: Text(
          '→ ${handles[e.parentId] ?? e.parentId}',
          style: kMonoStyle.copyWith(
            color: MeshColors.textMuted,
            fontSize: 11,
          ),
        ),
      );
    } else if (e.handleId != null) {
      peerLabel = Tooltip(
        message: 'Handle',
        child: Text(
          '→ ${handles[e.handleId] ?? e.handleId}',
          style: kMonoStyle.copyWith(
            color: MeshColors.textMuted,
            fontSize: 11,
          ),
        ),
      );
    }

    return Container(
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: MeshColors.border, width: 0.5),
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 152,
            child: Text(
              formatTs(e.ts),
              style: kMonoStyle.copyWith(
                color: MeshColors.textMuted,
                fontSize: 12,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Wrap (not Row) so the chip/pill/peer cluster reflows onto a
                // second line instead of overflowing on narrow (mobile) widths.
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    KindChip(kind: e.kind),
                    // The merged yield surfaced as a compact status pill, so the
                    // single row still shows the run both ended and yielded.
                    if (row.isCoalesced) _yieldPill(row.yieldStatus ?? ''),
                    if (multi && e.actorId != null)
                      _actorBadge(handles[e.actorId] ?? e.actorId!),
                    ?peerLabel,
                  ],
                ),
                if ((detail ?? '').isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    detail!,
                    style: const TextStyle(
                      color: MeshColors.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Amber `yielded · <status>` pill appended to a coalesced run_end row.
  Widget _yieldPill(String status) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(
      color: KindChipColors.forKind('run_yielded').withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      status.isEmpty ? 'yielded' : 'yielded · $status',
      style: kMonoStyle.copyWith(
        fontSize: 11,
        color: KindChipColors.forKind('run_yielded'),
      ),
    ),
  );

  Widget _actorBadge(String handle) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(
      color: MeshColors.accent.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      handle,
      style: kMonoStyle.copyWith(fontSize: 11, color: MeshColors.accent),
    ),
  );

  Widget _loadMore(EventsView view) {
    if (view.loading) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    if (!view.hasMore) return const SizedBox(height: 16);
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Center(
        child: OutlinedButton(
          onPressed: store.loadMoreEvents,
          style: OutlinedButton.styleFrom(
            foregroundColor: MeshColors.accent,
            side: const BorderSide(color: MeshColors.border),
          ),
          child: const Text('Load More'),
        ),
      ),
    );
  }

  Widget _empty(String msg) => Center(
    child: Text(msg, style: const TextStyle(color: MeshColors.textMuted)),
  );
}
