import 'dart:async';
import 'package:flutter/material.dart';
import 'package:rxdart/rxdart.dart';

import '../breakpoints.dart';
import '../models.dart';
import '../principals.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'avatar.dart';
import 'header.dart';
import 'inbox_item_row.dart';
import 'obligation_card.dart';
import 'obligation_status.dart';
import 'obligation_dialogs.dart';
import 'quota_history_chart.dart';

/// Overview tab: displays quota history, my obligations queue, live workers, queued actors, and yields.
class OverviewTab extends StatefulWidget {
  const OverviewTab({super.key, required this.store, this.onSelectView});

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
  StreamSubscription<String?>? _viewerPrincipalSub;

  /// Re-renders queued cards' relative "Runs in ~N min" labels as time passes
  /// between snapshots; idle while nothing is queued.
  Timer? _startLabelTick;

  /// The ids this queue is "mine" for: the durable user principal the server
  /// resolved plus the legacy alias, so a database that is only partly
  /// migrated still shows every obligation the person owns.
  List<String> get _viewerOwnerIds =>
      viewerPrincipalIds(widget.store.dashboardConfig.value?.userPrincipalId);

  String get _newObligationOwnerId =>
      viewerOwnerId(widget.store.dashboardConfig.value?.userPrincipalId);

  Future<Map<String, dynamic>> _loadHumanQueue() async {
    final api = widget.store.api;
    final ownerIds = _viewerOwnerIds;
    final results = await Future.wait([
      for (final ownerId in ownerIds) api.fetchObligations(ownerId: ownerId),
      // Fetched as its own filtered page rather than carved out of the
      // unfiltered page above: with enough ready/waiting rows, that page's
      // limit could be exhausted before a single scheduled row appears in
      // it, silently dropping every scheduled row from this section.
      for (final ownerId in ownerIds)
        api.fetchObligations(ownerId: ownerId, status: 'scheduled'),
    ]);
    // One obligation has one owner, but the two ids are queried separately,
    // so dedupe by id rather than trusting the pages to be disjoint.
    List<ObligationDto> merge(Iterable<ObligationPage> pages) {
      final byId = <String, ObligationDto>{};
      for (final page in pages) {
        for (final o in page.obligations) {
          byId.putIfAbsent(o.id, () => o);
        }
      }
      return byId.values.toList();
    }

    final owned = merge(results.take(ownerIds.length));
    final ready = owned.where((o) => o.isReady).toList();
    final waiting = owned.where((o) => o.isWaiting).toList();
    final scheduled = merge(results.skip(ownerIds.length))
      ..sort((a, b) => (a.nextReadyAt ?? '').compareTo(b.nextReadyAt ?? ''));
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
      'scheduled': scheduled,
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
    // The dashboard config — and with it the durable user principal — is
    // fetched after init returns, so this first load can only have asked for
    // the alias. Re-ask once the server names the viewing principal, or a
    // migrated instance would show an empty queue until a manual refresh.
    _viewerPrincipalSub = widget.store.dashboardConfig
        .map((c) => c?.userPrincipalId)
        .distinct()
        .skip(1)
        .listen((_) {
          if (mounted) _refreshHumanQueue();
        });
    _startLabelTick = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted && widget.store.actorStates.value.queuedActors.isNotEmpty) {
        setState(() {});
      }
    });
  }

  @override
  void dispose() {
    _viewerPrincipalSub?.cancel();
    _startLabelTick?.cancel();
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
          _buildQueueAndCharts(),
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

  /// The existing dashboard breakpoint keeps the operator's queue beside the
  /// quota chart when there is room, while preserving a readable queue-first
  /// flow on phone-sized displays.
  Widget _buildQueueAndCharts() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final queue = _buildMyQueueSection();
        final charts = _buildQuotaPoolsCard();
        if (constraints.maxWidth < kNarrowBreakpoint) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [queue, const SizedBox(height: 20), charts],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: queue),
            const SizedBox(width: 20),
            Expanded(child: charts),
          ],
        );
      },
    );
  }

  /// Section title row: icon + title (ellipsizes first) + optional trailing
  /// counter, so long titles don't push a fixed-width counter off-screen at
  /// narrow widths.
  Widget _sectionHeader(
    IconData icon,
    Color iconColor,
    String title, {
    Widget? trailing,
  }) {
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

  /// My obligations queue for the viewing person, under every id they hold.
  Widget _buildMyQueueSection() {
    return FutureBuilder<Map<String, dynamic>>(
      future: _humanQueueFuture,
      builder: (context, snap) {
        final ready = snap.data?['ready'] as List<ObligationDto>? ?? const [];
        final waiting =
            snap.data?['waiting'] as List<ObligationDto>? ?? const [];
        final scheduled =
            snap.data?['scheduled'] as List<ObligationDto>? ?? const [];
        final blockerMap =
            snap.data?['blockerMap'] as Map<String, List<ObligationDto>>? ??
            const {};
        final totalCount = ready.length + waiting.length + scheduled.length;

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
                      defaultOwnerId: _newObligationOwnerId,
                      onCreated: _refreshHumanQueue,
                    ),
                    icon: const Icon(Icons.add, size: 14),
                    label: const Text(
                      'New Obligation',
                      style: TextStyle(fontSize: 11),
                    ),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      foregroundColor: MeshColors.accent,
                    ),
                  )
                else
                  IconButton(
                    icon: const Icon(
                      Icons.add,
                      size: 16,
                      color: MeshColors.accent,
                    ),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(
                      minWidth: 28,
                      minHeight: 28,
                    ),
                    tooltip: 'New Obligation',
                    onPressed: () => showCreateObligationDialog(
                      context,
                      widget.store,
                      defaultOwnerId: _newObligationOwnerId,
                      onCreated: _refreshHumanQueue,
                    ),
                  ),
                IconButton(
                  icon: const Icon(
                    Icons.refresh,
                    size: 16,
                    color: MeshColors.textSecondary,
                  ),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 28,
                    minHeight: 28,
                  ),
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
                  if (snap.connectionState != ConnectionState.done &&
                      snap.data == null)
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
                                  style: const TextStyle(
                                    color: MeshColors.textMuted,
                                    fontSize: 13,
                                  ),
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
                                    style: const TextStyle(
                                      color: MeshColors.textMuted,
                                      fontSize: 13,
                                    ),
                                  ),
                                ),
                                TextButton(
                                  onPressed: _refreshHumanQueue,
                                  child: const Text('Retry'),
                                ),
                              ],
                            ),
                    )
                  else if (ready.isEmpty &&
                      waiting.isEmpty &&
                      scheduled.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: isNarrow
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'No obligations in your queue.',
                                  style: TextStyle(
                                    color: MeshColors.textMuted,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 10),
                                ElevatedButton.icon(
                                  onPressed: () => showCreateObligationDialog(
                                    context,
                                    widget.store,
                                    defaultOwnerId: _newObligationOwnerId,
                                    onCreated: _refreshHumanQueue,
                                  ),
                                  icon: const Icon(Icons.add, size: 14),
                                  label: const Text(
                                    'Create Obligation',
                                    style: TextStyle(fontSize: 12),
                                  ),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: MeshColors.accent,
                                    foregroundColor: MeshColors.bgPrimary,
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 12,
                                      vertical: 8,
                                    ),
                                    minimumSize: Size.zero,
                                    tapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              ],
                            )
                          : Wrap(
                              alignment: WrapAlignment.spaceBetween,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              runSpacing: 10,
                              children: [
                                const Text(
                                  'No obligations in your queue.',
                                  style: TextStyle(
                                    color: MeshColors.textMuted,
                                    fontSize: 13,
                                  ),
                                ),
                                ElevatedButton.icon(
                                  onPressed: () => showCreateObligationDialog(
                                    context,
                                    widget.store,
                                    defaultOwnerId: _newObligationOwnerId,
                                    onCreated: _refreshHumanQueue,
                                  ),
                                  icon: const Icon(Icons.add, size: 14),
                                  label: const Text(
                                    'Create Obligation',
                                    style: TextStyle(fontSize: 12),
                                  ),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: MeshColors.accent,
                                    foregroundColor: MeshColors.bgPrimary,
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 12,
                                      vertical: 8,
                                    ),
                                    minimumSize: Size.zero,
                                    tapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              ],
                            ),
                    )
                  else ...[
                    if (ready.isNotEmpty) ...[
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          const Text(
                            'Ready Obligations',
                            style: TextStyle(
                              color: MeshColors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color:
                                  ObligationStatusColors.ready.chipBackground,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '${ready.length} ready',
                              style: kMonoStyle.copyWith(
                                color:
                                    ObligationStatusColors.ready.chipForeground,
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
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          const Text(
                            'Waiting Obligations',
                            style: TextStyle(
                              color: MeshColors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color:
                                  ObligationStatusColors.waiting.chipBackground,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '${waiting.length} waiting',
                              style: kMonoStyle.copyWith(
                                color: ObligationStatusColors
                                    .waiting
                                    .chipForeground,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      _buildQueueList(waiting, blockerMap, isReadyList: false),
                      if (scheduled.isNotEmpty) const SizedBox(height: 16),
                    ],
                    if (scheduled.isNotEmpty) ...[
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          const Text(
                            'Scheduled Obligations',
                            style: TextStyle(
                              color: MeshColors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color: ObligationStatusColors
                                  .scheduled
                                  .chipBackground,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '${scheduled.length} scheduled',
                              style: kMonoStyle.copyWith(
                                color: ObligationStatusColors
                                    .scheduled
                                    .chipForeground,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      _buildQueueList(scheduled, const {}, isReadyList: false),
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
  }

  Widget _buildQueueItemCard(
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
      showKindChip: false,
      onMutated: _refreshHumanQueue,
      contentPadding: const EdgeInsets.all(12),
      showReorder: isReadyList && items.length > 1,
      onMoveUp: index > 0
          ? () async {
              final previousId = index - 2 >= 0 ? items[index - 2].id : null;
              final nextId = items[index - 1].id;
              try {
                await widget.store.mutateObligations(
                  () => widget.store.api.reorderObligation(
                    o.id,
                    previousId: previousId,
                    nextId: nextId,
                  ),
                );
                _refreshHumanQueue();
              } catch (err) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Failed to reorder: $err'),
                      backgroundColor: MeshColors.statusHalted,
                    ),
                  );
                }
              }
            }
          : null,
      onMoveDown: index < items.length - 1
          ? () async {
              final previousId = items[index + 1].id;
              final nextId = index + 2 < items.length
                  ? items[index + 2].id
                  : null;
              try {
                await widget.store.mutateObligations(
                  () => widget.store.api.reorderObligation(
                    o.id,
                    previousId: previousId,
                    nextId: nextId,
                  ),
                );
                _refreshHumanQueue();
              } catch (err) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Failed to reorder: $err'),
                      backgroundColor: MeshColors.statusHalted,
                    ),
                  );
                }
              }
            }
          : null,
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
                StreamBuilder<Map<String, RunModelSelection>>(
                  stream: widget.store.runSelections,
                  initialData: widget.store.runSelections.value,
                  builder: (context, selectionSnap) {
                    final selections = selectionSnap.data ?? const {};
                    return LayoutBuilder(
                      builder: (context, constraints) {
                        final itemWidth = constraints.maxWidth < 600
                            ? constraints.maxWidth
                            : (constraints.maxWidth - 12) / 2;
                        return Wrap(
                          spacing: 12,
                          runSpacing: 12,
                          children: [
                            for (final t in runningThreads)
                              _buildActorContextCard(
                                t,
                                width: itemWidth,
                                selection: selections[t.id],
                              ),
                          ],
                        );
                      },
                    );
                  },
                ),
            ],
          ),
        );
      },
    );
  }

  /// Queue entries are separate from idle actors, sorted by expected run
  /// order (`ActorStateSnapshot.queuedActors`). Each entry shows the
  /// scheduler's current estimate, or an honest "unknown" when pacing state
  /// doesn't support one yet.
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
                  style: kMonoStyle.copyWith(
                    color: MeshColors.statusIdle,
                    fontSize: 12,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Actors waiting for a provider slot, sorted by expected run '
                'order. Each shows the scheduler\'s current estimate, which '
                'shifts as pacing changes.',
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
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _buildActorContextCard(
                      actor,
                      queued: true,
                      selection: actor.reservedSelection,
                    ),
                  ),
            ],
          ),
        );
      },
    );
  }

  /// Shared actor context for the overview's running and queued sections.
  /// The header remains the actor-navigation target; the optional obligation
  /// row keeps its own Work-tab navigation rather than being swallowed by the
  /// actor tap target.
  ///
  /// A [queued] card says when it expects to run under its title and, when
  /// wide enough, lays its inbox item out as a column beside the identity, so
  /// a long queue scans as one row per actor; narrower cards keep it below.
  ///
  /// [selection] is the run's model — started, or reserved while queued — and
  /// follows the handle as the mechanical signature does:
  /// `handle (model, effort)`.
  Widget _buildActorContextCard(
    ActorViewState actor, {
    double? width,
    bool queued = false,
    RunModelSelection? selection,
  }) {
    final selectedObligation = actor.selectedObligation;
    final startLabel = queued ? _queueStartLabel(actor) : null;
    final header = InkWell(
      onTap: () => _navigateToActor(actor.id),
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          // The avatar heads the identity cluster rather than floating at the
          // middle of its three lines.
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ActorAvatarWithStatus(
              id: actor.id,
              state: actor.dotState,
              size: 40,
              retired: actor.isRetired,
              store: widget.store,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text.rich(
                    TextSpan(
                      text: actor.handle,
                      children: [
                        if (selection != null)
                          TextSpan(
                            text: ' (${selection.label})',
                            style: const TextStyle(
                              color: MeshColors.textSecondary,
                              fontWeight: FontWeight.w400,
                            ),
                          ),
                      ],
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textPrimary,
                      fontWeight: FontWeight.w700,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    actor.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: MeshColors.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                  if (startLabel != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      startLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: kMonoStyle.copyWith(
                        color: MeshColors.statusIdle,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
    final Widget? focusContent = selectedObligation != null
        ? ObligationRow(
            obligation: selectedObligation,
            store: widget.store,
            showActions: false,
            contentPadding: const EdgeInsets.all(12),
            onSelectView: widget.onSelectView,
          )
        : actor.selectedInboxItem != null
        ? InboxItemRow(
            entry: actor.selectedInboxItem!,
            moreCount: actor.moreInboxItemsCount,
            store: widget.store,
            onSelectView: widget.onSelectView,
          )
        : null;
    // An inbox item that renders as its reference's own card needs no frame.
    final framed =
        selectedObligation != null ||
        actor.selectedInboxItem == null ||
        !InboxItemRow.rendersOwnFrame(actor.selectedInboxItem!);
    final focus = focusContent == null
        ? null
        : !framed
        ? focusContent
        : Container(
            decoration: BoxDecoration(
              color: MeshColors.bgSecondary,
              borderRadius: BorderRadius.circular(5),
              border: Border.all(color: MeshColors.border),
            ),
            child: focusContent,
          );
    return Container(
      width: width,
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: MeshColors.border),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (queued &&
              focus != null &&
              constraints.maxWidth >= _kQueuedFocusColumnMinWidth) {
            // Top-aligned: a tall inbox card must not float the actor down to
            // its middle.
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: header),
                Expanded(
                  flex: 3,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(0, 12, 12, 12),
                    child: focus,
                  ),
                ),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              header,
              if (focus != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                  child: focus,
                ),
            ],
          );
        },
      ),
    );
  }

  /// Tail of recent actor yield events section (Core feature).
  Widget _buildYieldEventsSection() {
    return StreamBuilder<List<Object?>>(
      stream:
          Rx.combineLatest2<List<MeshEvent>, ActorStateSnapshot, List<Object?>>(
            widget.store.yieldEvents,
            widget.store.actorStates,
            (yields, actorStates) => [yields, actorStates],
          ),
      builder: (context, snap) {
        final yields = widget.store.yieldEvents.value;
        final actorStates = widget.store.actorStates.value.actors.values;
        final handles = {
          for (final a in actorStates) a.thread.id: a.thread.handle,
        };

        // Filter by search query & status filter
        final filtered = yields.where((e) {
          if (_statusFilter != null && _statusFilter!.isNotEmpty) {
            if (e.detail != _statusFilter) return false;
          }
          if (_searchQuery.isNotEmpty) {
            final handle = (handles[e.actorId] ?? e.actorId ?? '')
                .toLowerCase();
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
                      style: TextStyle(
                        color: MeshColors.textMuted,
                        fontSize: 13,
                      ),
                    ),
                  ),
                )
              else
                ListView.separated(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: filtered.length,
                  separatorBuilder: (_, _) =>
                      const Divider(height: 1, color: MeshColors.border),
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
            style: kMonoStyle.copyWith(
              color: MeshColors.textPrimary,
              fontSize: 12,
            ),
            decoration: InputDecoration(
              hintText: 'Search handle or message...',
              hintStyle: kMonoStyle.copyWith(
                color: MeshColors.textMuted,
                fontSize: 12,
              ),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 10,
                vertical: 8,
              ),
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
    final handle = Text(
      widget.store.actorDisplay(actorId),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: kMonoStyle.copyWith(
        color: MeshColors.textPrimary,
        fontSize: 12.5,
        fontWeight: FontWeight.w700,
      ),
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
                    Flexible(child: handle),
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
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 180),
                child: Padding(
                  // Level with the pill's text beside the 28px avatar.
                  padding: const EdgeInsets.only(top: 3),
                  child: handle,
                ),
              ),
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

  /// When a queued card expects to run, in relative terms: the pacer's
  /// estimate as "Runs in ~8 min", or — when it can't honestly quote one —
  /// what the run is waiting on. A null estimate at lane position 0 is the
  /// staged head holding for a mesh concurrency slot; further back, a request
  /// behind that head.
  String _queueStartLabel(ActorViewState actor) {
    final estimate = actor.estimatedStartAt;
    if (estimate != null) {
      final startsIn = formatStartsIn(estimate);
      return startsIn == null ? 'Starting shortly' : 'Runs $startsIn';
    }
    final position = actor.queuePosition;
    if (position == 0) return 'Runs when a slot frees up';
    if (position != null) {
      return position == 1
          ? 'Runs after 1 queued run'
          : 'Runs after $position queued runs';
    }
    return actor.waitingOn ?? 'Waiting for a provider slot';
  }
}

/// Narrowest queued card that lays its inbox item out beside the identity.
/// The identity takes a quarter and the inbox item three quarters, so this
/// keeps the identity at least 280px — room for a handle, model, and title.
const double _kQueuedFocusColumnMinWidth = 1120;
