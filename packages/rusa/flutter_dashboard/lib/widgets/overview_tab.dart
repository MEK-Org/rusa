import 'dart:async';
import 'package:flutter/material.dart';
import 'package:rxdart/rxdart.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'avatar.dart';
import 'header.dart';
import 'obligation_card.dart';
import 'obligation_dialogs.dart';
import 'quota_history_chart.dart';
import 'status_dot.dart';

/// Overview tab: displays quota history, my obligations queue, live workers, queued actors, and yields.
class OverviewTab extends StatefulWidget {
  const OverviewTab({
    super.key,
    required this.store,
    this.onSelectView,
  });

  final DashboardStore store;
  final ValueChanged<DashboardView>? onSelectView;

  @override
  State<OverviewTab> createState() => _OverviewTabState();
}
class _OverviewTabState extends State<OverviewTab> {
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';
  String? _statusFilter;
  late Future<Map<String, dynamic>> _humanQueueFuture;

  Future<Map<String, dynamic>> _loadHumanQueue() async {
    final api = widget.store.api;
    final page = await api.fetchObligations(
      ownerId: 'human:operator',
    );
    final ready = page.obligations.where((o) => o.isReady).toList();
    final waiting = page.obligations.where((o) => o.isWaiting).toList();
    final blockers = await Future.wait(
      waiting.map((o) => api.fetchObligationDetail(o.id)),
    );
    final blockerMap = {
      for (var i = 0; i < waiting.length; i++)
        waiting[i].id: blockers[i].blockingChildren,
    };
    return {
      'ready': ready,
      'waiting': waiting,
      'blockerMap': blockerMap,
    };
  }

  void _refreshHumanQueue() {
    setState(() {
      _humanQueueFuture = _loadHumanQueue();
    });
  }

