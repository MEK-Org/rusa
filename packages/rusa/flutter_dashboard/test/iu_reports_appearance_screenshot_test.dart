// Rendered review artifacts for #840 / #845 IU Reports appearance pass. Run with:
//
//   flutter test test/iu_reports_appearance_screenshot_test.dart
//
// It captures before-and-after screenshots of the zero-space chat coverage
// sentence in the IU Reports view:
//   - flutter_dashboard/screenshots/iu_reports_zero_space_before.png
//   - flutter_dashboard/screenshots/iu_reports_zero_space_after.png

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/iu/iu_reports_view.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

class FakeReportsApi extends DashboardApi {
  FakeReportsApi(this.indexResponse, this.reports);

  final Map<String, dynamic> indexResponse;
  final Map<String, String> reports;

  @override
  Future<Map<String, dynamic>> fetchIuReports() async => indexResponse;

  @override
  Future<Map<String, dynamic>> fetchIuReportContent(String runId) async {
    final md = reports[runId];
    if (md == null) return {'error': 'not found'};
    return {'markdown': md};
  }
}

DashboardStore _makeStore(FakeReportsApi api) {
  return DashboardStore(api: api, stream: FakeStream());
}

Widget _host(Widget child, GlobalKey key) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: buildMeshTheme(),
      home: Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: RepaintBoundary(
          key: key,
          child: ColoredBox(
            color: MeshColors.bgPrimary,
            child: SizedBox(
              width: 1000,
              height: 650,
              child: child,
            ),
          ),
        ),
      ),
    );

void main() {
  setUpAll(loadFonts);

  const beforeMarkdown = '''# Integrated Understanding Report: 2026-10-02-01

Date: 2026-10-02
Run ID: 2026-10-02-01
Status: complete

## Deliberately left out
_Nothing skipped this run._

## Run summary
- Decisions: 1 (distilled 1 · adjudicated_away 0 · skipped 0 · deferred 0)
- Nodes touched: 1 · node ops: 1 · IU-hints: 0
- IU-hint coverage: complete (scanned 12)
- Chat coverage: **chat was not in this run's read set** (0 spaces in membership). Anything decided only in chat is invisible to this run — see ISSUE_NUM.
- Cursor advanced: yes → 2026-10-02T08:00:00Z
''';

  const afterMarkdown = '''# Integrated Understanding Report: 2026-10-02-01

Date: 2026-10-02
Run ID: 2026-10-02-01
Status: complete

## Deliberately left out
_Nothing skipped this run._

## Run summary
- Decisions: 1 (distilled 1 · adjudicated_away 0 · skipped 0 · deferred 0)
- Nodes touched: 1 · node ops: 1 · IU-hints: 0
- IU-hint coverage: complete (scanned 12)
- Chat coverage: **chat was not in this run's read set** (0 spaces in membership). Anything decided only in chat is invisible to this run.
- Cursor advanced: yes → 2026-10-02T08:00:00Z
''';

  testWidgets('captures IU Reports zero-space before and after screenshots', (
    tester,
  ) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(const Size(1000, 650));

      final runs = [
        {
          'run_id': '2026-10-02-01',
          'date': '2026-10-02',
          'status': 'complete',
          'counts': {'decisions': 1},
        },
      ];

      // ── Capture Before ──
      {
        final apiBefore = FakeReportsApi(
          {'v': 1, 'runs': runs},
          {'2026-10-02-01': beforeMarkdown},
        );
        final storeBefore = _makeStore(apiBefore);
        addTearDown(storeBefore.dispose);

        final keyBefore = GlobalKey();
        await tester.pumpWidget(_host(IuReportsBody(store: storeBefore), keyBefore));
        await tester.pump();
        await tester.pump();

        // Tap the run to open detail
        await tester.tap(find.textContaining('2026-10-02').first);
        await tester.pump();
        await tester.pump();

        expect(find.textContaining('see ISSUE_NUM'), findsOneWidget);
        await captureBoundary(keyBefore, '$_outDir/iu_reports_zero_space_before.png');
      }

      // ── Capture After ──
      {
        final apiAfter = FakeReportsApi(
          {'v': 1, 'runs': runs},
          {'2026-10-02-01': afterMarkdown},
        );
        final storeAfter = _makeStore(apiAfter);
        addTearDown(storeAfter.dispose);

        final keyAfter = GlobalKey();
        await tester.pumpWidget(_host(IuReportsBody(store: storeAfter), keyAfter));
        await tester.pump();
        await tester.pump();

        // Tap the run to open detail
        await tester.tap(find.textContaining('2026-10-02').first);
        await tester.pump();
        await tester.pump();

        expect(find.textContaining('Anything decided only in chat is invisible to this run.'), findsOneWidget);
        expect(find.textContaining('see ISSUE_NUM'), findsNothing);
        await captureBoundary(keyAfter, '$_outDir/iu_reports_zero_space_after.png');
      }
    });
  });
}
