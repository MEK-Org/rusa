import 'dart:async';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter/material.dart';

import '../api.dart';
import '../breakpoints.dart';
import '../dashboard_timing.dart';
import '../link_opener.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'avatar.dart';
import 'header.dart';
import 'obligation_card.dart';
import 'obligation_dialogs.dart';
import 'obligation_snooze.dart';
import 'obligation_status.dart';
import 'hierarchy_drag_drop.dart';
import 'reference_preview.dart';
import 'resizable_sidebar.dart';

class WorkTab extends StatefulWidget {
  const WorkTab({
    super.key,
    required this.store,
    required this.onSelectView,
    this.openLink = openInNewTab,
  });

  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;

  /// Opens an external link. Injectable so tests can assert exactly what
  /// gets opened without touching a real browser.
  final void Function(String url) openLink;

  @override
  State<WorkTab> createState() => _WorkTabState();
}

class _WorkTabState extends State<WorkTab> {
  bool _loading = true;
  bool _isBackgroundRefreshing = false;
  String? _error;
  List<ObligationTreeDto> _rootTrees = [];
  late final Set<String> _expandedIds = widget.store.workExpanded;
  String? _selectedObligationId;
  StreamSubscription<String?>? _focusSub;
  StreamSubscription<ObligationRefresh>? _checkpointSub;
  StreamSubscription<String?>? _principalSub;
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
  Future<void> _loadRoots({
    bool forceIncludeTerminal = false,
    bool trackNavigation = false,
  }) async {
    final includeTerminal = forceIncludeTerminal || _showDone;
    final generation = ++_loadGeneration;
    try {
      setState(() {
        if (_rootTrees.isEmpty) _loading = true;
        _isBackgroundRefreshing = _rootTrees.isNotEmpty;
        _error = null;
      });
      Future<void> runLoad() async {
        final forest = await widget.store.api.fetchObligationForest(
          includeTerminalRoots: includeTerminal,
        );
        if (!mounted || generation != _loadGeneration) {
          throw StateError('Work queue load superseded or unmounted');
        }
        setState(() {
          _rootTrees = forest.trees;
          _fetchedTerminalRoots = includeTerminal;
          _loading = false;
          _isBackgroundRefreshing = false;
        });
        // Focus-link and Show Done requests include terminal roots. Persist only
        // the default terminal-excluding forest so a later default view cannot
        // paint rows it believes it did not fetch.
        if (!includeTerminal) {
          widget.store.saveObligationsSnapshot(forest.trees);
        }
        _checkFocusLink();
      }

      if (trackNavigation) {
        await widget.store.api.trackInteraction(
          DashboardInteraction.primaryNavigation,
          runLoad,
        );
      } else {
        await runLoad();
      }
    } catch (e) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _error =
            'We could not refresh the work queue. Check your connection and retry.';
        _loading = false;
        _isBackgroundRefreshing = false;
      });
    }
  }

  void _handleMutation() {
    widget.store.invalidateObligationsCache();
    _loadRoots();
  }

  void _checkFocusLink() {
    final focusedId = widget.store.focusedObligationId.valueOrNull;
    if (focusedId == null) {
      if (_selectedObligationId != null) {
        setState(() => _selectedObligationId = null);
      }
      return;
    }
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

  ObligationTreeDto? _findTree(String id, [List<ObligationTreeDto>? nodes]) {
    for (final node in nodes ?? _rootTrees) {
      if (node.obligation.id == id) return node;
      final found = _findTree(id, node.children);
      if (found != null) return found;
    }
    return null;
  }

  /// Reads the same complete, priority-sorted ready queue that the reorder
  /// endpoint uses to validate adjacent neighbors. The visible tree is not a
  /// queue: ready work owned by the same actor can be interleaved under other
  /// parents, so deriving neighbors from siblings makes valid drops fail.
  Future<List<ObligationDto>> _readyQueueForOwner(String ownerId) async {
    const pageSize = 100;
    final queue = <ObligationDto>[];
    var offset = 0;
    while (true) {
      final page = await widget.store.api.fetchObligations(
        ownerId: ownerId,
        status: 'ready',
        limit: pageSize,
        offset: offset,
      );
      queue.addAll(page.obligations);
      if (!page.hasMore || page.obligations.isEmpty) return queue;
      offset += page.obligations.length;
    }
  }

  /// True when [candidateId] is in [ancestorId]'s loaded subtree.
  bool _isObligationDescendant(String candidateId, String ancestorId) {
    final candidate = _findTree(candidateId);
    if (candidate == null) return false;
    bool visit(ObligationTreeDto node) {
      if (node.obligation.id == ancestorId) return true;
      return node.children.any(visit);
    }

    return candidate.children.any(visit);
  }

  bool _canAcceptObligationDrop(
    ObligationDto dragged,
    ObligationDto target,
    HierarchyDropZone zone,
  ) {
    if (dragged.id == target.id ||
        dragged.isTerminal ||
        target.isTerminal ||
        _isObligationDescendant(dragged.id, target.id)) {
      return false;
    }
    if (zone == HierarchyDropZone.on) return true;
    return dragged.status == 'ready' &&
        target.status == 'ready' &&
        dragged.parentId == target.parentId &&
        dragged.ownerId == target.ownerId;
  }

  Future<void> _dropObligation(
    BuildContext context,
    ObligationDto dragged,
    ObligationDto target,
    HierarchyDropZone zone,
  ) async {
    try {
      if (zone == HierarchyDropZone.on) {
        await widget.store.mutateObligations(
          () => widget.store.api.reparentObligation(
            dragged.id,
            parentId: target.id,
          ),
        );
        _expandedIds.add(target.id);
        widget.store.saveWorkExpanded(_expandedIds);
      } else {
        final queue = await _readyQueueForOwner(dragged.ownerId);
        queue.removeWhere((o) => o.id == dragged.id);
        final targetIndex = queue.indexWhere((o) => o.id == target.id);
        if (targetIndex < 0) return;
        final insertIndex = zone == HierarchyDropZone.before
            ? targetIndex
            : targetIndex + 1;
        final previousId = insertIndex == 0 ? null : queue[insertIndex - 1].id;
        final nextId = insertIndex == queue.length
            ? null
            : queue[insertIndex].id;
        await widget.store.mutateObligations(
          () => widget.store.api.reorderObligation(
            dragged.id,
            previousId: previousId,
            nextId: nextId,
          ),
        );
      }
      await _loadRoots();
    } catch (err) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to move obligation: $err'),
            backgroundColor: MeshColors.statusHalted,
          ),
        );
      }
    }
  }

  @override
  void initState() {
    super.initState();
    final cached = widget.store.cachedObligationTrees;
    if (cached != null) {
      _rootTrees = cached;
      _loading = false;
      _isBackgroundRefreshing = true;
    } else {
      _loading = true;
      _isBackgroundRefreshing = false;
    }
    _loadRoots(trackNavigation: true);
    _focusSub = widget.store.focusedObligationId.listen((focusedId) {
      if (focusedId != null && !_loading) {
        _expandAncestors(focusedId);
      } else if (focusedId == null && mounted) {
        setState(() => _selectedObligationId = null);
      }
    });
    _checkpointSub = widget.store.obligationRefreshes.listen((_) {
      _handleMutation();
    });
    // When the viewing principal changes, refresh labels and re-seed or clear
    // the cached tree for that principal.
    _principalSub = widget.store.dashboardConfig
        .map((c) => c?.userPrincipalId)
        .distinct()
        .skip(1)
        .listen((newPrincipalId) {
          if (mounted) {
            final cached = widget.store.cachedObligationTrees;
            if (cached != null) {
              setState(() {
                _rootTrees = cached;
                _loading = false;
                _isBackgroundRefreshing = true;
                _error = null;
              });
            } else {
              setState(() {
                _rootTrees = [];
                _loading = true;
                _isBackgroundRefreshing = false;
                _error = null;
              });
            }
            _loadRoots();
          }
        });
  }

  @override
  void dispose() {
    _focusSub?.cancel();
    _checkpointSub?.cancel();
    _principalSub?.cancel();
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

  Widget _refreshErrorBanner({required EdgeInsets margin}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    margin: margin,
    decoration: BoxDecoration(
      color: MeshColors.statusHalted.withAlpha(35),
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: MeshColors.statusHalted.withAlpha(80)),
    ),
    child: Row(
      children: [
        const Icon(
          Icons.warning_amber_rounded,
          size: 16,
          color: MeshColors.statusHalted,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _error ?? '',
            style: const TextStyle(
              color: MeshColors.textSecondary,
              fontSize: 12,
            ),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 8),
        InkWell(
          onTap: _loadRoots,
          child: const Padding(
            padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            child: Text(
              'Retry',
              style: TextStyle(
                color: MeshColors.accent,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    if (_loading && _rootTrees.isEmpty) {
      return const Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (_error != null && _rootTrees.isEmpty) {
      return Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                _error!,
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
          final isNarrow = constraints.maxWidth < kNarrowBreakpoint;

          if (isNarrow) {
            if (_selectedObligationId != null) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _narrowBackBar(),
                  if (_error != null && _rootTrees.isNotEmpty)
                    _refreshErrorBanner(margin: const EdgeInsets.all(8)),
                  const Divider(height: 1, color: MeshColors.border),
                  Expanded(
                    child: _DetailView(
                      obligationId: _selectedObligationId!,
                      store: widget.store,
                      onSelectView: widget.onSelectView,
                      onMutated: _handleMutation,
                      openLink: widget.openLink,
                    ),
                  ),
                ],
              );
            }
            return _sidebar(flattened, isNarrow: isNarrow);
          }

          return ResizableSidebar(
            defaultWidth: 320,
            initialWidth: widget.store.sidebarWidth('work'),
            onWidthChanged: (width) =>
                widget.store.setSidebarWidth('work', width),
            sidebar: _sidebar(flattened, isNarrow: isNarrow),
            detail: _selectedObligationId != null
                ? _DetailView(
                    obligationId: _selectedObligationId!,
                    store: widget.store,
                    onSelectView: widget.onSelectView,
                    onMutated: _handleMutation,
                    openLink: widget.openLink,
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

  Widget _sidebar(List<_FlatNode> nodes, {required bool isNarrow}) => Container(
    decoration: const BoxDecoration(color: MeshColors.bgSecondary),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 12, 12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
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
                  if (_isBackgroundRefreshing) ...[
                    const SizedBox(width: 8),
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation<Color>(
                          MeshColors.textMuted,
                        ),
                      ),
                    ),
                  ],
                ],
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
                      onCreated: _handleMutation,
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
        if (_error != null && _rootTrees.isNotEmpty)
          _refreshErrorBanner(margin: const EdgeInsets.fromLTRB(12, 0, 12, 8)),
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

                    final content = InkWell(
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
                            ObligationStatusDot(
                              obligation: node.obligation,
                              store: widget.store,
                            ),
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
                                  // One line of standing in the tree, so a
                                  // steward scanning the arc sees where each
                                  // node stands without opening it. Truncated
                                  // rather than wrapped: the tree is an index,
                                  // and the whole checkpoint is one tap away.
                                  if (node.obligation.hasCheckpoint)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 2),
                                      child: Text(
                                        node.obligation.checkpoint!
                                            .trim()
                                            .replaceAll(RegExp(r'\s+'), ' '),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          color: MeshColors.textMuted,
                                          fontSize: 11,
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                    if (isNarrow) return content;
                    return HierarchyDropTarget<ObligationDto>(
                      canAccept: (dragged, zone) => _canAcceptObligationDrop(
                        dragged,
                        node.obligation,
                        zone,
                      ),
                      onDrop: (dragged, zone) => _dropObligation(
                        context,
                        dragged,
                        node.obligation,
                        zone,
                      ),
                      builder: (context, activeDropZone) {
                        final highlighted = HierarchyDropHighlight(
                          zone: activeDropZone,
                          child: content,
                        );
                        if (node.obligation.isTerminal) return highlighted;
                        return Draggable<ObligationDto>(
                          data: node.obligation,
                          dragAnchorStrategy: pointerDragAnchorStrategy,
                          hitTestBehavior: HitTestBehavior.opaque,
                          feedback: HierarchyDragFeedback(
                            leading: Icon(
                              Icons.account_tree_outlined,
                              size: 16,
                              color: MeshColors.accent,
                            ),
                            label: node.obligation.heading,
                          ),
                          childWhenDragging: Opacity(
                            opacity: .35,
                            child: highlighted,
                          ),
                          child: highlighted,
                        );
                      },
                    );
                  },
                ),
        ),
      ],
    ),
  );
}

