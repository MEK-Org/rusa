// Widget + wiring checks for the IU node-detail split-view (ISSUE_NUM task 3) + externalized
// body loading (ISSUE_NUM string-loading fix).
//
// Renders the panel over a real glass_goals `Goal` and asserts: an INLINE body (distiller
// writes) renders directly; an EXTERNALIZED body (baseline shape — a `documentContents` entry
// with text==null) loads via `loadBody` and renders; an unresolvable externalized body degrades
// to a per-node "Content unavailable" placeholder (distinct from a node with no body); the empty
// state; close clears selection; and `onSelected` drives the split. The externalized cases use
// the REAL text-less shape (NOT inline) — the trap that masked the original blank-content bug.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:goals_core/model.dart' show Goal, GoalPath;
import 'package:goals_core/sync.dart' show DocumentContentsEntry;
import 'package:goals_ui_core/core.dart' show pathsMatch, selectedGoalsProvider;
import 'package:rusa_dashboard/iu/iu_node_detail_panel.dart';
import 'package:rusa_dashboard/iu/iu_tree_actions.dart';
import 'package:rusa_dashboard/iu/simple_markdown.dart';

/// Build a node. `markdown` non-null → an INLINE body; `externalized: true` → a
/// `documentContents` entry with **null** text (the externalized baseline shape, body loaded
/// separately); neither → no body.
Goal _node({
  required String id,
  required String title,
  String? markdown,
  bool externalized = false,
}) {
  final goal = Goal(id: id, text: title, creationTime: DateTime(2026));
  if (markdown != null || externalized) {
    goal.prependEntry(
      DocumentContentsEntry(
        id: '$id-doc',
        creationTime: DateTime(2026),
        text: markdown, // null when externalized
      ),
    );
  }
  return goal;
}

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 600, child: child)),
);

void main() {
  testWidgets('renders the node title and its INLINE Markdown contents', (
    tester,
  ) async {
    final goal = _node(
      id: 'n1',
      title: 'Node title',
      markdown: '# A Heading\n\nBody text here.',
    );
    await tester.pumpWidget(
      _host(IuNodeDetailPanel(path: GoalPath(['n1']), goalMap: {'n1': goal})),
    );

    expect(find.text('Node title'), findsOneWidget);
    expect(find.byType(SimpleMarkdown), findsOneWidget);
    expect(find.textContaining('A Heading'), findsWidgets);
    expect(find.textContaining('Body text here.'), findsWidgets);
  });

  testWidgets(
    'loads + renders an EXTERNALIZED body via loadBody (real text-less shape)',
    (tester) async {
      final goal = _node(id: 'n1', title: 'Ext node', externalized: true);
      final requested = <String>[];
      await tester.pumpWidget(
        _host(
          IuNodeDetailPanel(
            path: GoalPath(['n1']),
            goalMap: {'n1': goal},
            loadBody: (entryId) async {
              requested.add(entryId);
              return '# Loaded\n\nResolved body content.';
            },
          ),
        ),
      );
      await tester
          .pump(); // resolve the loadBody future → FutureBuilder rebuilds

      expect(requested, ['n1-doc']); // loaded by the entry id, not the goal id
      expect(find.byType(SimpleMarkdown), findsOneWidget);
      expect(find.textContaining('Resolved body content.'), findsWidgets);
    },
  );

  testWidgets(
    'unresolvable externalized body → "Content unavailable" (per-node degrade)',
    (tester) async {
      final goal = _node(id: 'n1', title: 'Ext node', externalized: true);
      await tester.pumpWidget(
        _host(
          IuNodeDetailPanel(
            path: GoalPath(['n1']),
            goalMap: {'n1': goal},
            loadBody: (_) async => null, // Firestore miss / outage
          ),
        ),
      );
      await tester.pump();

      expect(find.textContaining('Content unavailable'), findsOneWidget);
      expect(find.byType(SimpleMarkdown), findsNothing);
    },
  );

  testWidgets(
    'externalized body with no resolver wired → "Content unavailable"',
    (tester) async {
      final goal = _node(id: 'n1', title: 'Ext node', externalized: true);
      await tester.pumpWidget(
        _host(IuNodeDetailPanel(path: GoalPath(['n1']), goalMap: {'n1': goal})),
      );

      expect(find.textContaining('Content unavailable'), findsOneWidget);
    },
  );

  testWidgets(
    'node with no document contents → "no document contents" (distinct empty state)',
    (tester) async {
      final goal = _node(id: 'n2', title: 'Empty node');
      await tester.pumpWidget(
        _host(
          IuNodeDetailPanel(
            path: GoalPath(['n2']),
            goalMap: {'n2': goal},
            loadBody: (_) async => 'should not be called',
          ),
        ),
      );

      expect(find.text('Empty node'), findsOneWidget);
      expect(find.byType(SimpleMarkdown), findsNothing);
      expect(find.textContaining('no document contents'), findsOneWidget);
      expect(find.textContaining('Content unavailable'), findsNothing);
    },
  );

  testWidgets('close button clears the selection', (tester) async {
    selectedGoalsProvider.add([
      GoalPath(['n1']),
    ]);
    var closed = false;
    await tester.pumpWidget(
      _host(
        IuNodeDetailPanel(
          path: GoalPath(['n1']),
          goalMap: {'n1': _node(id: 'n1', title: 'T', markdown: 'x')},
          onClose: () => closed = true,
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.close));
    expect(closed, isTrue);
  });

  test('onSelected drives the shared selection provider (opens the split)', () {
    selectedGoalsProvider.add([]);
    final actions = readOnlyExpandableActions(child: const SizedBox());

    actions.onSelected(['node-x']);
    expect(
      selectedGoalsProvider.value.any((p) => pathsMatch(p, ['node-x'])),
      isTrue,
    );

    actions.onSelected(['node-y']);
    expect(selectedGoalsProvider.value.length, 1);
    expect(pathsMatch(selectedGoalsProvider.value.single, ['node-y']), isTrue);
  });
}
