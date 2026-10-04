import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/widgets/run_prompt_disclosure.dart';

void main() {
  testWidgets(
    'fetches only on expansion and refreshes complete selectable text on reopen',
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
        tester.widget<SelectableText>(find.byType(SelectableText)).data,
        'Fixture charter\nFixture task',
      );
      expect(find.text('Provider: antigravity'), findsNothing);
      await tester.tap(find.text('Run prompt'));
      await tester.pumpAndSettle();
      expect(find.byType(SelectableText), findsNothing);
      await tester.tap(find.text('Run prompt'));
      await tester.pumpAndSettle();
      expect(requests, 2);
      expect(
        tester.widget<SelectableText>(find.byType(SelectableText)).data,
        'Updated fixture',
      );
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
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RunPromptDisclosure(runId: 'expires', api: api),
        ),
      ),
    );
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(find.byType(SelectableText), findsOneWidget);
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expired = true;
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(find.byType(SelectableText), findsNothing);
    expect(
      find.text('Prompt unavailable'),
      findsOneWidget,
    );
  });

  testWidgets('404 renders unavailable, and server errors retry on re-expansion', (
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
      find.text('Prompt unavailable'),
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
    expect(find.text('Could not load prompt'), findsOneWidget);
    status = 404;
    await tester.tap(find.text('Run prompt'));
    await tester.pump();
    await tester.tap(find.text('Run prompt'));
    await tester.pumpAndSettle();
    expect(
      find.text('Prompt unavailable'),
      findsOneWidget,
    );
  });
}
