// Rendered review artifacts for #1277: the actor tree drops the NEEDS
// ATTENTION badge. Run with:
//
//   flutter test test/needs_attention_1277_screenshot_test.dart
//
// It writes `flutter_dashboard/screenshots/1277_needs_attention_tree_<viewport>_after.png`
// for the 320px desktop sidebar and a 390px phone viewport: a root with two workers, the first
// showing a model, effort and a work-state badge — the row that carried the
// badge when the server flagged it. The matching `_before.png` frames were
// rendered by this harness at staging 5a16b3c1 with that worker flagged; the
// flag no longer exists, so only `after` can be rendered now.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _rootId = 'harbor';
const _flaggedId = 'lantern';
const _peerId = 'meadow';
const _ids = [_rootId, _flaggedId, _peerId];
const _phase = 'after';

// The desktop sidebar's 320px tree column and a 390px phone, cropped to the rows.
const _viewports = {'sidebar': Size(320, 420), 'phone': Size(390, 420)};

void main() {
  setUpAll(loadFonts);

  for (final MapEntry(key: viewport, value: size) in _viewports.entries) {
    testWidgets('needs-attention row $viewport $_phase', (tester) async {
      await tester.runAsync(() async {
        HttpOverrides.global = FakeImageHttpOverrides(await portraits(_ids));
        addTearDown(() => HttpOverrides.global = null);
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        final api = FakeApi()
          ..threadsResult = [
            makeThread(
              _rootId,
              title: 'Coordinate the mesh',
              provider: 'claude',
              model: 'claude-opus-5-5',
              runState: RunState.idle,
            ),
            makeThread(
              _flaggedId,
              parent: _rootId,
              title: 'Repair the inbox listing query',
              provider: 'antigravity',
              model: 'Gemini 3.7 Flash',
              effort: 'high',
              commitmentKind: 'running',
              runState: RunState.idle,
            ),
            makeThread(
              _peerId,
              parent: _rootId,
              title: 'Review open pull requests',
              provider: 'codex',
              model: 'gpt-5.5',
              runState: RunState.idle,
            ),
          ];
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          walkie: FakeWalkie(api).deps,
        );
        await store.refreshThreads();
        addTearDown(store.dispose);

        final key = GlobalKey();
        final sidebar = viewport == 'sidebar';
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: Scaffold(
              backgroundColor: MeshColors.bgPrimary,
              body: RepaintBoundary(
                key: key,
                child: ActorTree(store: store, touchTargets: !sidebar),
              ),
            ),
          ),
        );
        await settleImages(tester, portraitUrls(_ids));
        expect(find.text('Repair the inbox listing query'), findsOneWidget);
        expect(find.text('NEEDS ATTENTION'), findsNothing);
        expect(tester.takeException(), isNull);
        await captureBoundary(
          key,
          '$_outDir/1277_needs_attention_tree_${viewport}_$_phase.png',
        );
      });
    });
  }
}
