import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

void main() {
  FakeApi makeApi() => FakeApi()
    ..threadsResult = [makeThread('root')]
    ..obligationsResult = [
      makeObligation('ob-parent', ownerId: 'root', intent: 'Parent work'),
      makeObligation(
        'ob-child',
        ownerId: 'root',
        parentId: 'ob-parent',
        intent: 'Child work',
      ),
    ];

  Future<DashboardStore> pumpWorkTab(
    WidgetTester tester,
    FakeTreePreferencesCache cache,
  ) async {
    final store = DashboardStore(
      api: makeApi(),
      stream: FakeStream(),
      treePreferencesCache: cache,
    );
    await store.init();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkTab(store: store, onSelectView: (_) {}),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    return store;
  }

  testWidgets('expanding a work node persists to the preferences cache', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final cache = FakeTreePreferencesCache();
      final store = await pumpWorkTab(tester, cache);

      expect(find.text('Parent work'), findsOneWidget);
      expect(find.text('Child work'), findsNothing);

      await tester.tap(find.byIcon(Icons.chevron_right));
      await tester.pump();

      expect(find.text('Child work'), findsOneWidget);
      expect(cache.storedWorkExpanded, {'ob-parent'});
      expect(cache.saveWorkExpandedCount, 1);

      await tester.tap(find.byIcon(Icons.keyboard_arrow_down));
      await tester.pump();

      expect(find.text('Child work'), findsNothing);
      expect(cache.storedWorkExpanded, isEmpty);
      expect(cache.saveWorkExpandedCount, 2);
      await store.dispose();
    });
  });

  testWidgets('a persisted expansion set restores expanded work nodes', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final cache = FakeTreePreferencesCache(storedWorkExpanded: {'ob-parent'});
      final store = await pumpWorkTab(tester, cache);

      expect(find.text('Child work'), findsOneWidget);
      expect(find.byIcon(Icons.keyboard_arrow_down), findsOneWidget);
      await store.dispose();
    });
  });
}
