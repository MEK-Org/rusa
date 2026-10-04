// Real WorkTab screenshots with synthetic data only.
// flutter test --dart-define=DETAIL_PHASE=before test/obligation_detail_864_screenshot_test.dart
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';
import 'fakes.dart';
import 'screenshot_support.dart';

void main() {
  setUpAll(loadFonts);
  for (final size in [const Size(1600, 1000), const Size(390, 844)]) {
    testWidgets('obligation detail ${size.width}', (tester) async {
      await tester.runAsync(() async {
        final ids = ['coder', 'steward'];
        HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
        addTearDown(() => HttpOverrides.global = null);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.binding.setSurfaceSize(size);
        final ob = makeObligation(
          'export',
          ownerId: 'coder',
          creatorId: 'steward',
          title: 'Export run history as CSV',
          intent:
              'An operator can download an actor’s run history as a CSV from the actor page, with one row per run: start, end, model, exit status and token totals. The export respects the current filters and streams, so a year of runs downloads without freezing the page.',
          checkpoint:
              'Pull request is green. Download button added to the actor page; export honours the status and date filters. Two reviews requested. Next: answer review questions, then merge.',
          checkpointBy: 'coder',
          checkpointAt: '2026-10-03T12:00:00.000Z',
          externalRef: 'github:example-org/example/issues/398',
        );
        final root = makeObligation(
          'dashboard',
          ownerId: 'steward',
          intent: 'Dashboard',
          status: 'waiting',
        );
        final child = makeObligation(
          'child',
          ownerId: 'coder',
          intent: 'Land the export endpoint',
          parentId: 'export',
        );
        final dep = makeObligation(
          'dependency',
          ownerId: 'steward',
          intent: 'Paginate the runs API',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('coder'), makeThread('steward')]
          ..obligationsResult = [ob, root, child]
          ..obligationDetails['export'] = ObligationDetailSnapshot.fromJson({
            'obligation': {
              'id': 'export',
              'ownerId': 'coder',
              'creatorId': 'steward',
              'title': ob.heading,
              'intent': ob.body,
              'status': 'ready',
              'effectivePriority': 1.0,
              'checkpoint': ob.checkpoint,
              'checkpointAt': ob.checkpointAt,
              'checkpointBy': 'coder',
              'externalRef': 'github:example-org/example/issues/398',
            },
            'ancestors': [
              {
                'id': 'dashboard',
                'ownerId': 'steward',
                'title': 'Dashboard',
                'status': 'waiting',
                'effectivePriority': 1.0,
              },
            ],
            'children': [
              {
                'id': 'child',
                'ownerId': 'coder',
                'title': child.heading,
                'status': 'ready',
                'effectivePriority': 1.0,
              },
            ],
            'blockedBy': [
              {
                'id': 'dependency',
                'ownerId': 'steward',
                'title': dep.heading,
                'status': 'ready',
                'effectivePriority': 1.0,
              },
            ],
            'blockedByTotal': 1,
            'externalReference': {
              'ref': 'github:example-org/example/issues/398',
              'scheme': 'github',
              'title': 'Issue #398 · Export run history as CSV',
              'url': 'https://github.com/example-org/example/issues/398',
            },
            'artifacts': [
              {
                'ref': 'github:example-org/example/pulls/431',
                'label': 'Carries the actor-page button',
                'attachedBy': 'coder',
                'reference': {
                  'ref': 'github:example-org/example/pulls/431',
                  'scheme': 'github',
                  'title': 'Pull request #431',
                  'url': 'https://github.com/example-org/example/pull/431',
                },
              },
            ],
            'history': [
              {
                'id': 3,
                'mutationKind': 'checkpoint',
                'actingPrincipal': 'coder',
                'timestamp': '2026-10-03T12:00:00.000Z',
                'before': {},
                'after': {'checkpoint': ob.checkpoint},
              },
              {
                'id': 2,
                'mutationKind': 'current_child_created',
                'actingPrincipal': 'coder',
                'timestamp': '2026-10-03T11:00:00.000Z',
                'before': {},
                'after': {
                  'child': {
                    'id': 'child',
                    'title': child.heading,
                    'ownerId': 'coder',
                  },
                },
              },
              {
                'id': 1,
                'mutationKind': 'reassign',
                'actingPrincipal': 'steward',
                'timestamp': '2026-10-02T11:00:00.000Z',
                'before': {'ownerId': 'steward'},
                'after': {'ownerId': 'coder'},
              },
            ],
          });
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        store.setFocusedObligationId('export');
        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            theme: buildMeshTheme(),
            home: RepaintBoundary(
              key: key,
              child: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await settleImages(tester, portraitUrls(ids));
        const phase = String.fromEnvironment(
          'DETAIL_PHASE',
          defaultValue: 'after',
        );
        final width = size.width > 1000 ? 'wide' : 'narrow';
        await captureBoundary(
          key,
          'screenshots/obligation_detail_864_${phase}_$width.png',
        );
        if (phase == 'after' && width == 'narrow') {
          await tester.ensureVisible(find.text('HISTORY'));
          await tester.pump();
          await captureBoundary(
            key,
            'screenshots/obligation_detail_864_after_narrow_history.png',
          );
        }
        expect(tester.takeException(), isNull);
      });
    });
  }

  testWidgets('obligation detail done wide', (tester) async {
    await tester.runAsync(() async {
      final ids = ['coder', 'steward'];
      HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
      addTearDown(() => HttpOverrides.global = null);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(const Size(1600, 1000));
      final ob = makeObligation(
        'export',
        ownerId: 'coder',
        creatorId: 'steward',
        title: 'Export run history as CSV',
        intent:
            'An operator can download an actor’s run history as a CSV from the actor page, with one row per run: start, end, model, exit status and token totals. The export respects the current filters and streams, so a year of runs downloads without freezing the page.',
        status: 'done',
        checkpoint:
            'Pull request is green. Download button added to the actor page; export honours the status and date filters. Two reviews requested. Next: answer review questions, then merge.',
        checkpointBy: 'coder',
        checkpointAt: '2026-10-03T12:00:00.000Z',
        externalRef: 'github:example-org/example/issues/398',
      );
      final root = makeObligation(
        'dashboard',
        ownerId: 'steward',
        intent: 'Dashboard',
        status: 'waiting',
      );
      final child = makeObligation(
        'child',
        ownerId: 'coder',
        intent: 'Land the export endpoint',
        parentId: 'export',
        status: 'done',
      );
      final dep = makeObligation(
        'dependency',
        ownerId: 'steward',
        intent: 'Paginate the runs API',
        status: 'done',
      );
      final api = FakeApi()
        ..threadsResult = [makeThread('coder'), makeThread('steward')]
        ..obligationsResult = [ob, root, child]
        ..obligationDetails['export'] = ObligationDetailSnapshot.fromJson({
          'obligation': {
            'id': 'export',
            'ownerId': 'coder',
            'creatorId': 'steward',
            'title': ob.heading,
            'intent': ob.body,
            'status': 'done',
            'effectivePriority': 1.0,
            'checkpoint': ob.checkpoint,
            'checkpointAt': ob.checkpointAt,
            'checkpointBy': 'coder',
            'externalRef': 'github:example-org/example/issues/398',
          },
          'ancestors': [
            {
              'id': 'dashboard',
              'ownerId': 'steward',
              'title': 'Dashboard',
              'status': 'waiting',
              'effectivePriority': 1.0,
            },
          ],
          'children': [
            {
              'id': 'child',
              'ownerId': 'coder',
              'title': child.heading,
              'status': 'done',
              'effectivePriority': 1.0,
            },
          ],
          'blockedBy': [
            {
              'id': 'dependency',
              'ownerId': 'steward',
              'title': dep.heading,
              'status': 'done',
              'effectivePriority': 1.0,
            },
          ],
          'blockedByTotal': 1,
          'externalReference': {
            'ref': 'github:example-org/example/issues/398',
            'scheme': 'github',
            'title': 'Issue #398 · Export run history as CSV',
            'url': 'https://github.com/example-org/example/issues/398',
          },
          'artifacts': [
            {
              'ref': 'github:example-org/example/pulls/431',
              'label': 'Carries the actor-page button',
              'attachedBy': 'coder',
              'reference': {
                'ref': 'github:example-org/example/pulls/431',
                'scheme': 'github',
                'title': 'Pull request #431',
                'url': 'https://github.com/example-org/example/pull/431',
              },
            },
          ],
          'history': [
            {
              'id': 4,
              'mutationKind': 'status',
              'actingPrincipal': 'coder',
              'timestamp': '2026-10-03T13:00:00.000Z',
              'before': {'status': 'ready'},
              'after': {'status': 'done'},
            },
            {
              'id': 3,
              'mutationKind': 'checkpoint',
              'actingPrincipal': 'coder',
              'timestamp': '2026-10-03T12:00:00.000Z',
              'before': {},
              'after': {'checkpoint': ob.checkpoint},
            },
          ],
        });
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      store.setFocusedObligationId('export');
      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          theme: buildMeshTheme(),
          home: RepaintBoundary(
            key: key,
            child: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await settleImages(tester, portraitUrls(ids));
      await captureBoundary(
        key,
        'screenshots/obligation_detail_864_after_done_wide.png',
      );
      expect(tester.takeException(), isNull);
    });
  });
}