class _FlatNode {
  _FlatNode(this.obligation, this.depth, this.hasChildren, this.isCollapsed);
  final ObligationDto obligation;
  final int depth;
  final bool hasChildren;
  final bool isCollapsed;
}

/// The waits before each re-ask of a reference the open obligation cites that
/// the server answered "pending" (#595). Bounded: after the last, a
/// still-pending reference is shown as unavailable.
const pendingReferenceRetryDelays = [
  Duration(seconds: 1),
  Duration(seconds: 2),
  Duration(seconds: 4),
  Duration(seconds: 8),
];

class _DetailView extends StatefulWidget {
  const _DetailView({
    required this.obligationId,
    required this.store,
    required this.onSelectView,
    this.onMutated,
    this.openLink = openInNewTab,
  });

  final String obligationId;
  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;
  final VoidCallback? onMutated;
  final void Function(String url) openLink;

  @override
  State<_DetailView> createState() => _DetailViewState();
}

class _DetailViewState extends State<_DetailView> {
  // Completion history accumulates across "Load earlier completions" clicks
  // instead of being replaced by each new page, so an earlier page stays on
  // screen (extending the history, not losing access to it).
  List<ObligationHistoryDto> _history = const [];
  String? _historyNextBefore;
  bool _loadingHistory = false;

