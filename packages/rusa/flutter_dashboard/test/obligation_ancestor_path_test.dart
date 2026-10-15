import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/obligation_store.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/obligation_ancestor_path.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';

/// Root first: a chain too long for any card, so My Queue always folds it.
const _chain = [
  ('goal', 'Company operating plan for the fiscal year'),
  ('eng', 'Engineering platform and developer productivity'),
  ('rel', 'Reliability and incident response programme'),
  ('dash', 'Mesh dashboard improvements for operators'),
  ('queue', 'My Queue navigation and wayfinding polish'),
  ('crumbs', 'Ancestor breadcrumbs for queue cards'),
];

List<ObligationDto> _fixtures() => [
  for (var i = 0; i < _chain.length; i++)
    makeObligation(
      _chain[i].$1,
      parentId: i == 0 ? null : _chain[i - 1].$1,
      ownerId: 'worker-1',
      intent: _chain[i].$2,
    ),
  makeObligation('ops', ownerId: 'worker-1', intent: 'Operations'),
  makeObligation(
    'hiring',
    parentId: 'ops',
    ownerId: 'worker-1',
    intent: 'Hiring',
  ),
  makeObligation(
    'ob-deep',
    parentId: 'crumbs',
    ownerId: testUserPrincipalId,
    intent: 'Approve the breadcrumb design',
    effectivePriority: 100,
  ),
  makeObligation(
    'ob-short',
    parentId: 'hiring',
    ownerId: testUserPrincipalId,
    intent: 'Sign the offer letter',
    effectivePriority: 200,
  ),
  makeObligation(
    'ob-root',
    ownerId: testUserPrincipalId,
    intent: 'Pick the offsite venue',
    effectivePriority: 300,
  ),
];

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await Future<void>.delayed(Duration.zero);
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Finder _crumb(String id) => find.byKey(ValueKey('ancestor-crumb-$id'));
Finder _menuEntry(String id) => find.byKey(ValueKey('ancestor-menu-$id'));
final _more = find.byKey(const ValueKey('ancestor-path-more'));

