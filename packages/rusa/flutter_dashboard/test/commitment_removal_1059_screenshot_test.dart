// Review captures for #1059 using the real IU Reports widget. Fixtures are
// renderer outputs from the same synthetic journal before/after the removal.
// The before fixture injects a synthetic "supports" verdict; no API is called.
// Run: flutter test test/commitment_removal_1059_screenshot_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/iu/iu_reports_view.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

class _ReportsApi extends DashboardApi {
  _ReportsApi(this.fixture);
  final Map<String, dynamic> fixture;

  @override
  Future<Map<String, dynamic>> fetchIuReports() async =>
      fixture['index'] as Map<String, dynamic>;

  @override
  Future<Map<String, dynamic>> fetchIuReportContent(String runId) async => {
    'markdown': fixture['markdown'],
  };
}

void main() {
  setUpAll(loadFonts);

  testWidgets('captures report content before and after polarity removal', (
    tester,
  ) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(const Size(1200, 900));

      for (final name in ['before', 'after']) {
        final fixture =
            jsonDecode(
                  File(
                    'test/fixtures/commitment-removal-1059/$name.json',
                  ).readAsStringSync(),
                )
                as Map<String, dynamic>;
        final store = DashboardStore(
          api: _ReportsApi(fixture),
          stream: FakeStream(),
        );
        addTearDown(store.dispose);
        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: Scaffold(
              backgroundColor: MeshColors.bgPrimary,
              body: RepaintBoundary(
                key: key,
                child: ColoredBox(
                  color: MeshColors.bgPrimary,
                  child: IuReportsBody(store: store),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.tap(find.text('2026-10-14'));
        await tester.pump();
        await tester.pump();
        expect(
          find.textContaining('Use a two-second retry delay.'),
          findsWidgets,
        );
        expect(
          find.text('Commitment claims (polarity check)'),
          name == 'before' ? findsOneWidget : findsNothing,
        );
        await captureBoundary(
          key,
          'screenshots/commitment_removal_1059_$name.png',
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    });
  });
}