  /// The newest "Show more updates" request. A newer load can supersede it
  /// (#772); if nothing has started another history page since, its stale
  /// answer still has to release the busy control.
  int _historyRequest = 0;
  bool _historyPaged = false;
  String? _historyError;
  List<ObligationCompletionDto> _completions = const [];
  int _completionsTotal = 0;
  bool _completionsHasMore = false;

  /// Done children are hidden by default so the CHILDREN section reads as the
  /// outstanding work under this obligation (#396). Per obligation, like the
  /// completion history above: revealing them here says nothing about the
  /// next obligation the reader opens.
  bool _showDoneChildren = false;
  late Future<ObligationDetailSnapshot> _future;
  StreamSubscription<ObligationRefresh>? _checkpointSub;
  int _fetchGeneration = 0;

  /// The references the loaded snapshot cites, resolved through
  /// `/api/mesh/references` after the pane has painted (#940), and the refs
  /// asked for and not yet answered.
  Map<String, ReferenceDto> _references = const {};
  Set<String> _referencesInFlight = const {};

  /// The scheduled re-ask while a cited reference is still pending on the
  /// server's background read (#595), and how many the current ladder has
  /// spent. A ladder covers the pending refs it started with; a ref seen
  /// pending for the first time starts a fresh one, so each distinct ref buys
  /// at most one ladder while this obligation is open.
  Timer? _pendingRetry;
  int _pendingAttempts = 0;
  Set<String> _pendingSeen = const {};

  /// Refs still pending when their ladder ran out; shown as unavailable.
  Set<String> _pendingGaveUp = const {};

  /// Every obligation the loaded snapshot draws besides this one: its parent,
  /// children and dependency edges (#773).
  Set<String> _shownIds = const {};

  DashboardStore get store => widget.store;
  ValueChanged<DashboardView> get onSelectView => widget.onSelectView;

  /// A write made from this pane also refetches the pane, so its header shows
  /// the new status (#771); nothing else refreshes it on a status change. The
  /// Work tab's own callback still reloads the tree.
  VoidCallback get onMutated => () {
    if (mounted) _refresh();
    widget.onMutated?.call();
  };
  void Function(String url) get openLink => widget.openLink;

  @override
  void initState() {
    super.initState();
    _fetch(trackDetail: true);
    _checkpointSub = widget.store.obligationRefreshes.listen(_onRefresh);
  }

