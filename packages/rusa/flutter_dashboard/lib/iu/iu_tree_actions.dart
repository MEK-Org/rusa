import 'package:flutter/widgets.dart' show Widget;
import 'package:goals_core/model.dart' show GoalPath;
import 'package:goals_ui_core/core.dart'
    show
        GoalActionsContext,
        TimeSlice,
        addPath,
        expandedGoalsProvider,
        removePath,
        selectedGoalsProvider,
        togglePath;

/// A [GoalActionsContext] for the IU calibration view: every mutating action is a no-op
/// (the view is strictly read-only / dry-run-safe), **except** expand/collapse and select —
/// pure UI state wired to the shared [expandedGoalsProvider] / [selectedGoalsProvider] so
/// the tree's arrows toggle and clicking a node opens the detail panel.
///
/// `GoalActionsContext.empty()` makes *every* action inert — including `onExpanded` — which
/// is why the calibration tree's arrows did nothing. `overrideWith` can't help: it always
/// inherits `onExpanded` from the ancestor context. So this mirrors `.empty()`'s no-ops and
/// supplies two live actions:
///  * `onExpanded` → expand/collapse (so the tree's arrows toggle), and
///  * `onSelected` → single-select (so clicking a node opens the detail split-view).
///
/// Both are pure UI state (the shared `expandedGoalsProvider` / `selectedGoalsProvider`),
/// just like the real goal viewer — no graph mutation, so the view stays dry-run-safe.
GoalActionsContext readOnlyExpandableActions({required Widget child}) {
  return GoalActionsContext(
    child: child,
    onExpanded: (GoalPath path, {bool? expanded}) {
      if (expanded == null) {
        togglePath(expandedGoalsProvider, path);
      } else if (expanded) {
        addPath(expandedGoalsProvider, path);
      } else {
        removePath(expandedGoalsProvider, path);
      }
    },
    // Selecting a node drives the detail panel (and the tree's selection highlight).
    // `onSelected` receives the path as a `List<String>` (a `GoalPath` is one). Single
    // select: replace, so the panel always reflects the most-recently-clicked node.
    onSelected: (List<String> goalId) {
      selectedGoalsProvider.add([GoalPath(goalId)]);
    },
    // Everything below is inert — copied from `GoalActionsContext.empty()`.
    onFocused: (GoalPath path, {bool? inPlace}) {},
    onAddGoal:
        (
          GoalPath? parentPath,
          String text, {
          TimeSlice? slice,
          GoalPath? pathBefore,
          GoalPath? pathAfter,
        }) {},
    onUnarchive: (GoalPath? goalId) {},
    onArchive: (GoalPath? goalId) {},
    onDone: (GoalPath? goalId, DateTime? dateTime) {},
    onSnooze: (GoalPath? goalId, DateTime? dateTime) {},
    onActive: (GoalPath? goalId, {DateTime? startTime, DateTime? endTime}) {},
    onDropGoal:
        (
          GoalPath path, {
          GoalPath? dropPath,
          GoalPath? prevDropPath,
          GoalPath? nextDropPath,
        }) {},
    onMakeAnchor: (String goalId) {},
    onClearAnchor: (String goalId) {},
    onAddSummary: (String goalId) {},
    onClearSummary: (String goalId) {},
    onAddDocumentContent: (String goalId) {},
    onClearDocumentContent: (String goalId) {},
    onClearStatus: (GoalPath? goalId) {},
  );
}
