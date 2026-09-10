import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';

import 'fakes.dart';

Widget _harness(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: Row(
      children: [
        ActorTree(store: store),
        Expanded(child: DetailPanel(store: store)),
      ],
    ),
  ),
);

Future<void> _openInfo(WidgetTester tester, String handle) async {
  await tester.tap(find.text(handle));
  await tester.pump(const Duration(milliseconds: 50));
  await tester.ensureVisible(find.text('Info'));
  await tester.tap(find.text('Info'));
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  test(
    'voice editor sends the V1 Google provider document and clears with null',
    () async {
      final bodies = <Object?>[];
      final api = DashboardApi(
        base: Uri.parse('http://localhost:3000'),
        client: MockClient((request) async {
          expect(request.method, 'PATCH');
          expect(request.url.path, '/api/mesh/actors/worker/voice');
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          bodies.add(body);
          final config = body['voiceConfig'] as Map<String, dynamic>?;
          return http.Response(
            jsonEncode({'voiceName': config?['config']?['voiceName']}),
            200,
          );
        }),
      );

      await api.updateActorVoice('worker', 'Puck');
      await api.updateActorVoice('worker', null);

      expect(bodies, [
        {
          'voiceConfig': {
            'schemaVersion': 1,
            'provider': 'google',
            'config': {'voiceName': 'Puck'},
          },
        },
        {'voiceConfig': null},
      ]);
    },
  );

  testWidgets(
    'Info tab edits an actor voice from the server-supported picker',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..supportedVoices = const ['Kore', 'Puck']
          ..threadsResult = [
            makeThread('root', created: 't0'),
            makeThread(
              'worker',
              parent: 'root',
              created: 't1',
              voiceName: 'Kore',
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await tester.pumpWidget(_harness(store));
        await _openInfo(tester, 'worker-handle');

        expect(find.text('Voice: '), findsOneWidget);
        expect(find.byType(DropdownButton<String?>), findsOneWidget);

        await tester.tap(find.byType(DropdownButton<String?>));
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.text('Puck'), findsOneWidget);
        await tester.tap(find.text('Puck'));
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }

        expect(api.actorVoiceUpdates, [(actorId: 'worker', voiceName: 'Puck')]);
        final picker = tester.widget<DropdownButton<String?>>(
          find.byType(DropdownButton<String?>),
        );
        expect(picker.value, 'Puck');

        // The dedicated default option is the escape hatch for actors that had
        // no pre-migration setting and deliberately retain global fallback.
        await tester.tap(find.byType(DropdownButton<String?>));
        await tester.pump(const Duration(milliseconds: 50));
        await tester.tap(find.text('Instance default'));
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(api.actorVoiceUpdates.last, (
          actorId: 'worker',
          voiceName: null,
        ));
        await store.dispose();
      });
    },
  );
}