void main() {
  group('ObligationAncestorPath.visibleCount', () {
    test('shows the whole path when it fits', () {
      expect(ObligationAncestorPath.visibleCount([50, 50, 50], 500), 3);
    });

    test('keeps the nearest parents that fit after the …', () {
      // … (28) + gap (4), then a separator (14) and a crumb (50) each.
      expect(ObligationAncestorPath.visibleCount([50, 50, 50], 170), 2);
      expect(ObligationAncestorPath.visibleCount([50, 50, 50], 100), 1);
    });

    test('never hides the parent, nor shows a lone parent behind a …', () {
      expect(ObligationAncestorPath.visibleCount([10, 10, 10], 50), 1);
      expect(ObligationAncestorPath.visibleCount([400], 100), 1);
    });
  });

  group('ObligationEntities.ancestorsOf', () {
    test(
      'walks the held parents root first, and stops where one is missing',
      () {
        final entities = ObligationEntities(
          byId: {
            for (final o in [
              makeObligation('top'),
              makeObligation('mid', parentId: 'top'),
              makeObligation('leaf', parentId: 'mid'),
              makeObligation('orphan-parent', parentId: 'gone'),
              makeObligation('orphan', parentId: 'orphan-parent'),
              makeObligation('loop-a', parentId: 'loop-b'),
              makeObligation('loop-b', parentId: 'loop-a'),
            ])
              o.id: o,
          },
        );
        List<String> path(String id) => [
          for (final o in entities.ancestorsOf(id)) o.id,
        ];
        expect(path('leaf'), ['top', 'mid']);
        expect(path('top'), isEmpty);
        expect(path('orphan'), ['orphan-parent']);
        expect(path('unknown'), isEmpty);
        expect(path('loop-a'), ['loop-b']);
      },
    );
  });

  group('ObligationAncestorPath', () {
    final ancestors = [
      for (var i = 0; i < _chain.length; i++)
        makeObligation(
          _chain[i].$1,
          parentId: i == 0 ? null : _chain[i - 1].$1,
          intent: _chain[i].$2,
        ),
    ];

    Future<List<String>> pumpPath(WidgetTester tester, double width) async {
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: width,
                child: ObligationAncestorPath(
                  ancestors: ancestors,
                  onOpen: opened.add,
                ),
              ),
            ),
          ),
        ),
      );
      return opened;
    }

    testWidgets('shows a path that fits in full, with no …', (tester) async {
      tester.view.physicalSize = const Size(5000, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await pumpPath(tester, 4800);
      for (final (id, _) in _chain) {
        expect(_crumb(id), findsOneWidget);
      }
      expect(_more, findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'folds the root end into a … that lists the hidden ancestors, root '
      'first, and opens each',
      (tester) async {
        final opened = await pumpPath(tester, 360);
        expect(tester.takeException(), isNull);
        expect(_more, findsOneWidget);
        expect(_crumb('crumbs'), findsOneWidget);
        expect(_crumb('goal'), findsNothing);
        final hidden = [
          for (final (id, _) in _chain)
            if (_crumb(id).evaluate().isEmpty) id,
        ];
        // Only a prefix from the root is hidden.
        expect(hidden, _chain.map((c) => c.$1).take(hidden.length));

        await tester.tap(_more);
        await tester.pumpAndSettle();
        final tops = [
          for (final id in hidden) tester.getTopLeft(_menuEntry(id)).dy,
        ];
        expect(tops, [...tops]..sort());
        expect(find.textContaining('Earlier'), findsNothing);
        expect(find.byIcon(Icons.account_tree_outlined), findsOneWidget);

        // An outside tap dismisses the list without opening anything.
        await tester.tapAt(const Offset(700, 500));
        await tester.pumpAndSettle();
        expect(_menuEntry(hidden.first), findsNothing);
        expect(opened, isEmpty);

        for (final id in hidden) {
          await tester.tap(_more);
          await tester.pumpAndSettle();
          await tester.tap(_menuEntry(id));
          await tester.pumpAndSettle();
          expect(_menuEntry(id), findsNothing);
        }
        final visible = [
          for (final (id, _) in _chain)
            if (!hidden.contains(id)) id,
        ];
        for (final id in visible) {
          await tester.tap(_crumb(id));
          await tester.pump();
        }
        expect(opened, [...hidden, ...visible]);
      },
    );

    testWidgets('cuts a lone parent short rather than overflowing', (
      tester,
    ) async {
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 80,
              child: ObligationAncestorPath(
                ancestors: [ancestors.last],
                onOpen: opened.add,
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(_more, findsNothing);
      await tester.tap(_crumb('crumbs'));
      expect(opened, ['crumbs']);
    });
  });

  group('My Queue ancestor paths (#1076)', () {
    for (final (viewport, size) in const [
      ('desktop', Size(1180, 820)),
      ('phone', Size(390, 844)),
    ]) {
      testWidgets('$viewport: paths render, fold and navigate', (tester) async {
        await tester.runAsync(() async {
          tester.view
            ..physicalSize = size
            ..devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          final api = FakeApi()
            ..threadsResult = [makeThread('root')]
            ..obligationsResult = _fixtures();
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);
          final views = <DashboardView>[];
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: OverviewTab(store: store, onSelectView: views.add),
              ),
            ),
          );
          await _settle(tester);
          expect(tester.takeException(), isNull);

          // Every queue page asks for its rows' ancestors in the same read.
          final queuePages = api.fetchObligationsCalls.where(
            (c) => c.queue != null,
          );
          expect(queuePages, isNotEmpty);
          expect(queuePages.every((c) => c.ancestors), isTrue);

          // Order and membership are the queue's own: ancestors owned by
          // others are path crumbs, never rows.
          expect(find.text('3 obligations'), findsOneWidget);
          final titles = [
            'Approve the breadcrumb design',
            'Sign the offer letter',
            'Pick the offsite venue',
          ];
          final tops = [
            for (final t in titles) tester.getTopLeft(find.text(t)).dy,
          ];
          expect(tops, [...tops]..sort());

          // One path per row with a parent; none for the root obligation.
          expect(find.byType(ObligationAncestorPath), findsNWidgets(2));
          expect(_crumb('ops'), findsOneWidget);
          expect(_crumb('hiring'), findsOneWidget);
          expect(_more, findsOneWidget);
          expect(_crumb('crumbs'), findsOneWidget);
          expect(_crumb('goal'), findsNothing);

          final hidden = [
            for (final (id, _) in _chain)
              if (_crumb(id).evaluate().isEmpty) id,
          ];
          final visible = [
            for (final (id, _) in _chain)
              if (!hidden.contains(id)) id,
            'ops',
            'hiring',
          ];

          // Each crumb opens its own obligation, not the card's.
          for (final id in visible) {
            store.setFocusedObligationId(null);
            views.clear();
            await tester.tap(_crumb(id));
            await tester.pump();
            expect(store.focusedObligationId.value, id, reason: id);
            expect(views, [DashboardView.work], reason: id);
          }

          // So does each hidden ancestor, root first in the list.
          for (final id in hidden) {
            store.setFocusedObligationId(null);
            views.clear();
            await tester.tap(_more);
            await _settle(tester);
            expect(find.textContaining('Earlier'), findsNothing);
            await tester.tap(_menuEntry(id));
            await _settle(tester);
            expect(store.focusedObligationId.value, id, reason: id);
            expect(views, [DashboardView.work], reason: id);
            expect(_menuEntry(id), findsNothing);
          }

          // The card itself still opens its own obligation.
          views.clear();
          await tester.tap(find.text('Approve the breadcrumb design'));
          await tester.pump();
          expect(store.focusedObligationId.value, 'ob-deep');
          expect(views, [DashboardView.work]);
          expect(tester.takeException(), isNull);
        });
      });
    }

    testWidgets('a refresh shows a renamed ancestor and a reparented row', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = _fixtures();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: OverviewTab(store: store)),
          ),
        );
        await _settle(tester);
        expect(find.text('Hiring'), findsOneWidget);

        Future<void> refresh(List<ObligationDto> fixtures) async {
          api.obligationsResult = fixtures;
          await tester.tap(find.byTooltip('Refresh Queue'));
          await _settle(tester);
          expect(tester.takeException(), isNull);
        }

        // Renamed.
        await refresh([
          for (final o in _fixtures())
            o.id == 'hiring'
                ? makeObligation(
                    'hiring',
                    parentId: 'ops',
                    ownerId: 'worker-1',
                    intent: 'Recruiting',
                  )
                : o,
        ]);
        expect(find.text('Hiring'), findsNothing);
        expect(_crumb('hiring'), findsOneWidget);
        expect(find.text('Recruiting'), findsOneWidget);

        // Reparented: the deep row now sits under Operations.
        await refresh([
          for (final o in _fixtures())
            o.id == 'ob-deep'
                ? makeObligation(
                    'ob-deep',
                    parentId: 'ops',
                    ownerId: testUserPrincipalId,
                    intent: 'Approve the breadcrumb design',
                    effectivePriority: 100,
                  )
                : o,
        ]);
        expect(_more, findsNothing);
        expect(_crumb('crumbs'), findsNothing);
        expect(_crumb('ops'), findsNWidgets(2));

        expect(find.text('3 obligations'), findsOneWidget);
      });
    });

    testWidgets(
      'an ancestor the page cannot carry ends the path at the nearest parents',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..threadsResult = [makeThread('root')]
            ..obligationsResult = [
              for (final o in _fixtures())
                if (o.id != 'ops' && o.id != 'rel') o,
            ];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(body: OverviewTab(store: store)),
            ),
          );
          await _settle(tester);
          expect(tester.takeException(), isNull);
          expect(find.text('3 obligations'), findsOneWidget);
          expect(_crumb('hiring'), findsOneWidget);
          expect(_crumb('ops'), findsNothing);
          expect(_crumb('crumbs'), findsOneWidget);
          expect(_crumb('eng'), findsNothing);
          expect(_crumb('goal'), findsNothing);
          await tester.tap(_crumb('hiring'));
          await tester.pump();
          expect(store.focusedObligationId.value, 'hiring');
        });
      },
    );
  });
}
