import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/events_tab.dart';
import 'fakes.dart';
import 'screenshot_support.dart';

class _PromptApi extends FakeApi {
  _PromptApi(this.unavailable);
  final bool unavailable;
  int promptCalls = 0;
  // This harness also runs unchanged against the pre-feature source tree.
  @override
  Future<Map<String, dynamic>?> fetchRunPrompt(String runId) async {
    promptCalls++;
    if (unavailable) return null;
    return {
      'provider': 'antigravity',
      'truncated': true,
      'promptBytes': 300000,
      'prompt':
          '# Worker actor\n\nYou are a worker in a synthetic mesh.\n\n'
          '## Your charter\n\nRepair the sample test fixture and report the observed result.\n\n'
          '## Antigravity command discipline\n\nKeep each command within the synthetic workspace.\n',
    };
  }
}

void main() {
  setUpAll(loadFonts);
  final before = Platform.environment['RUSA_866_CAPTURE_SOURCE'] == 'before';
  final states = before ? ['before'] : ['collapsed', 'expanded', 'unavailable'];
  for (final viewport in {
    'wide': const Size(1180, 820),
    'narrow': const Size(390, 844),
  }.entries) {
    for (final state in states) {
      testWidgets('run prompt ${viewport.key} $state', (tester) async {
        final api = _PromptApi(state == 'unavailable')
          ..threadsResult = [makeThread('fixture-actor')]
          ..eventPages = [
            EventPage(
              events: [
                makeEvent(
                  'fixture-start',
                  'run_start',
                  actor: 'fixture-actor',
                  payload:
                      '{"runId":"fixture-run","provider":"antigravity","model":"fixture-model"}',
                ),
              ],
              nextCursor: null,
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        addTearDown(store.dispose);
        await store.refreshThreads();
        store.clickActor('fixture-actor');
        final key = GlobalKey();
        await tester.binding.setSurfaceSize(viewport.value);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: Scaffold(
              body: RepaintBoundary(
                key: key,
                child: EventsTab(store: store),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(api.promptCalls, 0);
        if (state == 'expanded' || state == 'unavailable') {
          await tester.tap(find.text('Run prompt'));
          await tester.pumpAndSettle();
          expect(api.promptCalls, 1);
        }
        expect(tester.takeException(), isNull);
        final outDir = Platform.environment['RUSA_866_SCREENSHOTS'];
        if (outDir != null) {
          await tester.runAsync(
            () => captureBoundary(key, '$outDir/${viewport.key}-$state.png'),
          );
        }
      });
    }
  }
}
