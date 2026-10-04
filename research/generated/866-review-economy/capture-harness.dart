import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
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
    if (unavailable) throw Exception('synthetic server failure');
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
  final states = ['failed'];
  for (final viewport in {
    'wide': const Size(1180, 820),
    'narrow': const Size(390, 844),
  }.entries) {
    for (final state in states) {
      testWidgets('run prompt ${viewport.key} $state', (tester) async {
        final api = _PromptApi(true)
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
            home: RepaintBoundary(
              key: key,
              child: Scaffold(body: EventsTab(store: store)),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(api.promptCalls, 0);
        if (state == 'failed') {
          await tester.tap(find.text('Run prompt'));
          await tester.pumpAndSettle();
          expect(api.promptCalls, 1);
        }
        expect(find.text('Kind filter:'), findsOneWidget);
        expect(find.text('All Events'), findsOneWidget);
        expect(find.text('run_start'), findsOneWidget);
        expect(find.textContaining('resolved model: fixture-model'), findsOneWidget);
        expect(find.text('2026-01-01 00:00:00'), findsOneWidget);
        expect(find.text('Run prompt'), findsOneWidget);
        expect(find.text(before ? 'Could not load prompt. Retry' : 'Could not load prompt'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        void repaint(RenderObject object) {
          object.visitChildren(repaint);
          object.markNeedsPaint();
        }
        repaint(boundary);
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pumpAndSettle();
        void rebuildScene(Layer layer) {
          if (layer is ContainerLayer) {
            for (Layer? child = layer.firstChild; child != null; child = child.nextSibling) {
              rebuildScene(child);
            }
          }
          layer.engineLayer = null;
          if (!layer.alwaysNeedsAddToScene) layer.markNeedsAddToScene();
        }
        rebuildScene(boundary.layer!);
        final outDir = Platform.environment['RUSA_866_SCREENSHOTS'];
        if (outDir != null) {
          await tester.runAsync(
            () async {
              final image = boundary.toImageSync(pixelRatio: 2.0);
              final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
              final file = File('$outDir/${viewport.key}-${before ? 'before' : 'after'}.png')..createSync(recursive: true);
              file.writeAsBytesSync(bytes);
              image.dispose();
            },
          );
        }
      });
    }
  }
}
