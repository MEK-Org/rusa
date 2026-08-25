import 'package:flutter/material.dart';
import 'package:goals_core/model.dart' show Goal, GoalPath, getStatusPredicate;
import 'package:goals_core/sync.dart' show GoalStatus, SyncClient;
import 'package:goals_ui_core/core.dart'
    show GoalWidgetsContext, selectedGoalsProvider;
import 'package:goals_widgets/goals_widgets.dart' show FlattenedGoalTree;

import 'iu_node_detail_panel.dart';
import 'iu_tree_actions.dart';
import 'op_getter_persistence.dart';

/// The IU tree view: renders the Integrated Knowledge Universe graph
/// (served by the rusa op-getter) in a interactive master-detail tree.
///
/// A browser goals-core `SyncClient` over [OpGetterPersistenceService] rebuilds the graph
/// in the browser; it renders via glass-goals' `FlattenedGoalTree`. **Strictly read-only**:
/// the persistence never writes, and [readOnlyExpandableActions] makes every *mutating* tree
/// action inert; hover actions render nothing. The only live actions are expand/collapse
/// (the tree's arrows) and select — clicking a node opens a right-hand [IuNodeDetailPanel]
/// that renders the node's Markdown contents (a master-detail split).
///
/// Archived nodes are excluded from the default view via a status predicate that admits
/// every status *except* `archived` (and statusless nodes) — mirroring how the glass-goals
/// slice views filter their trees.
///
/// Body-only (no Scaffold/AppBar) so it embeds below the shared dashboard header — the
/// header nav switches between the Actors dashboard and this view. A slim caption carries
/// the context the old AppBar title held.
/// Show every node except archived ones. `getStatusPredicate` admits a node when it has
/// no status (`null`) or its status is in the set, so listing the non-archived statuses
/// hides archived nodes while keeping pending/active/done visible.
final _nonArchivedPredicate = getStatusPredicate({
  null,
  GoalStatus.pending,
  GoalStatus.active,
  GoalStatus.done,
});

/// Select the paths that appear as roots in the dashboard tree.
///
/// A configured root is a scope anchor, not a visible node. Its direct children
/// are the only apparent roots; [FlattenedGoalTree] then follows their descendants,
/// which keeps unrelated graph roots out of the rendered view. If the configured
/// root is absent, fail closed with an empty view instead of exposing the global
/// graph. The parentless-node fallback is retained only for unscoped installs.
List<GoalPath> iuTopLevelPaths(Map<String, Goal>? goalMap, String? rootNodeId) {
  if (goalMap == null || goalMap.isEmpty) return const [];

  if (rootNodeId != null) {
    final root = goalMap[rootNodeId];
    if (root == null) return const [];
    return root.subGoalIds
        .where(goalMap.containsKey)
        .map((id) => GoalPath([id]))
        .toList();
  }

  return goalMap.entries
      .where(
        (entry) => entry.value.superGoalIds.where(goalMap.containsKey).isEmpty,
      )
      .map((entry) => GoalPath([entry.key]))
      .toList();
}

class IuTreeBody extends StatefulWidget {
  const IuTreeBody({super.key});

  @override
  State<IuTreeBody> createState() => _IuTreeBodyState();
}

class _IuTreeBodyState extends State<IuTreeBody> {
  late final OpGetterPersistenceService _persistence;
  late final SyncClient _syncClient;
  late final Future<void> _ready;

  @override
  void initState() {
    super.initState();
    // Same-origin: the dashboard serves both the UI and /api/understanding/ops.
    _persistence = OpGetterPersistenceService();
    _syncClient = SyncClient(persistenceService: _persistence);
    _ready = _syncClient.init();
    // Selection is shared (glass-goals) UI state; start clean so a prior mount's
    // selection doesn't pop the detail panel open on entry.
    selectedGoalsProvider.add([]);
  }

  /// Master-detail split: [tree] on the left, and when a node is selected (and present in
  /// the would-be graph) an [IuNodeDetailPanel] on the right rendering its contents. With no
  /// selection the tree fills the width — the panel only appears once a node is clicked.
  Widget _splitWithDetail(Widget tree, Map<String, Goal> goalMap) {
    return StreamBuilder<List<GoalPath>>(
      stream: selectedGoalsProvider,
      initialData: selectedGoalsProvider.value,
      builder: (context, selSnap) {
        final selected = selSnap.data?.isNotEmpty == true
            ? selSnap.data!.last
            : null;
        // Only open the panel for a node that actually exists in the current graph — a
        // stale selection (e.g. after a reload dropped the node) just shows the tree.
        if (selected == null || !goalMap.containsKey(selected.goalId)) {
          return tree;
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(flex: 3, child: tree),
            Expanded(
              flex: 2,
              child: IuNodeDetailPanel(
                path: selected,
                goalMap: goalMap,
                // Resolve externalized node bodies via the SyncClient (→ op-getter strings
                // endpoint); inline distiller-written bodies resolve with no fetch.
                loadBody: _syncClient.loadString,
                onClose: () => selectedGoalsProvider.add([]),
              ),
            ),
          ],
        );
      },
    );
  }

  @override
  void dispose() {
    // Don't leak this view's selection to anything else that reads the shared provider.
    selectedGoalsProvider.add([]);
    _syncClient.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<void>(
      future: _ready,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(
            child: Text('Failed to load the graph: ${snapshot.error}'),
          );
        }
        return GoalWidgetsContext(
          syncClient: _syncClient,
          child: readOnlyExpandableActions(
            child: StreamBuilder<Map<String, Goal>>(
              stream: _syncClient.stateSubject,
              initialData: _syncClient.stateSubject.value,
              builder: (context, stateSnap) {
                final goalMap = stateSnap.data ?? const <String, Goal>{};
                final tree = SingleChildScrollView(
                  child: FlattenedGoalTree(
                    // The configured root is an invisible scope anchor: render only
                    // its direct children as apparent roots.
                    rootGoalPaths: iuTopLevelPaths(
                      stateSnap.data,
                      _persistence.rootNodeId,
                    ),
                    // Exclude archived nodes from the default tree view.
                    predicate: _nonArchivedPredicate,
                    hoverActionsBuilder: (_) => const SizedBox.shrink(),
                  ),
                );
                return _splitWithDetail(tree, goalMap);
              },
            ),
          ),
        );
      },
    );
  }
}
