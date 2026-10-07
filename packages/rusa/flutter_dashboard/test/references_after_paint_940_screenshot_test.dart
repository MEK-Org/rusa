// Real WorkTab and OverviewTab screenshots with synthetic data only (#940):
// each pane as it first paints, its references still loading, and once
// `/api/mesh/references` has filled them in. The committed *_staging_before
// captures were generated from origin/staging fdbbb89f with this same fixture,
// so the PR presents an actual baseline alongside the new states.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

const _issue = 'github:example-org/example/issues/398';
const _pull = 'github:example-org/example/pulls/431';

final _references = {
  _issue: const ReferenceDto(
    ref: _issue,
    scheme: 'github',
    title: 'Issue #398 · Export run history as CSV',
    url: 'https://github.com/example-org/example/issues/398',
    cacheState: 'fresh',
  ),
  _pull: const ReferenceDto(
    ref: _pull,
    scheme: 'github',
    title: 'Pull request #431',
    url: 'https://github.com/example-org/example/pull/431',
    cacheState: 'fresh',
  ),
};

Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump();
  }
}

Future<void> _settle(WidgetTester tester, List<String> ids) async {
  await _frames(tester);
  await settleImages(tester, portraitUrls(ids));
}

void main() {
  setUpAll(loadFonts);

  testWidgets('obligation detail before and after its references', (
    tester,
  ) async {
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
            'An operator can download an actor’s run history as a CSV from the actor page.',
        checkpoint: 'Pull request is green. Next: answer review questions.',
        checkpointBy: 'coder',
        externalRef: _issue,
      );
      final gate = Completer<void>();
      final api = FakeApi()
        ..threadsResult = [makeThread('coder'), makeThread('steward')]
        ..obligationsResult = [ob]
        ..obligationDetails['export'] = ObligationDetailSnapshot(
          obligation: ob,
          children: const [],
          blockingChildren: const [],
          artifacts: const [
            ObligationArtifactDto(
              ref: _pull,
              label: 'Carries the actor-page button',
              attachedBy: 'coder',
            ),
          ],
        )
        ..referencesGate = gate
        ..referencesResult = _references;
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
      await _settle(tester, ids);
      expect(find.text('loading context'), findsNWidgets(2));
      await captureBoundary(
        key,
        'screenshots/references_940_detail_first_paint.png',
      );

      gate.complete();
      await _frames(tester);
      expect(find.text('loading context'), findsNothing);
      await captureBoundary(key, 'screenshots/references_940_detail_filled.png');
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets('Recent Activity before and after its references', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ids = ['coder', 'steward'];
      HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
      addTearDown(() => HttpOverrides.global = null);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(const Size(1500, 1000));
      final gate = Completer<void>();
      final api = FakeApi()
        ..threadsResult = [
          makeThread(
            'coder',
            modelConfig: const [
              ProviderModelConfig(
                provider: 'claude',
                model: 'claude-opus-4-6',
                effort: 'high',
              ),
            ],
          ),
          makeThread('steward'),
        ]
        ..recentActivityResult = const [
          RecentActivityItem(
            id: 'inbox_2',
            kind: 'handled_inbox',
            time: '2026-10-03T12:10:00.000Z',
            actorId: 'coder',
            sourceKind: 'GITHUB PR',
            sourceRef: _pull,
            referenceKey: _pull,
            summary: 'pull_request_review.submitted',
            handledTime: '2026-10-03T12:10:00.000Z',
            addressedNote: 'Answered both review questions',
          ),
          RecentActivityItem(
            id: 'inbox_1',
            kind: 'handled_inbox',
            time: '2026-10-03T11:00:00.000Z',
            actorId: 'steward',
            sourceKind: 'GITHUB ISSUE',
            sourceRef: _issue,
            referenceKey: _issue,
            summary: 'issues.opened',
            handledTime: '2026-10-03T11:00:00.000Z',
            addressedNote: 'Assigned the export to coder',
          ),
        ]
        ..referencesGate = gate
        ..referencesResult = _references;
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          theme: buildMeshTheme(),
          home: RepaintBoundary(
            key: key,
            child: Scaffold(body: OverviewTab(store: store)),
          ),
        ),
      );
      await _settle(tester, ids);
      await tester.ensureVisible(find.text('Recent Activity'));
      await _settle(tester, ids);
      // A card shows no body, so a loading reference reads as its kind alone.
      expect(find.text('Pull request #431'), findsNothing);
      await captureBoundary(
        key,
        'screenshots/references_940_activity_first_paint.png',
      );

      gate.complete();
      await Future<void>.delayed(Duration.zero);
      await _frames(tester);
      expect(find.text('Pull request #431'), findsOneWidget);
      await captureBoundary(
        key,
        'screenshots/references_940_activity_filled.png',
      );
      expect(tester.takeException(), isNull);
    });
  });
}
