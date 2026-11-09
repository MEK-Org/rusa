// Rendered review artifacts for the empty-mesh first-actor bootstrap (#1260).
// Run with:
//
//   flutter test test/first_actor_bootstrap_1260_screenshot_test.dart
//
// It writes `flutter_dashboard/screenshots/1260_first_actor_modal_<viewport>.png`
// and `1260_first_actor_created_<viewport>.png` for a wide (1360x840) and a
// phone (390x844) viewport. The captures render the real DashboardBody on a
// FakeApi empty store: the first frames show the shared spawn dialog offered
// as the first-actor modal over the freshly loaded dashboard; the later frames
// show the dashboard right after the dialog's Create went through the ordinary
// spawn path, with the new actor selected and no modal.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/dashboard_url.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _viewports = {'wide': Size(1360, 840), 'phone': Size(390, 844)};

void main() {
  setUpAll(loadFonts);

  for (final MapEntry(key: viewport, value: size) in _viewports.entries) {
    testWidgets('first-actor bootstrap $viewport', (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(size);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        // Land on the actor list directly: it is the view whose empty state
        // the modal interrupts, and the view the operator sees right after
        // the create (spawnRootChild selects the new actor).
        debugDashboardUrl = '/actors';

        const spawnedId = 'spawned-child';
        HttpOverrides.global = FakeImageHttpOverrides(
          await portraits([spawnedId]),
        );
        addTearDown(() => HttpOverrides.global = null);

        final api = FakeApi()
          ..rootControlProviders = ['agy', 'codex']
          ..charters[spawnedId] = 'Bootstraps the mesh';
        final store = DashboardStore(api: api, stream: FakeStream());
        addTearDown(store.dispose);
        await store.init();

        // The boundary wraps the whole app so the capture includes the
        // dialog's Overlay, not just the page beneath it.
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: MediaQuery(
                data: MediaQueryData(size: size),
                child: Scaffold(
                  backgroundColor: MeshColors.bgPrimary,
                  body: DashboardBody(
                    store: store,
                    understandingBuilder: (_) => const SizedBox(),
                    reportsBuilder: (_) => const SizedBox(),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump(const Duration(milliseconds: 100));

        // Empty mesh: the first-actor modal is up over the dashboard.
        expect(find.text('Create your first actor'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await captureBoundary(
          boundaryKey,
          '$_outDir/1260_first_actor_modal_$viewport.png',
        );

        // Close the modal as the real submit does (the submit flow itself is
        // covered in first_actor_bootstrap_1260_test.dart against this same
        // harness), then put the store into exactly the state that flow
        // leaves — the created actor present and selected, no modal — by
        // feeding the created thread through the ordinary refresh path.
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.text('Create your first actor'), findsNothing);

        api.threadsResult = [
          makeThread(
            spawnedId,
            title: 'Bootstrapper',
            charterPreview: 'Bootstraps the mesh',
            runState: RunState.idle,
          ),
        ];
        await store.refreshThreads();
        store.clickActor(spawnedId);
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump(const Duration(milliseconds: 100));

        expect(find.text('Create your first actor'), findsNothing);
        await tester.pump(const Duration(milliseconds: 100));
        await settleImages(tester, portraitUrls([spawnedId]));

        expect(find.text('spawned-child-handle'), findsWidgets);
        expect(find.text('Create your first actor'), findsNothing);
        expect(tester.takeException(), isNull);
        await captureBoundary(
          boundaryKey,
          '$_outDir/1260_first_actor_created_$viewport.png',
        );
      });
    });
  }
}
