import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
