// Screenshot harness for #874's run_start disclosure on synthetic fixtures.
// Run:
//
//   flutter test test/run_start_screenshot_test.dart
//
// It writes `screenshots/874_run_start_<viewport>_<state>.png`. The collapsed
// scene needs no interaction, so the same file run against staging with
// `--dart-define=SHOT_SUFFIX=before` writes the matching `_collapsed_before`
// images; the other states exist only once the chevron does.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/events_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment('SHOT_SUFFIX');

const _prompt =
    '# Worker actor\n\n'
    'You are a worker in a synthetic mesh. Your parent assigns one task at a '
    'time and expects a short report when it is done.\n\n'
    '## Your charter\n\n'
    'Repair the sample test fixture and report the observed result.\n\n'
    '## Command discipline\n\n'
    'Keep each command inside the synthetic workspace.\n'
    'Run the focused tests before reporting.\n'
    'Never push to the default branch.\n\n'
    '## Task\n\n'
    'The fixture parser drops the last line of a file with no trailing '
    'newline. Fix it and add a test.\n';

class _PromptApi extends FakeApi {
  _PromptApi(this.state);
  final String state;

  @override
  Future<Map<String, dynamic>?> fetchRunPrompt(String runId) async {
    if (state == 'failed') throw Exception('synthetic server failure');
    if (state == 'unavailable') return null;
    return {'prompt': _prompt, 'provider': 'claude'};
  }
}

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 820)), ('phone', Size(390, 844))];
  final states = _suffix == 'before'
      ? ['collapsed']
      : ['collapsed', 'expanded', 'unavailable', 'failed'];

  for (final (viewport, size) in sizes) {
    for (final state in states) {
      testWidgets('run_start $viewport $state', (tester) async {
        await tester.runAsync(() async {
          final api = _PromptApi(state)
            ..threadsResult = [makeThread('fixture-actor')]
            ..eventPages = [
              EventPage(
                events: [
                  makeEvent(
                    'fixture-sent',
                    'message_sent',
                    actor: 'fixture-actor',
                    detail: 'Fixed the parser; focused tests pass.',
                  ),
                  makeEvent(
                    'fixture-start',
                    'run_start',
                    actor: 'fixture-actor',
                    payload:
                        '{"runId":"fixture-run","provider":"claude",'
                        '"model":"claude-opus-5-5"}',
                  ),
                  makeEvent(
                    'fixture-received',
                    'message_received',
                    actor: 'fixture-actor',
                    detail: 'Please repair the fixture parser.',
                  ),
                ],
                nextCursor: null,
              ),
            ];
          final store = DashboardStore(api: api, stream: FakeStream());
          addTearDown(store.dispose);
          await store.refreshThreads();
          store.clickActor('fixture-actor');
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
                child: Scaffold(body: EventsTab(store: store)),
              ),
            ),
          );
          for (var i = 0; i < 5; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }
          if (state != 'collapsed') {
            await tester.tap(find.byTooltip('Show run details'));
            for (var i = 0; i < 5; i++) {
              await tester.pump(const Duration(milliseconds: 50));
            }
            expect(
              find.text('Resolved Model: claude-opus-5-5'),
              findsOneWidget,
            );
            expect(
              find.text(switch (state) {
                'unavailable' => 'Prompt unavailable',
                'failed' => 'Could not load prompt',
                _ => 'Show more',
              }),
              findsOneWidget,
            );
          }
          expect(tester.takeException(), isNull);
          final name = _suffix.isEmpty ? state : '${state}_$_suffix';
          await captureBoundary(
            key,
            '$_outDir/874_run_start_${viewport}_$name.png',
          );
        });
      });
    }
  }
}
