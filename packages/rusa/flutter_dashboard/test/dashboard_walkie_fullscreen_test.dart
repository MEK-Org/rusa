import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';

import 'fakes.dart';

void main() {
  testWidgets(
    'Walkie fullscreen transition reparents correctly and retains state',
    (tester) async {
      final api = FakeApi()..threadsResult = [makeThread('a')];
      final stream = FakeStream();
      final walkie = FakeWalkie(api);
      final store = DashboardStore(
        api: api,
        stream: stream,
        walkie: walkie.deps,
      );

      await store.refreshThreads();
      store.clickActor('a');

      // Short viewport height (< 500) triggers fullscreen walkie.
      // Use 800 width so normal layout fits before toggling. Height 480 clears header chrome.
      await tester.binding.setSurfaceSize(const Size(800, 480));
      addTearDown(() async {
        tester.binding.setSurfaceSize(null);
        await store.dispose();
      });

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: DetailPanel(store: store, narrow: true)),
        ),
      );
      await tester.pump();
      await tester.pump();

      // Verify initial state: normal input area is present
      expect(find.byKey(const ValueKey('walkie-toggle')), findsOneWidget);
      expect(find.byKey(const ValueKey('walkie-panel')), findsNothing);

      // Toggle walkie ON
      await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
      await tester.pump(); // Process tap
      await tester.pump(); // Run stream builder updates

      // If walkie was correctly reparented, walkieActive should still be true,
      // and the panel should be visible. If the bug is present, the State gets disposed,
      // which calls disable() on the controller, turning walkieActive false.
      expect(store.walkieActive.value, isTrue);
      expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);
    },
  );
}
