// Screenshot harness for #1311: a Google Chat event routes at its thread
// (`gchat:spaces/S/threads/T`), but the dashboard labels a top-level message
// with its space (`gchat:spaces/S`). Replies retain their thread label. The
// fallback inbox and Recent Activity widgets receive their real routing source
// plus that presentation label. Both captures come from this one run. Run:
//
//   flutter test test/chat_thread_source_1311_screenshot_test.dart
//
// It writes `screenshots/1311_<surface>_<before|after>.png`.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/inbox_item_row.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

const _space = 'spaces/AAA';
const _at = '2026-11-12T12:00:00.000Z';

/// A top-level message (heading its own thread) and a reply in thread T1.
const _messages = [('M1', '$_space/threads/M1'), ('R2', '$_space/threads/T1')];

String _source(String thread, bool after) =>
    after ? 'gchat:$thread' : 'gchat:$_space';

String _displaySource(String message, String thread, bool after) =>
    after && message == 'M1' ? 'gchat:$_space' : _source(thread, after);

InboxEntryDto _entry(String message, String thread, bool after) =>
    InboxEntryDto(
      id: 'entry-$message',
      actorId: 'worker',
      source: _source(thread, after),
      deliveredAt: _at,
      payload: {
        'type': 'gchat.message',
        'spaceName': _space,
        'messageName': '$_space/messages/$message',
        'threadName': thread,
      },
      displaySource: _displaySource(message, thread, after),
      // The message itself could not be read, so no card renders.
      reference: const ReferenceDto(
        ref: 'gchat:$_space/messages/M',
        scheme: 'gchat',
        title: 'gchat:$_space/messages/M',
        unavailable: 'message unavailable',
      ),
    );

FakeApi _api(bool after) => FakeApi()
  ..threadsResult = [
    makeThread('root', runState: RunState.idle, title: 'Steward'),
    makeThread('worker', parent: 'root', runState: RunState.idle),
  ]
  ..recentActivityResult = [
    for (final (i, (message, thread)) in _messages.indexed)
      RecentActivityItem(
        id: 'inbox_$message',
        kind: 'handled_inbox',
        time: _at,
        actorId: 'worker',
        sourceKind: 'GCHAT',
        sourceRef: _displaySource(message, thread, after),
        summary: i == 0 ? 'A new top-level message' : 'A reply in a thread',
        handledTime: _at,
        addressedNote: 'Answered in the thread.',
      ),
  ];

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  setUpAll(loadFonts);

  for (final after in [false, true]) {
    final suffix = after ? 'after' : 'before';

    testWidgets('#1311 inbox fallback row $suffix', (tester) async {
      await tester.runAsync(() async {
        final store = DashboardStore(api: _api(after), stream: FakeStream());
        addTearDown(store.dispose);
        tester.view
          ..physicalSize = const Size(640, 260)
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        final entries = [for (final (m, t) in _messages) _entry(m, t, after)];
        expect(entries.any(InboxItemRow.rendersOwnFrame), isFalse);
        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: RepaintBoundary(
              key: key,
              child: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: Column(
                  children: [
                    for (final entry in entries)
                      InboxItemRow(entry: entry, store: store),
                  ],
                ),
              ),
            ),
          ),
        );
        await _settle(tester);
        for (final entry in entries) {
          expect(find.text(entry.displaySource ?? entry.source), findsWidgets);
        }
        await captureBoundary(key, '$_outDir/1311_inbox_row_$suffix.png');
      });
    });

    testWidgets('#1311 recent activity $suffix', (tester) async {
      await tester.runAsync(() async {
        final store = DashboardStore(api: _api(after), stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        await store.refreshRecentActivity(deferUntilPostFrame: false);
        tester.view
          ..physicalSize = const Size(900, 940)
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: RepaintBoundary(
              key: key,
              child: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: OverviewTab(store: store),
              ),
            ),
          ),
        );
        await _settle(tester);
        await tester.ensureVisible(find.text('Recent Activity'));
        await tester.pump(const Duration(milliseconds: 50));
        for (final (message, thread) in _messages) {
          expect(
            find.textContaining(_displaySource(message, thread, after)),
            findsWidgets,
          );
        }
        await captureBoundary(key, '$_outDir/1311_recent_activity_$suffix.png');
      });
    });
  }
}
