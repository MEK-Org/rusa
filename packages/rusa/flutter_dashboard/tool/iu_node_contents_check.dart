// Headless render-check for the IU node-detail content path (ISSUE_NUM task 3).
//
// curl-the-store != render-the-view: the detail panel pulls a node's body from its latest
// `documentContents` log entry via `getDocumentEntry(...).text` (the distiller writes node
// bodies as Markdown there — see graph-store.ts). This drives the REAL glass_goals SyncClient
// rebuild over an in-memory node carrying a documentContents entry and asserts the extraction
// the panel relies on returns the Markdown body (and that a clear empties it).
//
// Run: PUB_CACHE=... CI=true <flutter>/bin/cache/dart-sdk/bin/dart run tool/iu_node_contents_check.dart
import 'dart:io';

import 'package:goals_core/model.dart'
    show Goal, GoalPath, getDocumentEntry;
import 'package:goals_core/sync.dart'
    show
        ClearDocumentContentsEntry,
        DocumentContentsEntry,
        GoalDelta,
        MemoryLocalStore,
        MemoryPersistenceService,
        SyncClient;

Future<void> main() async {
  final client = SyncClient(
    persistenceService: MemoryPersistenceService(),
    localStore: MemoryLocalStore(),
  );
  await client.init();

  const md = '# Heading\n\nBody with **bold** and `code`.';
  final now = DateTime.now();

  // A node: title + a documentContents Markdown body (how the distiller writes nodes).
  await client.modifyGoal(GoalDelta(
    id: 'node',
    text: 'Node title',
    logEntry: DocumentContentsEntry(
      id: 'node-doc',
      creationTime: now,
      text: md,
    ),
  ));

  final failures = <String>[];
  void check(String label, bool ok) {
    stdout.writeln('  ${ok ? "ok" : "FAIL"} $label');
    if (!ok) failures.add(label);
  }

  Map<String, Goal> goalMap = client.stateSubject.value;
  final path = GoalPath(['node']);

  check('node is in the rebuilt graph', goalMap.containsKey('node'));
  check('title preserved', goalMap['node']?.text == 'Node title');

  final entry = getDocumentEntry(path, goalMap: goalMap);
  check('getDocumentEntry returns a DocumentContentsEntry',
      entry is DocumentContentsEntry);
  check('document body is the Markdown the panel will render',
      entry is DocumentContentsEntry && entry.text == md);

  // Clearing the contents must make the panel fall back to its empty state.
  await client.modifyGoal(GoalDelta(
    id: 'node',
    logEntry: ClearDocumentContentsEntry(id: 'node-clear', creationTime: now),
  ));
  goalMap = client.stateSubject.value;
  final cleared = getDocumentEntry(path, goalMap: goalMap);
  check('after clear, no renderable document contents',
      cleared is! DocumentContentsEntry);

  stdout.writeln(
      'IU node-contents render-check: ${failures.isEmpty ? "PASS" : "FAIL"}');
  exit(failures.isEmpty ? 0 : 1);
}
