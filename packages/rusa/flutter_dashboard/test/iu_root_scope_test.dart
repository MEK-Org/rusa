import 'package:flutter_test/flutter_test.dart';
import 'package:goals_core/model.dart' show Goal;
import 'package:rusa_dashboard/iu/iu_tree_view.dart';

Goal _goal(String id) => Goal(id: id, text: id, creationTime: DateTime(2026));

void _link(Goal parent, Goal child) {
  parent.addSubGoal(child.id);
  child.addSuperGoal(parent.id);
}

void main() {
  test('configured root children are the only apparent top-level nodes', () {
    final root = _goal('configured-root');
    final childA = _goal('child-a');
    final childB = _goal('child-b');
    final grandchild = _goal('grandchild');
    final unrelatedRoot = _goal('unrelated-root');
    final unrelatedChild = _goal('unrelated-child');
    _link(root, childA);
    _link(root, childB);
    _link(childA, grandchild);
    _link(unrelatedRoot, unrelatedChild);

    final paths = iuTopLevelPaths({
      for (final goal in [
        root,
        childA,
        childB,
        grandchild,
        unrelatedRoot,
        unrelatedChild,
      ])
        goal.id: goal,
    }, root.id);

    expect(paths.map((path) => path.goalId), ['child-a', 'child-b']);
  });

  test('configured but missing root fails closed', () {
    final unrelatedRoot = _goal('unrelated-root');

    final paths = iuTopLevelPaths({
      unrelatedRoot.id: unrelatedRoot,
    }, 'missing-root');

    expect(paths, isEmpty);
  });

  test('unconfigured view preserves the parentless-node fallback', () {
    final rootA = _goal('root-a');
    final childA = _goal('child-a');
    final rootB = _goal('root-b');
    _link(rootA, childA);

    final paths = iuTopLevelPaths({
      for (final goal in [rootA, childA, rootB]) goal.id: goal,
    }, null);

    expect(paths.map((path) => path.goalId), ['root-a', 'root-b']);
  });
}
