import 'dart:async';
import 'package:flutter/material.dart';

import '../actor_display.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'avatar.dart';
import 'header.dart';
import 'obligation_card.dart';
import 'obligation_dialogs.dart';
import 'reference_preview.dart';

class WorkTab extends StatefulWidget {
  const WorkTab({super.key, required this.store, required this.onSelectView});

  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;

  @override
  State<WorkTab> createState() => _WorkTabState();
}

class _WorkTabState extends State<WorkTab> {
  bool _loading = true;
  String? _error;
  List<ObligationTreeDto> _rootTrees = [];
  late final Set<String> _expandedIds = widget.store.workExpanded;
  String? _selectedObligationId;
  StreamSubscription<String?>? _focusSub;
  bool _showDone = false;
  bool _fetchedTerminalRoots = false;

  /// Bumped at the start of every [_loadRoots] call and compared when that
  /// call's future resolves. `_loadRoots` fires from several independent
  /// triggers (initial load, Show Done toggle, retry, mutation callbacks,
  /// on-demand terminal widening) with no ordering guarantee between their
  /// underlying requests, so an older call finishing after a newer one must
  /// not overwrite the newer call's result.
  int _loadGeneration = 0;

  /// [forceIncludeTerminal] widens a single load beyond the current "Show
  /// Done" setting — used when a focus link names an obligation the default
  /// (terminal-excluding) load didn't fetch at all.
  Future<void> _loadRoots({bool forceIncludeTerminal = false}) async {
    final includeTerminal = forceIncludeTerminal || _showDone;
    final generation = ++_loadGeneration;
    try {
      setState(() {
        if (_rootTrees.isEmpty) _loading = true;
        _error = null;
      });
      final forest = await widget.store.api.fetchObligationForest(
        includeTerminalRoots: includeTerminal,
      );
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _rootTrees = forest.trees;
        _fetchedTerminalRoots = includeTerminal;
        _loading = false;
      });
      _checkFocusLink();
    } catch (e) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _checkFocusLink() {
    final focusedId = widget.store.focusedObligationId.valueOrNull;
    if (focusedId == null) return;
    if (!_expandAncestors(focusedId) && !_fetchedTerminalRoots) {
      // The focused obligation may live under a quiet terminal root the
      // default load excluded (#241); widen once before giving up.
      _loadRoots(forceIncludeTerminal: true);
    }
  }

  bool _expandAncestors(String targetId) {
    for (final rootTree in _rootTrees) {
      final path = _findPath(rootTree, targetId);
      if (path != null) {
        setState(() {
          _expandedIds.addAll(path.sublist(0, path.length - 1));
          _selectedObligationId = targetId;
        });
        widget.store.saveWorkExpanded(_expandedIds);
        return true;
      }
    }
    return false;
  }

  List<String>? _findPath(ObligationTreeDto node, String targetId) {
    if (node.obligation.id == targetId) {
      return [targetId];
    }
    for (final child in node.children) {
      final path = _findPath(child, targetId);
      if (path != null) {
        return [node.obligation.id, ...path];
      }
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _loadRoots();
    _focusSub = widget.store.focusedObligationId.listen((focusedId) {
      if (focusedId != null && !_loading) {
        _expandAncestors(focusedId);
      }
    });
  }

  @override
  void dispose() {
    _focusSub?.cancel();
    super.dispose();
  }

  List<_FlatNode> _flattenTree(List<ObligationTreeDto> nodes, int depth) {
    final result = <_FlatNode>[];
    for (final node in nodes) {
      // A terminal obligation still shows if it retains completion history —
      // the same "recurring, or ledger rows survived recurrence being turned
      // off" test the detail panel uses to decide whether to render the
      // COMPLETION HISTORY section at all.
      final visible =
          _showDone ||
          !node.obligation.isTerminal ||
          node.obligation.isRecurring ||
          node.obligation.hasCompletionHistory;
      if (!visible) continue;
      final id = node.obligation.id;
      final hasVisibleChildren = _showDone
          ? node.children.isNotEmpty
          : node.children.any(
              (c) =>
                  !c.obligation.isTerminal ||
                  c.obligation.isRecurring ||
                  c.obligation.hasCompletionHistory,
            );
      final isCollapsed = !_expandedIds.contains(id);
      result.add(
        _FlatNode(node.obligation, depth, hasVisibleChildren, isCollapsed),
      );
      if (hasVisibleChildren && !isCollapsed) {
        result.addAll(_flattenTree(node.children, depth + 1));
      }
    }
    return result;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (_error != null) {
      return Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                'Failed to load work queue: $_error',
                style: const TextStyle(color: MeshColors.textSecondary),
              ),
              const SizedBox(height: 12),
              ElevatedButton(onPressed: _loadRoots, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }

    final flattened = _flattenTree(_rootTrees, 0);

    return Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final isNarrow = constraints.maxWidth < 700;

          if (isNarrow) {
            if (_selectedObligationId != null) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _narrowBackBar(),
                  const Divider(height: 1, color: MeshColors.border),
                  Expanded(
                    child: _DetailView(
                      obligationId: _selectedObligationId!,
                      store: widget.store,
                      onSelectView: widget.onSelectView,
                      onMutated: _loadRoots,
                    ),
                  ),
                ],
              );
            }
            return _sidebar(flattened);
          }

          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(width: 320, child: _sidebar(flattened)),
              const VerticalDivider(width: 1, color: MeshColors.border),
              Expanded(
                child: _selectedObligationId != null
                    ? _DetailView(
                        obligationId: _selectedObligationId!,
                        store: widget.store,
                        onSelectView: widget.onSelectView,
                        onMutated: _loadRoots,
                      )
                    : const Center(
                        child: Text(
                          'Select an obligation from the tree.',
                          style: TextStyle(
                            color: MeshColors.textMuted,
                            fontSize: 14,
                          ),
                        ),
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _narrowBackBar() => Container(
    height: 48,
    padding: const EdgeInsets.symmetric(horizontal: 12),
    color: MeshColors.bgSecondary,
    child: Row(
      children: [
        IconButton(
          icon: const Icon(
            Icons.arrow_back,
            color: MeshColors.textSecondary,
            size: 20,
          ),
          onPressed: () => setState(() => _selectedObligationId = null),
        ),
        const SizedBox(width: 8),
        const Text(
          'Back to List',
          style: TextStyle(
            color: MeshColors.textPrimary,
            fontWeight: FontWeight.w600,
            fontSize: 14,
          ),
        ),
      ],
    ),
  );

  Widget _sidebar(List<_FlatNode> nodes) => Container(
    decoration: const BoxDecoration(color: MeshColors.bgSecondary),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 12, 12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'WORK QUEUE',
                style: TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.8,
                ),
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    icon: Icon(
                      _showDone ? Icons.visibility : Icons.visibility_off,
                      size: 18,
                    ),
                    onPressed: () {
                      setState(() => _showDone = !_showDone);
                      _loadRoots();
                    },
                    tooltip: _showDone ? 'Hide Done' : 'Show Done',
                  ),
                  IconButton(
                    icon: const Icon(Icons.add, size: 18),
                    onPressed: () => showCreateObligationDialog(
                      context,
                      widget.store,
                      onCreated: _loadRoots,
                    ),
                    tooltip: 'New Root Obligation',
                  ),
                  IconButton(
                    icon: const Icon(Icons.refresh, size: 18),
                    onPressed: _loadRoots,
                    tooltip: 'Refresh Queue',
                  ),
                ],
              ),
            ],
          ),
        ),
        const Divider(height: 1, color: MeshColors.border),
        Expanded(
          child: nodes.isEmpty
              ? const Center(
                  child: Text(
                    'No obligations found',
                    style: TextStyle(color: MeshColors.textMuted),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: nodes.length,
                  itemBuilder: (context, index) {
                    final node = nodes[index];
                    final isSelected =
                        node.obligation.id == _selectedObligationId;

                    return InkWell(
                      onTap: () => widget.store.setFocusedObligationId(
                        node.obligation.id,
                      ),
                      child: Container(
                        color: isSelected ? MeshColors.bgSelected : null,
                        padding: EdgeInsets.only(
                          left: 12.0 + (node.depth * 16.0),
                          right: 12.0,
                          top: 8.0,
                          bottom: 8.0,
                        ),
                        child: Row(
                          children: [
                            SizedBox(
                              width: 24,
                              height: 24,
                              child: node.hasChildren
                                  ? IconButton(
                                      padding: EdgeInsets.zero,
                                      icon: Icon(
                                        node.isCollapsed
                                            ? Icons.chevron_right
                                            : Icons.keyboard_arrow_down,
                                        size: 18,
                                        color: MeshColors.textMuted,
                                      ),
                                      onPressed: () {
                                        setState(() {
                                          if (node.isCollapsed) {
                                            _expandedIds.add(
                                              node.obligation.id,
                                            );
                                          } else {
                                            _expandedIds.remove(
                                              node.obligation.id,
                                            );
                                          }
                                        });
                                        widget.store.saveWorkExpanded(
                                          _expandedIds,
                                        );
                                      },
                                    )
                                  : null,
                            ),
                            const SizedBox(width: 4),
                            _statusDot(node.obligation.status),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    node.obligation.heading,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: isSelected
                                          ? MeshColors.textPrimary
                                          : MeshColors.textSecondary,
                                      fontSize: 13,
                                      fontWeight: isSelected
                                          ? FontWeight.bold
                                          : FontWeight.normal,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    ),
  );

  Widget _statusDot(String status) {
    Color color = MeshColors.statusIdle;
    switch (status.toLowerCase()) {
      case 'ready':
        color = MeshColors.statusActive;
        break;
      case 'waiting':
        color = MeshColors.statusIdle;
        break;
      case 'done':
        color = MeshColors.statusRetired;
        break;
      case 'cancelled':
        color = MeshColors.statusHalted;
        break;
      case 'scheduled':
        color = MeshColors.accent;
        break;
    }
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

class _FlatNode {
  _FlatNode(this.obligation, this.depth, this.hasChildren, this.isCollapsed);
  final ObligationDto obligation;
  final int depth;
  final bool hasChildren;
  final bool isCollapsed;
}

class _DetailView extends StatefulWidget {
  const _DetailView({
    required this.obligationId,
    required this.store,
    required this.onSelectView,
    this.onMutated,
  });

  final String obligationId;
  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;
  final VoidCallback? onMutated;

  @override
  State<_DetailView> createState() => _DetailViewState();
}

class _DetailViewState extends State<_DetailView> {
  // Completion history accumulates across "Load earlier completions" clicks
  // instead of being replaced by each new page, so an earlier page stays on
  // screen (extending the history, not losing access to it).
  List<ObligationCompletionDto> _completions = const [];
  int _completionsTotal = 0;
  bool _completionsHasMore = false;
  late Future<ObligationDetailSnapshot> _future;

  DashboardStore get store => widget.store;
  ValueChanged<DashboardView> get onSelectView => widget.onSelectView;
  VoidCallback? get onMutated => widget.onMutated;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  @override
  void didUpdateWidget(covariant _DetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.obligationId != widget.obligationId) {
      _completions = const [];
      _completionsTotal = 0;
      _completionsHasMore = false;
      _fetch();
    }
  }

  void _fetch() {
    final offset = _completions.length;
    final future = store.api.fetchObligationDetail(
      widget.obligationId,
      completionsOffset: offset,
    );
    _future = future;
    future.then((data) {
      if (!mounted) return;
      setState(() {
        _completions = offset == 0
            ? data.completions
            : [..._completions, ...data.completions];
        _completionsTotal = data.completionsTotal;
        _completionsHasMore = data.completionsHasMore;
      });
    });
  }

  void _loadMoreCompletions() {
    setState(_fetch);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<ObligationDetailSnapshot>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.hasError && !snapshot.hasData) {
          return Center(
            child: Text(
              'Detail unavailable: ${snapshot.error}',
              style: const TextStyle(color: MeshColors.textSecondary),
            ),
          );
        }
        if (!snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }

        final data = snapshot.data!;
        final o = data.obligation;

        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Row(
              children: [
                _Chip(o.status),
                const SizedBox(width: 10),
                Expanded(
                  child: SelectableText(
                    o.id,
                    style: const TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 12,
                      fontFamily: kMonoFontFamily,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            SelectableText(
              o.heading,
              style: const TextStyle(
                color: MeshColors.textPrimary,
                fontSize: 22,
                fontWeight: FontWeight.bold,
              ),
            ),
            if (o.body != null) ...[
              const SizedBox(height: 10),
              SelectableText(
                o.body!,
                style: const TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 13.5,
                  height: 1.5,
                ),
              ),
            ],
            const SizedBox(height: 24),
            if (data.artifacts.isNotEmpty) ...[
              _SectionHeader('CITED ARTIFACTS'),
              for (final artifact in data.artifacts)
                ReferencePreview(
                  reference:
                      artifact.reference ??
                      // Unresolvable in v1 (anything but mesh chat). Still shown:
                      // the citation exists and is worth seeing even when we
                      // cannot expand it.
                      ReferenceDto(
                        ref: artifact.ref,
                        scheme: artifact.ref.split(':').first,
                        title: artifact.ref,
                        unavailable:
                            'Not resolvable yet — only mesh chat is read back so far.',
                      ),
                  label: artifact.label,
                  attachedBy: artifact.attachedBy,
                  lookupActorHandle: (id) => store.actor(id)?.handle,
                ),
              const SizedBox(height: 16),
            ],
            _SectionHeader('OWNER'),
            _ownerPanel(o.ownerId),
            const SizedBox(height: 24),
            _SectionHeader('CREATOR'),
            _creatorPanel(o.creatorId),
            // Shown even when absent: linking an obligation to the issue it
            // turned into is a normal later step, and a section that only
            // appears once a ref exists gives no way to add the first one.
            const SizedBox(height: 24),
            _SectionHeader('EXTERNAL LINK'),
            _externalRefPanel(context, o),
            const SizedBox(height: 24),
            if (o.isScheduled) ...[
              _SectionHeader('SCHEDULE'),
              _schedulePanel(o),
              const SizedBox(height: 24),
            ],
            // Disabling recurrence finalizes a scheduled row but deliberately
            // retains its ledger.  History belongs to the durable obligation,
            // not to its current recurrence setting.
            if (o.isRecurring || o.hasCompletionHistory) ...[
              _SectionHeader('COMPLETION HISTORY'),
              _completionsPanel(),
              const SizedBox(height: 24),
            ],
            _SectionHeader('CHILDREN'),
            _childrenPanel(context, data),
            const SizedBox(height: 28),
            _SectionHeader('OBLIGATION ACTIONS'),
            _actionsPanel(context, data),
          ],
        );
      },
    );
  }

  Widget _ownerPanel(String ownerId) {
    final isHuman = ownerId.startsWith('human:');
    final isSystem = ownerId.startsWith('system:');
    final isActor = !isHuman && !isSystem;

    return _identityPanel(
      ownerId,
      action: isActor
          ? TextButton(
              onPressed: () {
                store.clickActor(ownerId);
                store.setDetailPanelIndex(4); // Select Inbox tab
                onSelectView(DashboardView.actors);
              },
              child: const Text(
                'View Owner Inbox →',
                style: TextStyle(color: MeshColors.accent),
              ),
            )
          : isHuman
          ? TextButton(
              onPressed: () {
                onSelectView(DashboardView.overview);
              },
              child: const Text(
                'View Owner Queue →',
                style: TextStyle(color: MeshColors.accent),
              ),
            )
          : null,
    );
  }

  /// Who raised this obligation. Null is a real, honest state — a row that
  /// predates creator attribution — not something to paper over by falling
  /// back to the owner or guessing.
  Widget _creatorPanel(String? creatorId) {
    if (creatorId == null) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            const CircleAvatar(
              radius: 14,
              backgroundColor: Color(0xFF1E293B),
              child: Icon(
                Icons.person_off_outlined,
                size: 16,
                color: MeshColors.textMuted,
              ),
            ),
            const SizedBox(width: 12),
            const Expanded(
              child: Text(
                'Unknown — predates creator attribution',
                style: TextStyle(
                  color: MeshColors.textMuted,
                  fontSize: 12,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return _identityPanel(creatorId);
  }

  /// One id space: the category is read off the id's prefix, the same way
  /// `isHumanOperator` does server-side. A known actor renders as its handle;
  /// anything else falls back to "Unknown actor" — never the raw id. Shared
  /// by Owner (always present) and Creator (rendered separately when null,
  /// above).
  Widget _identityPanel(String id, {Widget? action}) {
    final isHuman = id.startsWith('human:');
    final isSystem = id.startsWith('system:');
    final isActor = !isHuman && !isSystem;
    final displayId = actorDisplayLabel(id, (i) => store.actor(i)?.handle);
    // The second line adds category context beyond the primary label — for
    // human/system ids the primary label already says it, so there is
    // nothing more to add. Raw actor/thread ids only belong under the handle
    // in actor detail view, never bare here.
    final subtitle = isHuman || isSystem
        ? null
        : displayId != 'Unknown actor'
        ? 'Actor'
        : 'Actor — not in this mesh view';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          if (isActor)
            ActorAvatar(id: id, size: 28)
          else
            const CircleAvatar(
              radius: 14,
              backgroundColor: Color(0xFF1E293B),
              child: Icon(
                Icons.person,
                size: 16,
                color: MeshColors.textSecondary,
              ),
            ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  displayId,
                  style: const TextStyle(
                    color: MeshColors.textPrimary,
                    fontWeight: FontWeight.w600,
                    fontFamily: kMonoFontFamily,
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 11,
                    ),
                  ),
                ],
              ],
            ),
          ),
          ?action,
        ],
      ),
    );
  }

  Widget _schedulePanel(ObligationDto o) {
    final policyLabel = o.recurrencePolicy == 'cron'
        ? 'Cron: ${o.recurrenceCron}'
        : o.recurrencePolicy == 'completion_interval'
        ? 'Every ${o.recurrenceIntervalSeconds}s after completion'
        : 'One-time';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.schedule, size: 16, color: MeshColors.accent),
              const SizedBox(width: 8),
              Text(
                policyLabel,
                style: const TextStyle(
                  color: MeshColors.textPrimary,
                  fontSize: 13,
                  fontFamily: kMonoFontFamily,
                ),
              ),
            ],
          ),
          if (o.nextReadyAt != null) ...[
            const SizedBox(height: 8),
            Text(
              'Returns ${formatReturnsIn(o.nextReadyAt!)} (${formatTs(o.nextReadyAt!)})',
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 11.5,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _completionsPanel() {
    final completions = _completions;

    if (completions.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Text(
          'No completed cycles yet.',
          style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
        ),
      );
    }

    final remaining = _completionsTotal - completions.length;

    return Container(
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final completion in completions) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Cycle ${completion.sequence} — ${formatTs(completion.completedAt)}',
                    style: const TextStyle(
                      color: MeshColors.textPrimary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (completion.note != null &&
                      completion.note!.trim().isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      completion.note!,
                      style: const TextStyle(
                        color: MeshColors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                  if (completion.resolutionRef != null &&
                      completion.resolutionRef!.trim().isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      completion.resolutionRef!,
                      style: const TextStyle(
                        color: MeshColors.accent,
                        fontSize: 11.5,
                        fontFamily: kMonoFontFamily,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const Divider(height: 1, color: MeshColors.border),
          ],
          if (_completionsHasMore)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: TextButton(
                onPressed: _loadMoreCompletions,
                child: Text('Load earlier completions ($remaining remaining)'),
              ),
            ),
        ],
      ),
    );
  }

  Widget _externalRefPanel(BuildContext context, ObligationDto o) {
    final ref = o.externalRef?.trim() ?? '';
    final edit = o.isTerminal
        ? null
        : IconButton(
            icon: const Icon(
              Icons.edit_outlined,
              size: 16,
              color: MeshColors.textSecondary,
            ),
            tooltip: ref.isEmpty
                ? 'Link an issue, PR or repo'
                : 'Change or unlink',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => showEditExternalRefDialog(
              context,
              store,
              o,
              onUpdated: onMutated,
            ),
          );
    if (ref.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            const Icon(Icons.link_off, color: MeshColors.textMuted, size: 20),
            const SizedBox(width: 12),
            const Expanded(
              child: Text(
                'Not linked to an issue, PR or repository.',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 12.5),
              ),
            ),
            ?edit,
          ],
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.link, color: MeshColors.accent, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: SelectableText(
              ref,
              style: const TextStyle(
                color: MeshColors.accent,
                fontFamily: kMonoFontFamily,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          ?edit,
        ],
      ),
    );
  }

  Widget _childrenPanel(BuildContext context, ObligationDetailSnapshot data) {
    final list = data.children;

    if (list.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Expanded(
              child: Text(
                'This obligation is a leaf node (no decomposition children).',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
              ),
            ),
            if (!data.obligation.isTerminal)
              TextButton.icon(
                onPressed: () => showCreateObligationDialog(
                  context,
                  store,
                  defaultParentId: data.obligation.id,
                  defaultOwnerId: data.obligation.ownerId,
                  onCreated: onMutated,
                ),
                icon: const Icon(Icons.add, size: 14),
                label: const Text('Add Child', style: TextStyle(fontSize: 11)),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  foregroundColor: MeshColors.accent,
                ),
              ),
          ],
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < list.length; i++) ...[
            Builder(
              builder: (innerContext) {
                final c = list[i];
                return ObligationRow(
                  obligation: c,
                  store: store,
                  showOwner: true,
                  showActions:
                      false, // In the original, the work_tab children row didn't have actions menu.
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  showReorder: list.length > 1,
                  onMoveUp: i > 0
                      ? () async {
                          final previousId = i - 2 >= 0 ? list[i - 2].id : null;
                          final nextId = list[i - 1].id;
                          try {
                            await store.api.reorderObligation(
                              c.id,
                              previousId: previousId,
                              nextId: nextId,
                            );
                            onMutated?.call();
                          } catch (err) {
                            if (innerContext.mounted) {
                              ScaffoldMessenger.of(innerContext).showSnackBar(
                                SnackBar(
                                  content: Text('Failed to reorder: $err'),
                                  backgroundColor: MeshColors.statusHalted,
                                ),
                              );
                            }
                          }
                        }
                      : null,
                  onMoveDown: i < list.length - 1
                      ? () async {
                          final previousId = list[i + 1].id;
                          final nextId = i + 2 < list.length
                              ? list[i + 2].id
                              : null;
                          try {
                            await store.api.reorderObligation(
                              c.id,
                              previousId: previousId,
                              nextId: nextId,
                            );
                            onMutated?.call();
                          } catch (err) {
                            if (innerContext.mounted) {
                              ScaffoldMessenger.of(innerContext).showSnackBar(
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
              },
            ),
            const Divider(height: 1, color: MeshColors.border),
          ],
        ],
      ),
    );
  }

  Widget _actionsPanel(BuildContext context, ObligationDetailSnapshot data) {
    final o = data.obligation;
    final isTerminal = o.isTerminal;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (isTerminal) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: o.isDone
                    ? const Color(0xFF064E3B)
                    : const Color(0xFF450A0A),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    o.isDone ? Icons.check_circle : Icons.cancel,
                    size: 16,
                    color: o.isDone
                        ? const Color(0xFF34D399)
                        : const Color(0xFFF87171),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'This obligation is in terminal status (${o.status.toUpperCase()}).',
                    style: TextStyle(
                      color: o.isDone
                          ? const Color(0xFF34D399)
                          : const Color(0xFFF87171),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ] else ...[
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                ElevatedButton.icon(
                  onPressed: () => confirmAndSetObligationStatus(
                    context,
                    store,
                    o,
                    'done',
                    onUpdated: onMutated,
                  ),
                  icon: const Icon(Icons.check_circle_outline, size: 16),
                  label: const Text('Mark Done'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF064E3B),
                    foregroundColor: const Color(0xFF34D399),
                  ),
                ),
                ElevatedButton.icon(
                  onPressed: () => confirmAndSetObligationStatus(
                    context,
                    store,
                    o,
                    'cancelled',
                    onUpdated: onMutated,
                  ),
                  icon: const Icon(Icons.cancel_outlined, size: 16),
                  label: const Text('Cancel Obligation'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF450A0A),
                    foregroundColor: const Color(0xFFF87171),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => showReassignObligationDialog(
                    context,
                    store,
                    o,
                    onReassigned: onMutated,
                  ),
                  icon: const Icon(Icons.person_outline, size: 16),
                  label: const Text('Reassign...'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: MeshColors.accent,
                    side: const BorderSide(color: MeshColors.border),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => showReparentObligationDialog(
                    context,
                    store,
                    o,
                    onReparented: onMutated,
                  ),
                  icon: const Icon(Icons.drive_file_move_outlined, size: 16),
                  label: const Text('Reparent...'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: MeshColors.accent,
                    side: const BorderSide(color: MeshColors.border),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => showCreateObligationDialog(
                    context,
                    store,
                    defaultParentId: o.id,
                    defaultOwnerId: o.ownerId,
                    onCreated: onMutated,
                  ),
                  icon: const Icon(Icons.add_task, size: 16),
                  label: const Text('Add Child...'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: MeshColors.accent,
                    side: const BorderSide(color: MeshColors.border),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: const TextStyle(
          color: MeshColors.textSecondary,
          fontSize: 11,
          fontWeight: FontWeight.bold,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    Color bg = const Color(0xFF1E293B);
    Color fg = const Color(0xFF94A3B8);
    Color border = const Color(0xFF334155);

    switch (label.toLowerCase()) {
      case 'ready':
        bg = const Color(0xFF064E3B);
        fg = const Color(0xFF34D399);
        border = const Color(0xFF047857);
        break;
      case 'waiting':
        bg = const Color(0xFF78350F);
        fg = const Color(0xFFFBBF24);
        border = const Color(0xFFB45309);
        break;
      case 'done':
        bg = const Color(0xFF14532D);
        fg = const Color(0xFF4ADE80);
        border = const Color(0xFF15803D);
        break;
      case 'cancelled':
        bg = const Color(0xFF450A0A);
        fg = const Color(0xFFF87171);
        border = const Color(0xFFB91C1C);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 10,
          color: fg,
          fontFamily: kMonoFontFamily,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
