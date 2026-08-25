// Headless render-check for the IU calibration view's archived-node filter.
//
// curl-the-store != render-the-view: this drives the REAL glass_goals SyncClient +
// status machinery (the same `getStatusPredicate`/`getGoalStatus` the view passes to
// `FlattenedGoalTree`) over an in-memory graph that contains an archived node, and asserts
// the predicate the view uses excludes the archived node while keeping active/done/
// statusless ones. Run before a human opens the view so a filter regression is caught.
//
// Run: PUB_CACHE=... CI=true <flutter>/bin/cache/dart-sdk/bin/dart run tool/iu_archived_filter_check.dart
import 'dart:io';

import 'package:goals_core/model.dart'
    show Goal, GoalPath, WorldContext, getStatusPredicate;
import 'package:goals_core/sync.dart'
    show
        AddParentLogEntry,
        GoalDelta,
        GoalStatus,
        MemoryLocalStore,
        MemoryPersistenceService,
        StatusLogEntry,
        SyncClient;

// Kept identical to `_nonArchivedPredicate` in lib/iu/iu_tree_view.dart.
final _nonArchivedPredicate = getStatusPredicate({
  null,
  GoalStatus.pending,
  GoalStatus.active,
  GoalStatus.done,
});

Future<void> main() async {
  final client = SyncClient(
    persistenceService: MemoryPersistenceService(),
    localStore: MemoryLocalStore(),
  );
  await client.init();

  // root
  //  ├─ active     (status: active)
  //  ├─ done       (status: done)
  //  ├─ plain      (no status)
  //  └─ archived   (status: archived)   <- must be filtered out
  await client.modifyGoal(const GoalDelta(id: 'root', text: 'root'));
  final now = DateTime.now();
  Future<void> addChild(String id, GoalStatus? status) async {
    await client.modifyGoal(GoalDelta(
      id: id,
      text: id,
      logEntry: AddParentLogEntry(
        id: '$id-edge',
        parentId: 'root',
        creationTime: now,
      ),
    ));
    if (status != null) {
      await client.modifyGoal(GoalDelta(
        id: id,
        logEntry: StatusLogEntry(
          id: '$id-status',
          creationTime: now,
          status: status,
          startTime: now,
        ),
      ));
    }
  }

  await addChild('active', GoalStatus.active);
  await addChild('done', GoalStatus.done);
  await addChild('plain', null);
  await addChild('archived', GoalStatus.archived);

  final Map<String, Goal> goalMap = client.stateSubject.value;
  final ctx = WorldContext.now();

  bool visible(String id) {
    final goal = goalMap[id];
    if (goal == null) {
      throw StateError('fixture goal "$id" missing from the rebuilt graph');
    }
    return _nonArchivedPredicate(ctx, goalMap, GoalPath(['root', id]), goal);
  }

  final results = {
    'active': visible('active'),
    'done': visible('done'),
    'plain': visible('plain'),
    'archived': visible('archived'),
  };

  final failures = <String>[];
  results.forEach((id, shown) {
    final expected = id != 'archived';
    final mark = shown == expected ? 'ok' : 'FAIL';
    stdout.writeln('  $mark $id: visible=$shown (expected $expected)');
    if (shown != expected) {
      failures.add(id);
    }
  });

  stdout.writeln(
      'IU archived-filter render-check: ${failures.isEmpty ? "PASS" : "FAIL"}');
  exit(failures.isEmpty ? 0 : 1);
}
