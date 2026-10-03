import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/widgets/run_prompt_disclosure.dart';

void main() {
  testWidgets('fetches only on expansion and reuses the response on reopen', (
    tester,
  ) async {
    var requests = 0;
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient((request) async {
        requests++;
        expect(request.url.path, '/api/mesh/runs/run-fixture/prompt');
        return http.Response(
          jsonEncode({
            'prompt': 'Fixture charter\nFixture task',
            'provider': 'antigravity',
            'truncated': true,
            'promptBytes': 300000,
          }),
          200,
        );
      }),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RunPromptDisclosure(runId: 'run-fixture', api: api),
        ),
      ),
    );
    expect(requests, 0);
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(requests, 1);
    expect(find.byType(SelectableText), findsOneWidget);
    expect(
      find.text('Showing the first 256 KiB of 300000 bytes.'),
      findsOneWidget,
    );
    expect(find.text('Launched provider: antigravity'), findsOneWidget);
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(find.byType(SelectableText), findsNothing);
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(requests, 1);
  });

  testWidgets('404 renders unavailable, and server errors offer retry', (
    tester,
  ) async {
    var status = 404;
    final api = DashboardApi(
      base: Uri.parse('https://fixture.invalid'),
      client: MockClient((_) async => http.Response('{}', status)),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RunPromptDisclosure(
            key: const ValueKey('missing'),
            runId: 'missing',
            api: api,
          ),
        ),
      ),
    );
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(
      find.text('Prompt no longer retained or unavailable.'),
      findsOneWidget,
    );
    status = 500;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RunPromptDisclosure(
            key: const ValueKey('retry'),
            runId: 'retry',
            api: api,
          ),
        ),
      ),
    );
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(find.text('Could not load prompt. Retry'), findsOneWidget);
    status = 404;
    await tester.tap(find.text('Could not load prompt. Retry'));
    await tester.pumpAndSettle();
    expect(
      find.text('Prompt no longer retained or unavailable.'),
      findsOneWidget,
    );
  });
}
