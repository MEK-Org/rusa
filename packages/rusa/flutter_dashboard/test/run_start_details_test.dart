import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/widgets/event_disclosure.dart';
import 'package:rusa_dashboard/widgets/run_start_details.dart';

final _open = find.byTooltip('Show run details');
final _close = find.byTooltip('Hide run details');

Widget _row(DashboardApi api, {String? runId = 'run-fixture', Key? key}) =>
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: EventDisclosure(
            key: key,
            label: 'run details',
            header: (toggle) =>
                Row(children: [const Text('run_start'), toggle]),
            content: (_) =>
                RunStartDetails(runId: runId, model: 'fixture-model', api: api),
          ),
        ),
      ),
    );

String? _selectable(WidgetTester tester) {
  final found = find.byType(SelectableText);
  return found.evaluate().isEmpty
      ? null
      : tester.widget<SelectableText>(found).data;
}

void main() {
  testWidgets(
    'fetches only on expansion, under the resolved model, and again on reopen',
    (tester) async {
      var requests = 0;
      final api = DashboardApi(
        base: Uri.parse('https://fixture.invalid'),
        client: MockClient((request) async {
          requests++;
          expect(request.url.path, '/api/mesh/runs/run-fixture/prompt');
          return http.Response(
            jsonEncode({
              'prompt': requests == 1
                  ? 'Fixture charter\nFixture task'
                  : 'Updated fixture',
              'provider': 'antigravity',
            }),
            200,
          );
        }),
      );
      await tester.pumpWidget(_row(api));
      expect(requests, 0);
      expect(find.textContaining('Resolved Model'), findsNothing);
      expect(find.text('Prompt:'), findsNothing);

      await tester.tap(_open);
      await tester.pumpAndSettle();
      expect(requests, 1);
      expect(find.text('Resolved Model: fixture-model'), findsOneWidget);
      expect(find.text('Prompt:'), findsOneWidget);
      expect(_selectable(tester), 'Fixture charter\nFixture task');
      expect(find.textContaining('antigravity'), findsNothing);

      await tester.tap(_close);
      await tester.pumpAndSettle();
      expect(find.textContaining('Resolved Model'), findsNothing);
      expect(_selectable(tester), isNull);

      await tester.tap(_open);
      await tester.pumpAndSettle();
      expect(requests, 2);
      expect(_selectable(tester), 'Updated fixture');
    },
  );

  testWidgets('reopening replaces expired text with the missing-row response', (
    tester,
  ) async {
    var expired = false;
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient(
        (_) async => expired
            ? http.Response('{}', 404)
            : http.Response(
                jsonEncode({
                  'prompt': 'Synthetic retained text',
                  'provider': 'claude',
                }),
                200,
              ),
      ),
    );
    await tester.pumpWidget(_row(api));
    await tester.tap(_open);
    await tester.pumpAndSettle();
    expect(_selectable(tester), 'Synthetic retained text');
    await tester.tap(_close);
    await tester.pumpAndSettle();
    expired = true;
    await tester.tap(_open);
    await tester.pumpAndSettle();
    expect(_selectable(tester), isNull);
    expect(find.text('Prompt unavailable'), findsOneWidget);
  });

  testWidgets('server errors show the failure line and retry on reopen', (
    tester,
  ) async {
    var status = 500;
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient((_) async => http.Response('{}', status)),
    );
    await tester.pumpWidget(_row(api));
    await tester.tap(_open);
    await tester.pumpAndSettle();
    expect(find.text('Could not load prompt'), findsOneWidget);
    expect(find.text('Resolved Model: fixture-model'), findsOneWidget);
    status = 404;
    await tester.tap(_close);
    await tester.pump();
    await tester.tap(_open);
    await tester.pumpAndSettle();
    expect(find.text('Prompt unavailable'), findsOneWidget);
  });

  testWidgets('a row without a run id requests nothing and says unavailable', (
    tester,
  ) async {
    var requests = 0;
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient((_) async {
        requests++;
        return http.Response('{}', 200);
      }),
    );
    await tester.pumpWidget(_row(api, runId: null));
    await tester.tap(_open);
    await tester.pumpAndSettle();
    expect(requests, 0);
    expect(find.text('Resolved Model: fixture-model'), findsOneWidget);
    expect(find.text('Prompt unavailable'), findsOneWidget);
  });

  testWidgets('clamps a long prompt to 12 lines behind Show more / Show less', (
    tester,
  ) async {
    final prompt = [for (var i = 1; i <= 30; i++) 'line $i'].join('\n');
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient(
        (_) async => http.Response(jsonEncode({'prompt': prompt}), 200),
      ),
    );
    await tester.pumpWidget(_row(api));
    await tester.tap(_open);
    await tester.pumpAndSettle();
    final clamped = tester.widget<Text>(find.text(prompt));
    expect(clamped.maxLines, 12);
    expect(_selectable(tester), isNull);

    await tester.tap(find.text('Show more'));
    await tester.pumpAndSettle();
    expect(_selectable(tester), prompt);
    await tester.ensureVisible(find.text('Show less'));
    await tester.tap(find.text('Show less'));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.text(prompt)).maxLines, 12);
  });

  testWidgets('a short prompt is selectable with no Show more', (tester) async {
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient(
        (_) async => http.Response(jsonEncode({'prompt': 'Short'}), 200),
      ),
    );
    await tester.pumpWidget(_row(api));
    await tester.tap(_open);
    await tester.pumpAndSettle();
    expect(_selectable(tester), 'Short');
    expect(find.text('Show more'), findsNothing);
  });
}
