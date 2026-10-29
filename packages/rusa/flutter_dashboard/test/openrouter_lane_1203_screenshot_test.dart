// Screenshot harness for #1203's queue lane label on synthetic fixtures.
// Run:
//
//   flutter test test/openrouter_lane_1203_screenshot_test.dart
//
// It writes `screenshots/1203_queue_lane_<viewport>_{before,after}.png`.
// #1203 changes no dashboard code; the lane is a server-supplied value. Before
// it, an OpenRouter actor's throttle lane came from its provider name
// (`openrouter`); after it, the lane comes from `cliCommand: pi`, as
// Antigravity's comes from `agy`. Each image renders the same widget with that
// lane value, for one unclaimed and one claimed queued OpenRouter actor.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

List<ThreadDto> _threads(String openrouterLane) => [
  makeThread('root', runState: RunState.idle),
  makeThread(
    'claimed',
    parent: 'root',
    runState: RunState.queued,
    queuePosition: 0,
    provider: 'openrouter',
    model: 'synthetic/model-a',
    admissionClaimed: true,
    compatibleLanes: [openrouterLane],
    claimedLane: openrouterLane,
  ),
  makeThread(
    'waiting',
    parent: 'root',
    runState: RunState.queued,
    queuePosition: 1,
    provider: 'openrouter',
    model: 'synthetic/model-a',
    compatibleLanes: [openrouterLane],
  ),
  makeThread(
    'antigravity',
    parent: 'root',
    runState: RunState.queued,
    queuePosition: 2,
    provider: 'antigravity',
    compatibleLanes: const ['agy'],
  ),
];

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 820)), ('phone', Size(390, 844))];
  const variants = [('before', 'openrouter'), ('after', 'pi')];

  for (final (viewport, size) in sizes) {
    for (final (variant, lane) in variants) {
      testWidgets('#1203 queue lane $viewport $variant', (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()..threadsResult = _threads(lane);
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);
          tester.view
            ..physicalSize = size
            ..devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          final key = GlobalKey();
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: RepaintBoundary(
                key: key,
                child: Scaffold(body: OverviewTab(store: store)),
              ),
            ),
          );
          for (var i = 0; i < 5; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }
          expect(find.text('Lane: $lane'), findsOneWidget);
          expect(
            find.text('Claimed · $lane, waiting for a run slot'),
            findsOneWidget,
          );
          expect(find.text('Lane: agy'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await captureBoundary(
            key,
            '$_outDir/1203_queue_lane_${viewport}_$variant.png',
          );
        });
      });
    }
  }
}