  @override
  void didUpdateWidget(covariant _DetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store != widget.store) {
      _checkpointSub?.cancel();
      _checkpointSub = widget.store.obligationRefreshes.listen(_onRefresh);
    }
    if (oldWidget.obligationId != widget.obligationId) {
      _shownIds = const {};
      _history = const [];
      _historyPaged = false;
      _historyNextBefore = null;
      _loadingHistory = false;
      _historyError = null;
      _completions = const [];
      _completionsTotal = 0;
      _completionsHasMore = false;
      _showDoneChildren = false;
      _references = const {};
      _referencesInFlight = const {};
      _pendingAttempts = 0;
      _pendingSeen = const {};
      _pendingGaveUp = const {};
      _fetch(trackDetail: true);
    }
  }

  @override
  void dispose() {
    _checkpointSub?.cancel();
    _pendingRetry?.cancel();
    super.dispose();
  }

  /// Starts a load: any older load in flight is superseded (#772), and so is
  /// a scheduled pending-reference retry, since this load answers it.
  int _beginFetch() {
    _pendingRetry?.cancel();
    _pendingRetry = null;
    // A superseded reference request may never get to its generation-guarded
    // settle callback. Its keys therefore belong to that old generation too:
    // release them before the new snapshot asks for its own current refs.
    _referencesInFlight = const {};
    return ++_fetchGeneration;
  }

  /// The refs the pane shows: the external link, keyed as its panel trims
  /// it, and each artifact. An empty ref names nothing to resolve.
  static Set<String> _refsOf(ObligationDetailSnapshot data) => {
    for (final ref in [
      data.obligation.externalRef?.trim() ?? '',
      for (final artifact in data.artifacts) artifact.ref,
    ])
      if (ref.isNotEmpty) ref,
  };

  /// A ref with no answer yet reads as pending, like the server's cold read.
  ReferenceDto _referenceFor(String ref) =>
      _references[ref] ?? ReferenceDto.loading(ref);

  Set<String> _pendingRefs(ObligationDetailSnapshot data) => {
    for (final ref in _refsOf(data))
      if (_referenceFor(ref).cacheState == 'pending' &&
          !_referencesInFlight.contains(ref))
        ref,
  };

  /// A fresh detail snapshot revalidates every reference it cites while the
  /// existing preview stays visible. A ladder tick asks only pending refs, so
  /// a provider's cold read remains bounded. A failed ask spends a ladder
  /// attempt, and a fresh detail load may re-ask a ref whose ladder gave up.
  void _resolveReferences(
    ObligationDetailSnapshot data, {
    bool retrying = false,
  }) {
    final wanted = retrying
        ? _pendingRefs(data).difference(_pendingGaveUp)
        : _refsOf(data).difference(_referencesInFlight);
    if (wanted.isEmpty) return;
    final id = widget.obligationId;
    final gen = _fetchGeneration;
    _referencesInFlight = {..._referencesInFlight, ...wanted};
    void settle([Map<String, ReferenceDto> resolved = const {}]) {
      if (!mounted || gen != _fetchGeneration || id != widget.obligationId) {
        return;
      }
      setState(() {
        _referencesInFlight = _referencesInFlight.difference(wanted);
        _references = {..._references, ...resolved};
        _schedulePendingRetry(data);
      });
    }

    store.api
        .fetchReferences(wanted)
        .then(
          settle,
          onError: (Object error, StackTrace _) => settle(
            error is PartialReferenceFetchException ? error.resolved : const {},
          ),
        );
  }

  /// Lets the raw detail snapshot render before asking the separate reference
  /// route to enrich it. A later navigation or refresh invalidates this
  /// callback just as it invalidates an in-flight reference response.
  void _resolveReferencesAfterFirstPaint(ObligationDetailSnapshot data) {
    final id = widget.obligationId;
    final gen = _fetchGeneration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || gen != _fetchGeneration || id != widget.obligationId) {
        return;
      }
      _resolveReferences(data);
    });
  }

  /// Schedules the next bounded re-ask when a ref [data] cites is still
  /// pending. The server shares one provider read across these, so they cost
  /// no extra provider traffic; the timer belongs to this load's generation,
  /// so navigating away or a newer load leaves it inert.
  void _schedulePendingRetry(ObligationDetailSnapshot data) {
    _pendingRetry?.cancel();
    _pendingRetry = null;
    final pending = _pendingRefs(data).difference(_pendingGaveUp);
    if (pending.isEmpty) return;
    if (!_pendingSeen.containsAll(pending)) {
      _pendingSeen = {..._pendingSeen, ...pending};
      _pendingAttempts = 0;
    }
    if (_pendingAttempts >= pendingReferenceRetryDelays.length) {
      _pendingGaveUp = {..._pendingGaveUp, ...pending};
      return;
    }
    final gen = _fetchGeneration;
    _pendingRetry = Timer(pendingReferenceRetryDelays[_pendingAttempts++], () {
      if (mounted && gen == _fetchGeneration) {
        _resolveReferences(data, retrying: true);
      }
    });
  }

  /// A reference still pending once its retries ran out is shown as the
  /// server shows any read it could not complete.
  ReferenceDto _settled(String ref) {
    final reference = _referenceFor(ref);
    return reference.cacheState == 'pending' && _pendingGaveUp.contains(ref)
        ? ReferenceDto(
            ref: reference.ref,
            scheme: reference.scheme,
            title: reference.title,
            body: reference.body,
            author: reference.author,
            timestamp: reference.timestamp,
            url: reference.url,
            unavailable: 'could not load context',
            cacheState: 'unavailable',
          )
        : reference;
  }

  void _fetch({bool trackDetail = false}) {
    final gen = _beginFetch();
    Future<ObligationDetailSnapshot> runFetch() async {
      final data = await store.api.fetchObligationDetail(widget.obligationId);
      if (!mounted || gen != _fetchGeneration) {
        throw StateError('Obligation detail fetch superseded or unmounted');
      }
      _shownIds = _idsOf(data);
      setState(() {
        _history = data.history;
        _historyNextBefore = data.historyNextBefore;
        _completions = data.completions;
        _completionsTotal = data.completionsTotal;
        _completionsHasMore = data.completionsHasMore;
        _resolveReferencesAfterFirstPaint(data);
      });
      return data;
    }

    final future = trackDetail
        ? store.api.trackInteraction(
            DashboardInteraction.obligationDetail,
            runFetch,
          )
        : runFetch();
    _future = future;
    future.then((_) {}).catchError((_) {});
  }

  void _loadMoreCompletions() {
    final gen = _beginFetch();
    final offset = _completions.length;
    final future = store.api.fetchObligationDetail(
      widget.obligationId,
      completionsOffset: offset,
    );
    setState(() {
      _future = future;
    });
    future
        .then((data) {
          if (!mounted || gen != _fetchGeneration) return;
          _shownIds = _idsOf(data);
          setState(() {
            _completions = mergeCompletions(data.completions, _completions);
            _completionsTotal = data.completionsTotal;
            _completionsHasMore = _completions.length < data.completionsTotal;
            _resolveReferencesAfterFirstPaint(data);
          });
        })
        .catchError((_) {});
  }

  /// Refetches when a committed write touches this obligation or anything the
  /// pane draws. The echo of the pane's own write refetches too; #772's
  /// generation guard keeps only the newest load.
  void _onRefresh(ObligationRefresh refresh) {
    if (refresh.touches(widget.obligationId) ||
        refresh.ids.any(_shownIds.contains)) {
      _refresh();
    }
  }

  static Set<String> _idsOf(ObligationDetailSnapshot data) => {
    for (final ancestor in data.ancestors) ancestor.id,
    if (data.parent != null) data.parent!.id,
    for (final o in [
      ...data.children,
      ...data.blockingChildren,
      ...data.blockedBy,
      ...data.blocks,
    ])
      o.id,
  };

  void _refresh() {
    final gen = _beginFetch();
    final future = store.api.fetchObligationDetail(widget.obligationId);
    setState(() {
      _future = future;
    });
    future
        .then((data) {
          if (!mounted || gen != _fetchGeneration) return;
          _shownIds = _idsOf(data);
          setState(() => _applyRefreshed(data));
        })
        .catchError((_) {});
  }

  /// Takes a refetched first page without dropping earlier completion pages
  /// already loaded; called inside setState.
  void _applyRefreshed(ObligationDetailSnapshot data) {
    final overlapsLoaded = data.history.any(
      (entry) => _history.any((loaded) => loaded.id == entry.id),
    );
    // A non-overlapping head can hide a whole page of intervening writes.
    // Walk from its cursor even if the retained old tail was exhausted.
    if (!_historyPaged || !overlapsLoaded) {
      _historyNextBefore = data.historyNextBefore;
    }
    _history = _mergeHistory(data.history, _history);
    _loadingHistory = false;
    if (!data.completionsHasMore ||
        _completions.length <= data.completions.length) {
      _completions = data.completions;
      _completionsTotal = data.completionsTotal;
      _completionsHasMore = data.completionsHasMore;
    } else {
      _completions = mergeCompletions(data.completions, _completions);
      _completionsTotal = data.completionsTotal;
      _completionsHasMore = _completions.length < data.completionsTotal;
    }
    _resolveReferencesAfterFirstPaint(data);
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

        final description = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _SectionHeader('DESCRIPTION'),
            if (o.body != null)
              SelectableText(
                o.body!,
                style: const TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 13.5,
                  height: 1.5,
                ),
              ),
          ],
        );
        final children = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [_SectionHeader('CHILDREN'), _childrenPanel(context, data)],
        );
        final history = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [_SectionHeader('HISTORY'), _historyPanel(data)],
        );
        final facts = _facts(context, data);
        return LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 900;
            return SingleChildScrollView(
              padding: EdgeInsets.all(wide ? 32 : 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _breadcrumbs(data),
                  const SizedBox(height: 12),
                  _detailHeader(context, data),
                  const SizedBox(height: 18),
                  const Divider(color: MeshColors.border),
                  const SizedBox(height: 18),
                  if (wide)
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              description,
                              const SizedBox(height: 28),
                              children,
                              const SizedBox(height: 28),
                              history,
                            ],
                          ),
                        ),
                        const SizedBox(width: 36),
                        SizedBox(width: 300, child: facts),
                      ],
                    )
                  else ...[
                    description,
                    const SizedBox(height: 24),
                    facts,
                    const SizedBox(height: 24),
                    children,
                    const SizedBox(height: 24),
                    history,
                  ],
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _breadcrumbs(ObligationDetailSnapshot data) {
    final ancestors = data.ancestors.isNotEmpty
        ? data.ancestors
        : [if (data.parent != null) data.parent!];
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 2,
      children: [
        for (var i = 0; i < ancestors.length; i++) ...[
          if (i > 0)
            const Icon(
              Icons.chevron_right,
              size: 14,
              color: MeshColors.textMuted,
            ),
          TextButton(
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              minimumSize: const Size(0, 28),
            ),
            onPressed: () => store.setFocusedObligationId(ancestors[i].id),
            child: Text(
              ancestors[i].heading,
              style: const TextStyle(
                color: MeshColors.textSecondary,
                fontSize: 12,
              ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _facts(BuildContext context, ObligationDetailSnapshot data) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      _SectionHeader('PEOPLE'),
      _ownerPanel(data.obligation.ownerId),
      _creatorPanel(data.obligation.creatorId),
      const Divider(height: 32, color: MeshColors.border),
      _SectionHeader('EXTERNAL LINK'),
      _externalRefPanel(context, data),
      if (data.obligation.completionMatcher != null) ...[
        const Divider(height: 32, color: MeshColors.border),
        _SectionHeader('COMPLETION MATCHER'),
        _completionMatcherPanel(data.obligation.completionMatcher!),
      ],
      if (data.artifacts.isNotEmpty) ...[
        const Divider(height: 32, color: MeshColors.border),
        _SectionHeader('ARTIFACTS'),
        for (final artifact in data.artifacts)
          _referenceLine(
            _settled(artifact.ref),
            label: artifact.label,
            attachedBy: artifact.attachedBy,
          ),
      ],
      if (data.obligation.isScheduled) ...[
        const Divider(height: 32, color: MeshColors.border),
        _SectionHeader('SCHEDULE'),
        _schedulePanel(data.obligation),
      ],
      const Divider(height: 32, color: MeshColors.border),
      _SectionHeader('BLOCKED BY'),
      _dependencyPanel(
        data.blockedBy,
        total: data.blockedByTotal,
        hasMore: data.blockedByHasMore,
        emptyText: 'Not blocked by any obligations or issues.',
      ),
      const SizedBox(height: 28),
      _SectionHeader('BLOCKS'),
      _dependencyPanel(
        data.blocks,
        total: data.blocksTotal,
        hasMore: data.blocksHasMore,
        emptyText: 'Does not block any obligations or issues.',
      ),
    ],
  );

  Widget _referenceLine(
    ReferenceDto reference, {
    String? label,
    String? attachedBy,
    Widget? action,
  }) {
    final title = referenceDisplayTitle(
      reference,
      lookupActorHandle: (id) => store.actor(id)?.handle,
      isViewer: store.isViewer,
      humanDisplayName: store.operatorDisplayName,
    );
    final icon = switch (reference.scheme) {
      'github' => Icons.code,
      'gchat' => Icons.chat,
      'slack' => Icons.tag,
      'mesh' => Icons.hub_outlined,
      _ => Icons.link,
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              if (['github', 'gchat', 'slack'].contains(reference.scheme))
                SvgPicture.asset(
                  'assets/reference_icons/${reference.scheme == 'gchat' ? 'googlechat' : reference.scheme}.svg',
                  width: 18,
                  height: 18,
                  colorFilter: const ColorFilter.mode(
                    MeshColors.textSecondary,
                    BlendMode.srcIn,
                  ),
                  semanticsLabel: reference.scheme,
                )
              else
                Icon(icon, size: 18, color: MeshColors.accent),
              const SizedBox(width: 8),
              Expanded(
                child: InkWell(
                  onTap: reference.url == null
                      ? null
                      : () => openLink(reference.url!),
                  child: Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: MeshColors.textPrimary,
                      fontSize: 13,
                    ),
                  ),
                ),
              ),
              if (attachedBy != null)
                Tooltip(
                  message: 'Attached by ${store.actorDisplay(attachedBy)}',
                  child: _personAvatar(attachedBy),
                ),
              IconButton(
                tooltip: 'View reference context',
                visualDensity: VisualDensity.compact,
                icon: const Icon(
                  Icons.info_outline,
                  size: 16,
                  color: MeshColors.textMuted,
                ),
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (context) => AlertDialog(
                    content: SizedBox(
                      width: 600,
                      child: SingleChildScrollView(
                        child: ReferencePreview(
                          reference: reference,
                          label: label,
                          attachedBy: attachedBy,
                          lookupActorHandle: (id) => store.actor(id)?.handle,
                          isViewer: store.isViewer,
                          humanDisplayName: store.operatorDisplayName,
                          openLink: openLink,
                        ),
                      ),
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(context),
                        child: const Text('Close'),
                      ),
                    ],
                  ),
                ),
              ),
              ?action,
            ],
          ),
          if (reference.unavailable != null)
            Padding(
              padding: const EdgeInsets.only(left: 26, top: 3),
              child: Text(
                reference.unavailable!,
                style: const TextStyle(
                  color: MeshColors.textMuted,
                  fontSize: 12,
                ),
              ),
            ),
          if (label != null)
            Padding(
              padding: const EdgeInsets.only(left: 26, top: 3),
              child: Text(
                label,
                style: const TextStyle(
                  color: MeshColors.textMuted,
                  fontSize: 12,
                ),
              ),
            ),
        ],
      ),
    );
  }

  static List<ObligationHistoryDto> _mergeHistory(
    List<ObligationHistoryDto> newest,
    List<ObligationHistoryDto> earlier,
  ) {
    final byId = {
      for (final entry in earlier) entry.id: entry,
      for (final entry in newest) entry.id: entry,
    };
    return byId.values.toList()..sort((a, b) {
      final time = b.timestamp.compareTo(a.timestamp);
      return time != 0 ? time : b.id.compareTo(a.id);
    });
  }

  void _loadMoreHistory() {
    if (_loadingHistory || _historyNextBefore == null) return;
    final gen = _fetchGeneration;
    final request = ++_historyRequest;
    setState(() {
      _loadingHistory = true;
      _historyError = null;
    });
    bool superseded() {
      if (!mounted) return true;
      if (gen == _fetchGeneration) return false;
      if (request == _historyRequest && _loadingHistory) {
        setState(() => _loadingHistory = false);
      }
      return true;
    }

    store.api
        .fetchObligationDetail(
          widget.obligationId,
          historyBefore: _historyNextBefore,
        )
        .then((data) {
          if (superseded()) return;
          setState(() {
            _history = _mergeHistory(data.history, _history);
            _historyPaged = true;
            _historyNextBefore = data.historyNextBefore;
            _loadingHistory = false;
          });
        })
        .catchError((Object error) {
          if (superseded()) return;
          setState(() {
            _loadingHistory = false;
            _historyError = 'Earlier history unavailable. Try again.';
          });
        });
  }

  Widget _historyPanel(ObligationDetailSnapshot data) {
    final o = data.obligation;
    final currentRecorded = _history.any(
      (h) =>
          h.after['checkpoint'] == o.checkpoint &&
          h.timestamp == o.checkpointAt,
    );
    final timeline =
        <(String, String, Widget)>[
          for (final h in _history)
            (
              h.timestamp,
              h.id,
              _historyEntry(
                by: h.by,
                timestamp: h.timestamp,
                label: _historyLabel(h),
                body:
                    h.after['checkpoint'] as String? ??
                    h.after['terminalNote'] as String? ??
                    h.after['message'] as String?,
                latest:
                    o.hasCheckpoint &&
                    h.after['checkpoint'] == o.checkpoint &&
                    h.timestamp == o.checkpointAt,
              ),
            ),
          for (final completion in _completions)
            (
              completion.completedAt,
              'cycle:${completion.sequence}',
              _historyEntry(
                timestamp: completion.completedAt,
                label: 'Cycle ${completion.sequence}',
                body: completion.note,
                extra: completion.resolutionRef == null
                    ? null
                    : Text(
                        completion.resolutionRef!,
                        style: const TextStyle(
                          color: MeshColors.accent,
                          fontSize: 11.5,
                        ),
                      ),
              ),
            ),
        ]..sort((a, b) {
          final time = b.$1.compareTo(a.$1);
          return time != 0 ? time : b.$2.compareTo(a.$2);
        });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (o.hasCheckpoint && !currentRecorded)
          _historyEntry(
            by: o.checkpointBy,
            timestamp: o.checkpointAt,
            label: 'current standing',
            body: o.checkpoint,
            latest: true,
          ),
        if (o.hasCheckpoint && !currentRecorded)
          Padding(
            padding: const EdgeInsets.only(bottom: 12, left: 36),
            child: Text(
              _historyNextBefore != null
                  ? 'This standing update is not in the loaded history.'
                  : 'Standing text from before history recording is unavailable.',
              style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
            ),
          ),
        for (final event in timeline) event.$3,
        if (timeline.isEmpty && !o.hasCheckpoint)
          const Text(
            'No recorded updates yet.',
            style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
          ),
        if (_historyError != null)
          Text(
            _historyError!,
            style: const TextStyle(color: MeshColors.textSecondary),
          ),
        if (_historyNextBefore != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _loadingHistory ? null : _loadMoreHistory,
              child: Text(_loadingHistory ? 'Loading…' : 'Show more updates'),
            ),
          ),
        if (_completionsHasMore)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _loadMoreCompletions,
              child: Text(
                'Load earlier completions (${_completionsTotal - _completions.length} remaining)',
              ),
            ),
          ),
      ],
    );
  }

  String _historyLabel(ObligationHistoryDto h) {
    if (h.kind == 'status') {
      return 'changed status ${h.before['status']} → ${h.after['status']}';
    }
    if (h.after.containsKey('checkpoint')) {
      return h.after['checkpoint'] == null
          ? 'cleared standing'
          : 'updated standing';
    }
    if (h.after['child'] case final Map<String, dynamic> child) {
      return 'created child currently here: ${child['title'] ?? child['id']} (current owner: ${store.actorDisplay(child['ownerId'] as String)})';
    }
    if (h.after['artifact'] case final Map<String, dynamic> artifact) {
      return 'attached ${artifact['label'] ?? referenceKindLabel((artifact['ref'] as String).split(':').first, null)}';
    }
    if (h.after['ownerId'] case final String owner) {
      return 'reassigned from ${store.actorDisplay(h.before['ownerId'] as String? ?? 'unknown')} to ${store.actorDisplay(owner)}';
    }
    if (h.after['status'] case final String status) {
      return 'changed status ${h.before['status']} → $status';
    }
    return switch (h.kind) {
      'created' => 'created this obligation',
      'reparent' => 'moved this obligation',
      'priority' => 'changed queue order',
      'external_ref' => 'changed external link',
      'snooze' => 'changed snooze',
      _ => 'updated obligation',
    };
  }

  Widget _historyEntry({
    String? by,
    String? timestamp,
    required String label,
    String? body,
    bool latest = false,
    Widget? extra,
  }) => IntrinsicHeight(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          width: 28,
          child: Column(
            children: [
              if (by != null)
                _personAvatar(by)
              else
                const Icon(
                  Icons.history,
                  size: 20,
                  color: MeshColors.textMuted,
                ),
              Expanded(
                child: Container(
                  width: 1,
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  color: MeshColors.border,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '${by == null ? 'Unknown author' : store.actorDisplay(by)} $label${timestamp == null ? '' : ' · ${formatTs(timestamp)}'}',
                  style: const TextStyle(
                    color: MeshColors.textSecondary,
                    fontSize: 12,
                    height: 1.4,
                  ),
                ),
                if (extra != null)
                  Padding(padding: const EdgeInsets.only(top: 4), child: extra),
                if (body != null)
                  Container(
                    margin: const EdgeInsets.only(top: 8),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: MeshColors.bgSecondary,
                      border: Border.all(color: MeshColors.border),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (latest)
                          const Padding(
                            padding: EdgeInsets.only(bottom: 6),
                            child: Text(
                              'LATEST',
                              style: TextStyle(
                                color: MeshColors.accent,
                                fontSize: 10,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        SelectableText(
                          body,
                          style: const TextStyle(
                            color: MeshColors.textSecondary,
                            fontSize: 13,
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    ),
  );

  Widget _ownerPanel(String ownerId) => _identityPanel(ownerId, role: 'Owner');

  /// Who raised this obligation. Null is a real, honest state — a row that
  /// predates creator attribution — not something to paper over by falling
  /// back to the owner or guessing.
  Widget _creatorPanel(String? creatorId) => creatorId == null
      ? const Padding(
          padding: EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Unknown — predates creator attribution',
                  style: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                ),
              ),
              Text(
                'Creator',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 12),
              ),
            ],
          ),
        )
      : _identityPanel(creatorId, role: 'Creator');

  Widget _identityPanel(String id, {String role = 'Owner'}) {
    final isHuman = store.isHuman(id);
    final isSystem = id.startsWith('system:');
    final isActor = !isHuman && !isSystem;

    VoidCallback? onTap;
    String? tooltip;
    if (isActor) {
      onTap = () {
        store.clickActor(id);
        store.setDetailPanelIndex(4); // Select Inbox tab
        onSelectView(DashboardView.actors);
      };
      tooltip = 'View $role Inbox →';
    } else if (isHuman) {
      onTap = () {
        onSelectView(DashboardView.overview);
      };
      tooltip = 'View $role Queue →';
    }

    final row = Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          _personAvatar(id),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              store.actorDisplay(id),
              style: const TextStyle(
                color: MeshColors.textPrimary,
                fontSize: 13,
              ),
            ),
          ),
          Text(
            role,
            style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
          ),
        ],
      ),
    );

    if (onTap == null) {
      return row;
    }

    return Tooltip(
      message: tooltip ?? '',
      child: InkWell(
        borderRadius: BorderRadius.circular(4),
        onTap: onTap,
        child: row,
      ),
    );
  }

  Widget _personAvatar(String id) =>
      store.isHuman(id) || id.startsWith('system:')
      ? const CircleAvatar(
          radius: 12,
          backgroundColor: MeshColors.bgTertiary,
          child: Icon(
            Icons.person_outline,
            size: 16,
            color: MeshColors.textSecondary,
          ),
        )
      : ActorAvatar(id: id, size: 24);

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

  Widget _externalRefPanel(
    BuildContext context,
    ObligationDetailSnapshot data,
  ) {
    final o = data.obligation;
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
      return Row(
        children: [
          const Icon(Icons.link_off, color: MeshColors.textMuted, size: 18),
          const SizedBox(width: 8),
          const Expanded(
            child: Text(
              'Not linked to an issue, PR or repository.',
              style: TextStyle(color: MeshColors.textMuted, fontSize: 12.5),
            ),
          ),
          ?edit,
        ],
      );
    }
    return _referenceLine(_settled(ref), action: edit);
  }

  Widget _completionMatcherPanel(CompletionMatcherDto matcher) {
    final label = matcher.kind == 'pr_merged'
        ? 'Complete when this pull request merges'
        : 'Complete when this instance deploys a descendant build';
    final state = matcher.satisfiedAt != null
        ? 'Satisfied ${formatTs(matcher.satisfiedAt!)}'
        // Recorded once and not cleared by a reopen, so it is stated as a past
        // observation; a later merge of the reopened PR still satisfies it.
        : matcher.closedUnmergedAt != null
        ? 'PR was closed without merging at ${formatTs(matcher.closedUnmergedAt!)}'
        : 'Pending';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: MeshColors.textPrimary, fontSize: 12.5),
        ),
        const SizedBox(height: 6),
        SelectableText(
          matcher.target,
          style: const TextStyle(color: MeshColors.accent, fontSize: 12),
        ),
        const SizedBox(height: 6),
        Text(
          '$state · set by ${store.actorDisplay(matcher.setBy)}',
          style: const TextStyle(color: MeshColors.textMuted, fontSize: 11.5),
        ),
        // A merged PR's resolution is its own target, already shown above.
        if (matcher.kind == 'deployed' && matcher.satisfiedRef != null) ...[
          const SizedBox(height: 4),
          SelectableText(
            'Resolution: ${matcher.satisfiedRef}',
            style: const TextStyle(color: MeshColors.textMuted, fontSize: 11.5),
          ),
        ],
      ],
    );
  }

  Widget _childrenPanel(BuildContext context, ObligationDetailSnapshot data) {
    final all = data.children;
    // Only `done` is hidden: that is what #396 asks for, and a cancelled child
    // is not "completed" — it stays listed so the reader sees it was dropped.
    final hiddenCount = all.where((c) => c.isDone).length;
    // Filtering keeps the server's order for whatever remains, so the visible
    // rows (and the reorder neighbours computed from them) are the same
    // siblings in the same sequence, minus the ones that are done.
    final list = _showDoneChildren ? all : all.where((c) => !c.isDone).toList();

    if (all.isEmpty) {
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
                  showKindChip: false,
                  openLink: openLink,
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
                            await store.mutateObligations(
                              () => store.api.reorderObligation(
                                c.id,
                                previousId: previousId,
                                nextId: nextId,
                              ),
                            );
                            onMutated();
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
                            await store.mutateObligations(
                              () => store.api.reorderObligation(
                                c.id,
                                previousId: previousId,
                                nextId: nextId,
                              ),
                            );
                            onMutated();
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
          if (list.isEmpty)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                hiddenCount == 1
                    ? 'The only child is done.'
                    : 'All $hiddenCount children are done.',
                style: const TextStyle(
                  color: MeshColors.textMuted,
                  fontSize: 13,
                ),
              ),
            ),
          if (hiddenCount > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: TextButton(
                onPressed: () =>
                    setState(() => _showDoneChildren = !_showDoneChildren),
                child: Text(
                  _showDoneChildren
                      ? 'Hide done children'
                      : 'Show $hiddenCount done '
                            '${hiddenCount == 1 ? 'child' : 'children'}',
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _dependencyPanel(
    List<ObligationDto> dependencies, {
    required int total,
    required bool hasMore,
    required String emptyText,
  }) {
    if (dependencies.isEmpty) {
      return Text(
        emptyText,
        style: const TextStyle(color: MeshColors.textMuted, fontSize: 13),
      );
    }

    final remaining = total - dependencies.length;
    return Container(
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < dependencies.length; i++) ...[
            ObligationRow(
              obligation: dependencies[i],
              store: store,
              showOwner: true,
              showActions: false,
              showKindChip: false,
              onSelectView: onSelectView,
              openLink: openLink,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 12,
              ),
            ),
            if (i < dependencies.length - 1 || hasMore)
              const Divider(height: 1, color: MeshColors.border),
          ],
          if (hasMore)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Text(
                'and $remaining more',
                style: const TextStyle(
                  color: MeshColors.textMuted,
                  fontSize: 13,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _detailHeader(BuildContext context, ObligationDetailSnapshot data) {
    final o = data.obligation;
    final actions = <Widget>[
      IconButton(
        tooltip: 'Mark Done',
        icon: const Icon(Icons.check_circle_outline),
        color: ObligationStatusColors.done.chipForeground,
        onPressed: () => confirmAndSetObligationStatus(
          context,
          store,
          o,
          'done',
          onUpdated: onMutated,
        ),
      ),
      IconButton(
        tooltip: 'Cancel Obligation',
        icon: const Icon(Icons.cancel_outlined),
        color: ObligationStatusColors.cancelled.chipForeground,
        onPressed: () => confirmAndSetObligationStatus(
          context,
          store,
          o,
          'cancelled',
          onUpdated: onMutated,
        ),
      ),
      if (canSnoozeObligation(store, o))
        IconButton(
          tooltip: o.isSnoozed ? 'Change snooze' : 'Snooze',
          icon: const Icon(Icons.snooze),
          color: kSnoozeColor,
          onPressed: () => showSnoozeObligationDialog(
            context,
            store,
            o,
            onUpdated: onMutated,
          ),
        ),
      IconButton(
        tooltip: 'Reassign obligation',
        icon: const Icon(Icons.person_outline),
        onPressed: () => showReassignObligationDialog(
          context,
          store,
          o,
          onReassigned: onMutated,
        ),
      ),
      IconButton(
        tooltip: 'Add child obligation',
        icon: const Icon(Icons.add_task),
        onPressed: () => showCreateObligationDialog(
          context,
          store,
          defaultParentId: o.id,
          defaultOwnerId: o.ownerId,
          onCreated: onMutated,
        ),
      ),
    ];
    const titleStyle = TextStyle(
      color: MeshColors.textPrimary,
      fontSize: 22,
      fontWeight: FontWeight.bold,
    );
    final status = ObligationStatusChip(
      obligation: o,
      store: store,
      bordered: true,
    );
    return Wrap(
      alignment: WrapAlignment.start,
      crossAxisAlignment: WrapCrossAlignment.center,
      runSpacing: 4,
      spacing: 8,
      children: [
        IntrinsicWidth(
          child: SelectableText(
            o.heading,
            key: const ValueKey('obligation-detail-title'),
            minLines: 1,
            maxLines: 2,
            style: titleStyle,
            textWidthBasis: TextWidthBasis.longestLine,
          ),
        ),
        Wrap(
          key: const ValueKey('obligation-detail-actions'),
          alignment: WrapAlignment.start,
          crossAxisAlignment: WrapCrossAlignment.center,
          runSpacing: 4,
          spacing: 8,
          children: [status, if (!o.isTerminal) ...actions],
        ),
      ],
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

/// Merges incoming completions with existing loaded completions by stable
/// completion ID and sorts them descending by sequence (newest first).
///
/// Preserves paged historical cycles across refreshes without assuming
/// positional alignment or dropping seam rows when new completions land.
List<ObligationCompletionDto> mergeCompletions(
  List<ObligationCompletionDto> incoming,
  List<ObligationCompletionDto> existing,
) {
  if (existing.isEmpty) return incoming;
  if (incoming.isEmpty) return existing;
  final byId = <String, ObligationCompletionDto>{};
  for (final c in incoming) {
    byId[c.id] = c;
  }
  for (final c in existing) {
    byId.putIfAbsent(c.id, () => c);
  }
  final merged = byId.values.toList();
  // Stable order: descending by completion sequence (newest first),
  // matching the database contract (ORDER BY sequence DESC).
  merged.sort((a, b) => b.sequence.compareTo(a.sequence));
  return merged;
}
