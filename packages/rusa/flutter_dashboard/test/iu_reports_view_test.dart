import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/iu/iu_reports_view.dart';
import 'package:rusa_dashboard/iu/simple_markdown.dart';
import 'package:rusa_dashboard/store.dart';

import 'fakes.dart';

class FakeDashboardApi extends DashboardApi {
  FakeDashboardApi(this.indexResponse, this.reports);

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

DashboardStore _makeStore(FakeDashboardApi api) {
  return DashboardStore(api: api, stream: FakeStream());
}

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 800, height: 600, child: child)),
);

void main() {
  testWidgets('renders empty state correctly', (tester) async {
    final api = FakeDashboardApi({'v': 1, 'runs': []}, {});
    final store = _makeStore(api);
    await tester.pumpWidget(_host(IuReportsBody(store: store)));
    await tester.pump(); // Run FutureBuilder

    expect(find.text('No reports generated yet.'), findsOneWidget);
  });

  testWidgets('renders list of runs and opens detail split on tap', (
    tester,
  ) async {
    final runs = [
      {
        'run_id': 'run1',
        'date': '2026-07-14',
        'status': 'complete',
        'counts': {'decisions': 1},
      },
      {'run_id': 'run2', 'date': '2026-07-13', 'status': 'failed'},
    ];
    final api = FakeDashboardApi(
      {'v': 1, 'runs': runs},
      {'run1': '# Content for Run 1'},
    );
    final store = _makeStore(api);
    await tester.pumpWidget(_host(IuReportsBody(store: store)));
    await tester.pump(); // Run FutureBuilder

    // The list should show both dates
    expect(find.textContaining('2026-07-14'), findsWidgets);
    expect(find.textContaining('2026-07-13'), findsWidgets);
    expect(find.textContaining('Counts: 1 categories'), findsOneWidget);
    expect(find.textContaining('Counts: 0 categories'), findsOneWidget);

    // SimpleMarkdown shouldn't be present yet
    expect(find.byType(SimpleMarkdown), findsNothing);

    // Tap the first run
    await tester.tap(find.textContaining('2026-07-14').first);
    await tester.pump(); // Rebuild state
    await tester.pump(); // Run Markdown future

    // Now SimpleMarkdown should render the report content
    expect(find.byType(SimpleMarkdown), findsOneWidget);
    expect(find.textContaining('Content for Run 1'), findsWidgets);

    // Tap close button
    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();

    // SimpleMarkdown should be gone
    expect(find.byType(SimpleMarkdown), findsNothing);
  });

  testWidgets('renders unsupported version', (tester) async {
    final api = FakeDashboardApi({
      'v': 2,
      'runs': [],
      'unsupportedVersion': true,
    }, {});
    final store = _makeStore(api);
    await tester.pumpWidget(_host(IuReportsBody(store: store)));
    await tester.pump();

    expect(find.textContaining('Unsupported index version.'), findsOneWidget);
  });
}
