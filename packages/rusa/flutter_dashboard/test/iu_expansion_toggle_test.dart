// Render-check for the IU calibration view's expansion wiring (ISSUE_NUM task 2).
//
// The calibration tree's arrows did nothing because the view used
// `GoalActionsContext.empty()`, whose `onExpanded` is a no-op. `readOnlyExpandableActions`
// supplies a live `onExpanded`. The tree's expansion arrow calls `onExpanded(path)` with no
// `expanded` arg (goals_widgets/.../goal_item.dart), which routes to `togglePath` over the
// shared `expandedGoalsProvider`.
//
// This drives the REAL glass_goals provider/toggle machinery (not a curl): it calls the
// context's actual `onExpanded` and asserts the shared expanded set changes — toggling a
// path on, then off, then expanding explicitly.
import 'package:flutter/widgets.dart' show SizedBox;
import 'package:flutter_test/flutter_test.dart';
import 'package:goals_core/model.dart' show GoalPath;
import 'package:goals_ui_core/core.dart' show expandedGoalsProvider, pathsMatch;
import 'package:rusa_dashboard/iu/iu_tree_actions.dart';

void main() {
  setUp(() {
    // The provider is a shared singleton; start each test from a clean set.
    expandedGoalsProvider.add([]);
  });

  bool isExpanded(GoalPath path) =>
      expandedGoalsProvider.value.any((p) => pathsMatch(p, path));

  test('onExpanded(path) toggles the path in the shared expanded set', () {
    final actions = readOnlyExpandableActions(child: const SizedBox());
    final path = GoalPath(['node-a']);

    expect(isExpanded(path), isFalse);

    // The arrow's actual route: no `expanded` arg -> togglePath.
    actions.onExpanded(path);
    expect(isExpanded(path), isTrue, reason: 'arrow tap should expand');

    actions.onExpanded(path);
    expect(isExpanded(path), isFalse, reason: 'second tap should collapse');
  });

  test('onExpanded(path, expanded: true) expands the path', () {
    final actions = readOnlyExpandableActions(child: const SizedBox());
    final path = GoalPath(['node-b']);

    expect(isExpanded(path), isFalse);
    actions.onExpanded(path, expanded: true);
    expect(isExpanded(path), isTrue);
  });

  test('toggling one path leaves other expanded paths untouched', () {
    final actions = readOnlyExpandableActions(child: const SizedBox());
    final a = GoalPath(['node-a']);
    final b = GoalPath(['node-b']);

    actions.onExpanded(a, expanded: true);
    actions.onExpanded(b);
    expect(isExpanded(a), isTrue);
    expect(isExpanded(b), isTrue);

    actions.onExpanded(b); // collapse b only
    expect(isExpanded(a), isTrue, reason: 'a must stay expanded');
    expect(isExpanded(b), isFalse);
  });
}