  @override
  void initState() {
    super.initState();
    widget.store.refreshYieldEvents();
    widget.store.refreshQuotaHistory();
    _humanQueueFuture = _loadHumanQueue();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _navigateToActor(String actorId) {
    widget.store.clickActor(actorId);
    widget.onSelectView?.call(DashboardView.actors);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _buildQuotaPoolsCard(),
          const SizedBox(height: 20),
          _buildMyQueueSection(),
          const SizedBox(height: 20),
          _buildRunningWorkersSection(),
          const SizedBox(height: 20),
          _buildQueuedActorsSection(),
          const SizedBox(height: 20),
          _buildYieldEventsSection(),
        ],
      ),
    );
  }

  /// Section title row: icon + title (ellipsizes first) + optional trailing
  /// counter, so long titles don't push a fixed-width counter off-screen at
  /// narrow widths.
  Widget _sectionHeader(IconData icon, Color iconColor, String title, {Widget? trailing}) {
    return Row(
      children: [
        Icon(icon, size: 18, color: iconColor),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: MeshColors.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        if (trailing != null) ...[const SizedBox(width: 8), trailing],
      ],
    );
  }

  /// Quota pacing over the prior 3 days, backed by durable provider scrapes.
  Widget _buildQuotaPoolsCard() {
    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatest2<QuotaHistoryDto?, bool, List<Object?>>(
        widget.store.quotaHistory,
        widget.store.quotaHistoryStale,
        (history, stale) => [history, stale],
      ),
      builder: (context, snap) {
        final history = widget.store.quotaHistory.valueOrNull;
        final stale = widget.store.quotaHistoryStale.valueOrNull ?? false;
        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: MeshColors.bgSecondary,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: MeshColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _sectionHeader(
                Icons.show_chart,
                MeshColors.accent,
                'Quota Pacing — Prior 3 Days',
              ),
              const SizedBox(height: 4),
              const Text(
                'How each provider has been pacing through its weekly quota '
                'over the last three days.',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 11),
              ),
              const SizedBox(height: 14),
              if (history == null)
                const Text(
                  'Quota history unavailable.',
                  style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                )
              else
                QuotaHistoryChart(history: history, isStale: stale),
            ],
          ),
        );
      },
    );
  }

  /// My obligations queue for the viewing human operator (human:operator).
  Widget _buildMyQueueSection() {
    return FutureBuilder<Map<String, dynamic>>(
      future: _humanQueueFuture,
      builder: (context, snap) {
        final ready = snap.data?['ready'] as List<ObligationDto>? ?? const [];
        final waiting = snap.data?['waiting'] as List<ObligationDto>? ?? const [];
        final blockerMap = snap.data?['blockerMap'] as Map<String, List<ObligationDto>>? ?? const {};
        final totalCount = ready.length + waiting.length;

        return LayoutBuilder(
          builder: (_, constraints) {
            final isNarrow = constraints.maxWidth < 480;

            final trailingControls = Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '$totalCount ${totalCount == 1 ? 'obligation' : 'obligations'}',
                  style: kMonoStyle.copyWith(
                    color: MeshColors.accent,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(width: 8),
                if (!isNarrow)
                  TextButton.icon(
                    onPressed: () => showCreateObligationDialog(
                      context,
                      widget.store,
                      defaultOwnerId: 'human:operator',
                      onCreated: _refreshHumanQueue,
                    ),
                    icon: const Icon(Icons.add, size: 14),
                    label: const Text('New Obligation', style: TextStyle(fontSize: 11)),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      foregroundColor: MeshColors.accent,
                    ),
                  )
                else
                  IconButton(
                    icon: const Icon(Icons.add, size: 16, color: MeshColors.accent),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                    tooltip: 'New Obligation',
                    onPressed: () => showCreateObligationDialog(
                      context,
                      widget.store,
                      defaultOwnerId: 'human:operator',
                      onCreated: _refreshHumanQueue,
                    ),
                  ),
                IconButton(
                  icon: const Icon(Icons.refresh, size: 16, color: MeshColors.textSecondary),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                  tooltip: 'Refresh Queue',
                  onPressed: _refreshHumanQueue,
                ),
              ],
            );

            return Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: MeshColors.bgSecondary,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: MeshColors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _sectionHeader(
                    Icons.assignment_outlined,
                    MeshColors.accent,
                    'My Queue',
                    trailing: trailingControls,
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'The obligations you own, with the ones ready to work on '
                    'first. Tap an obligation to open it in Work.',
                    style: TextStyle(color: MeshColors.textMuted, fontSize: 11),
                  ),
                  const SizedBox(height: 14),
                  if (snap.connectionState != ConnectionState.done && snap.data == null)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 20),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (snap.hasError && snap.data == null)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: isNarrow
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Queue unavailable: ${snap.error}',
                                  style: const TextStyle(color: MeshColors.textMuted, fontSize: 13),
                                ),
                                const SizedBox(height: 8),
                                TextButton(
                                  onPressed: _refreshHumanQueue,
                                  child: const Text('Retry'),
                                ),
                              ],
                            )
                          : Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    'Queue unavailable: ${snap.error}',
                                    style: const TextStyle(color: MeshColors.textMuted, fontSize: 13),
                                  ),
                                ),
                                TextButton(
                                  onPressed: _refreshHumanQueue,
                                  child: const Text('Retry'),
                                ),
                              ],
                            ),
                    )
                  else if (ready.isEmpty && waiting.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: isNarrow
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'No obligations in your queue.',
                                  style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                                ),
                                const SizedBox(height: 10),
                                ElevatedButton.icon(
                                  onPressed: () => showCreateObligationDialog(
                                    context,
                                    widget.store,
                                    defaultOwnerId: 'human:operator',
                                    onCreated: _refreshHumanQueue,
                                  ),
                                  icon: const Icon(Icons.add, size: 14),
                                  label: const Text('Create Obligation', style: TextStyle(fontSize: 12)),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: MeshColors.accent,
                                    foregroundColor: MeshColors.bgPrimary,
                                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                    minimumSize: Size.zero,
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              ],
                            )
                          : Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                const Text(
                                  'No obligations in your queue.',
                                  style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                                ),
                                ElevatedButton.icon(
                                  onPressed: () => showCreateObligationDialog(
                                    context,
                                    widget.store,
                                    defaultOwnerId: 'human:operator',
                                    onCreated: _refreshHumanQueue,
                                  ),
                                  icon: const Icon(Icons.add, size: 14),
                                  label: const Text('Create Obligation', style: TextStyle(fontSize: 12)),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: MeshColors.accent,
                                    foregroundColor: MeshColors.bgPrimary,
                                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                    minimumSize: Size.zero,
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              ],
                            ),
                    )
                  else ...[
                    if (ready.isNotEmpty) ...[
                      Row(
                        children: [
                          const Text(
                            'Ready Obligations',
                            style: TextStyle(
                              color: MeshColors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: const Color(0xFF064E3B),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '${ready.length} ready',
                              style: kMonoStyle.copyWith(
                                color: const Color(0xFF34D399),
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      _buildQueueList(ready, blockerMap, isReadyList: true),
                      if (waiting.isNotEmpty) const SizedBox(height: 16),
                    ],
                    if (waiting.isNotEmpty) ...[
                      Row(
                        children: [
                          const Text(
                            'Waiting Obligations',
                            style: TextStyle(
                              color: MeshColors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: const Color(0xFF78350F),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '${waiting.length} waiting',
                              style: kMonoStyle.copyWith(
                                color: const Color(0xFFFBBF24),
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      _buildQueueList(waiting, blockerMap, isReadyList: false),
                    ],
                  ],
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildQueueList(
    List<ObligationDto> items,
    Map<String, List<ObligationDto>> blockerMap, {
    required bool isReadyList,
  }) {
    return Container(
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        children: [
          for (var i = 0; i < items.length; i++) ...[
            _buildQueueItemCard(
              items[i],
              blockerMap[items[i].id],
              items: items,
              index: i,
              isReadyList: isReadyList,
            ),
            if (i < items.length - 1)
              const Divider(height: 1, color: MeshColors.border),
          ],
        ],
      ),
    );
  }  Widget _buildQueueItemCard(
    ObligationDto o,
    List<ObligationDto>? blockers, {
    required List<ObligationDto> items,
    required int index,
    required bool isReadyList,
  }) {
    return ObligationRow(
      obligation: o,
      store: widget.store,
      blockers: blockers,
      onSelectView: widget.onSelectView,
      onMutated: _refreshHumanQueue,
      contentPadding: const EdgeInsets.all(12),
      showReorder: isReadyList && items.length > 1,
      onMoveUp: index > 0 ? () async {
        final previousId = index - 2 >= 0 ? items[index - 2].id : null;
        final nextId = items[index - 1].id;
        try {
          await widget.store.api.reorderObligation(
            o.id,
            previousId: previousId,
            nextId: nextId,
          );
          _refreshHumanQueue();
        } catch (err) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Failed to reorder: $err'), backgroundColor: MeshColors.statusHalted),
            );
          }
        }
      } : null,
      onMoveDown: index < items.length - 1 ? () async {
        final previousId = items[index + 1].id;
        final nextId = index + 2 < items.length ? items[index + 2].id : null;
        try {
          await widget.store.api.reorderObligation(
            o.id,
            previousId: previousId,
            nextId: nextId,
          );
          _refreshHumanQueue();
        } catch (err) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Failed to reorder: $err'), backgroundColor: MeshColors.statusHalted),
            );
          }
        }
      } : null,
    );
  }

  /// Only actors with a live provider run at this instant.
  Widget _buildRunningWorkersSection() {
    return StreamBuilder<ActorStateSnapshot>(
      stream: widget.store.actorStates,
      builder: (context, snap) {
        final snapshot = snap.data ?? widget.store.actorStates.value;
        final runningThreads = snapshot.runningActors;

        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: MeshColors.bgSecondary,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: MeshColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _sectionHeader(
                Icons.smart_toy_outlined,
                MeshColors.accent,
                'Running Mesh Workers',
                trailing: Text(
                  '${runningThreads.length} running',
                  style: kMonoStyle.copyWith(
                    color: MeshColors.accent,
                    fontSize: 12,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'The actors working right now. Tap one to open it.',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 11),
              ),
              const SizedBox(height: 14),
              if (runningThreads.isEmpty)
                const Text(
                  'No mesh workers are running right now.',
                  style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                )
              else
                LayoutBuilder(
                  builder: (context, constraints) {
                    final itemWidth = constraints.maxWidth < 600
                        ? constraints.maxWidth
                        : (constraints.maxWidth - 12) / 2;
                    return Wrap(
                      spacing: 12,
                      runSpacing: 12,
                      children: [
                        for (final t in runningThreads)
                          InkWell(
                            onTap: () => _navigateToActor(t.id),
                            borderRadius: BorderRadius.circular(6),
                            child: Container(
                              width: itemWidth,
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: MeshColors.bgTertiary,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: MeshColors.border),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      StatusDot(state: t.dotState),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Text(
                                          t.handle,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: kMonoStyle.copyWith(
                                            color: MeshColors.textPrimary,
                                            fontWeight: FontWeight.w700,
                                            fontSize: 13,
                                          ),
                                        ),
                                      ),
                                      if (t.parentId != null)
                                        Text(
                                          'parent: ${t.parentId}',
                                          style: kMonoStyle.copyWith(
                                            color: MeshColors.textMuted,
                                            fontSize: 11,
                                          ),
                                        ),
                                    ],
                                  ),
                                  if (t.charter.isNotEmpty) ...[
                                    const SizedBox(height: 6),
                                    Text(
                                      t.charter,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        color: MeshColors.textSecondary,
                                        fontSize: 12,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ),
                      ],
                    );
                  },
                ),
            ],
          ),
        );
      },
    );
  }

  /// Queue entries are separate from idle actors. The provider queue head gets
  /// its exact eligible-start time; every other queued actor has no ETA.
  Widget _buildQueuedActorsSection() {
    return StreamBuilder<ActorStateSnapshot>(
      stream: widget.store.actorStates,
      builder: (context, snap) {
        final snapshot = snap.data ?? widget.store.actorStates.value;
        final queued = snapshot.queuedActors;
        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: MeshColors.bgSecondary,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: MeshColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _sectionHeader(
                Icons.schedule,
                MeshColors.statusIdle,
                'Queued Actors',
                trailing: Text(
                  '${queued.length} queued',
                  style: kMonoStyle.copyWith(color: MeshColors.statusIdle, fontSize: 12),
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'The actors waiting for a provider slot. The actor at the head '
                'of each provider queue shows when its slot opens.',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 11),
              ),
              const SizedBox(height: 14),
              if (queued.isEmpty)
                const Text(
                  'No actors are queued.',
                  style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                )
              else
                for (final actor in queued)
                  InkWell(
                    onTap: () => _navigateToActor(actor.id),
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Row(
                        children: [
                          StatusDot(state: actor.dotState),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              actor.handle,
                              style: kMonoStyle.copyWith(
                                color: MeshColors.textPrimary,
                                fontSize: 13,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          Flexible(
                            child: Text(
                              actor.nextProviderAvailableAt != null
                                  ? 'Provider slot opens ${formatTs(actor.nextProviderAvailableAt!)}'
                                  : actor.waitingOn ?? 'Queued behind another provider request.',
                              textAlign: TextAlign.right,
                              style: kMonoStyle.copyWith(
                                color: MeshColors.textSecondary,
                                fontSize: 11,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
            ],
          ),
        );
      },
    );
  }

  /// Tail of recent actor yield events section (Core feature).
  Widget _buildYieldEventsSection() {
    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatest2<List<MeshEvent>, ActorStateSnapshot, List<Object?>>(
        widget.store.yieldEvents,
        widget.store.actorStates,
        (yields, actorStates) => [yields, actorStates],
      ),
      builder: (context, snap) {
        final yields = widget.store.yieldEvents.value;
        final actorStates = widget.store.actorStates.value.actors.values;
        final handles = {for (final a in actorStates) a.thread.id: a.thread.handle};

        // Filter by search query & status filter
        final filtered = yields.where((e) {
          if (_statusFilter != null && _statusFilter!.isNotEmpty) {
            if (e.detail != _statusFilter) return false;
          }
          if (_searchQuery.isNotEmpty) {
            final handle = (handles[e.actorId] ?? e.actorId ?? '').toLowerCase();
            final body = (e.body ?? e.detail ?? '').toLowerCase();
            final q = _searchQuery.toLowerCase();
            if (!handle.contains(q) && !body.contains(q)) return false;
          }
          return true;
        }).toList();

        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: MeshColors.bgSecondary,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: MeshColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _sectionHeader(
                Icons.output_outlined,
                MeshColors.accent,
                'Recent Yields',
                trailing: Text(
                  '${filtered.length} events',
                  style: kMonoStyle.copyWith(
                    color: MeshColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'The most recent times an actor paused and handed control '
                'back, newest first.',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 11),
              ),
              const SizedBox(height: 12),
              _buildYieldFilterBar(),
              const SizedBox(height: 12),
              if (filtered.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Center(
                    child: Text(
                      'No yield events recorded.',
                      style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                    ),
                  ),
                )
              else
                ListView.separated(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: filtered.length,
                  separatorBuilder: (_, _) => const Divider(height: 1, color: MeshColors.border),
                  itemBuilder: (context, i) {
                    return _buildYieldRow(filtered[i]);
                  },
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildYieldFilterBar() {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _searchController,
            style: kMonoStyle.copyWith(color: MeshColors.textPrimary, fontSize: 12),
            decoration: InputDecoration(
              hintText: 'Search handle or message...',
              hintStyle: kMonoStyle.copyWith(color: MeshColors.textMuted, fontSize: 12),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              filled: true,
              fillColor: MeshColors.bgTertiary,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(6),
                borderSide: const BorderSide(color: MeshColors.border),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(6),
                borderSide: const BorderSide(color: MeshColors.border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(6),
                borderSide: const BorderSide(color: MeshColors.accent),
              ),
            ),
            onChanged: (val) => setState(() => _searchQuery = val),
          ),
        ),
        const SizedBox(width: 12),
        DropdownButton<String?>(
          value: _statusFilter,
          dropdownColor: MeshColors.bgTertiary,
          style: kMonoStyle.copyWith(
            color: MeshColors.textPrimary,
            fontSize: 12,
          ),
          underline: Container(height: 1, color: MeshColors.border),
          items: const [
            DropdownMenuItem(value: null, child: Text('All Yields')),
            DropdownMenuItem(value: 'complete', child: Text('complete')),
            DropdownMenuItem(value: 'blocked', child: Text('blocked')),
          ],
          onChanged: (v) => setState(() => _statusFilter = v),
        ),
      ],
    );
  }

  Widget _buildYieldRow(MeshEvent e) {
    final actorId = e.actorId ?? 'unknown';
    final status = e.detail ?? 'yielded';
    final message = e.body ?? e.detail ?? 'No yield summary note provided.';

    final isComplete = status == 'complete';
    final isBlocked = status == 'blocked';

    final pillColor = isComplete
        ? MeshColors.statusActive
        : (isBlocked ? MeshColors.statusIdle : MeshColors.accent);

    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: pillColor.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        'yielded · $status',
        style: kMonoStyle.copyWith(
          fontSize: 11,
          color: pillColor,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
    final timestamp = Text(
      formatTs(e.ts),
      style: kMonoStyle.copyWith(color: MeshColors.textMuted, fontSize: 11),
    );
    final messageText = Text(
      message,
      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13),
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // Below this width the fixed-width timestamp + avatar + pill + gaps
          // leave no viable room for the message on one line, so stack the
          // header (avatar/pill/timestamp) above the message instead.
          if (constraints.maxWidth < 480) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    ActorAvatar(id: actorId, size: 24, store: widget.store),
                    const SizedBox(width: 8),
                    pill,
                    const SizedBox(width: 8),
                    Expanded(
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: timestamp,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                messageText,
              ],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 140, child: timestamp),
              const SizedBox(width: 8),
              ActorAvatar(id: actorId, size: 28, store: widget.store),
              const SizedBox(width: 8),
              pill,
              const SizedBox(width: 12),
              Expanded(child: messageText),
            ],
          );
        },
      ),
    );
  }
}
