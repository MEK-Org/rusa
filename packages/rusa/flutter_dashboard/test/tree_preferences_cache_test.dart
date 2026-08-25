import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/tree_preferences_cache.dart';

import 'fakes.dart';

void main() {
  group('TreePreferencesCache', () {
    test('NoopTreePreferencesCache never persists — every load returns null', () {
      const cache = NoopTreePreferencesCache();
      expect(cache.loadCollapsed(), isNull);
      expect(cache.loadShowRetired(), isNull);

      // save/clear are safe no-ops.
      cache.saveCollapsed({'root', 'actor-1'});
      cache.saveShowRetired(true);
      cache.clear();

      expect(cache.loadCollapsed(), isNull);
      expect(cache.loadShowRetired(), isNull);
    });

    test('FakeTreePreferencesCache tracks saves and loads correctly', () {
      final cache = FakeTreePreferencesCache(
        storedCollapsed: {'root'},
        storedShowRetired: true,
      );

      expect(cache.loadCollapsed(), {'root'});
      expect(cache.loadShowRetired(), isTrue);

      cache.saveCollapsed({'root', 'actor-b'});
      expect(cache.saveCollapsedCount, 1);
      expect(cache.loadCollapsed(), {'root', 'actor-b'});

      cache.saveShowRetired(false);
      expect(cache.saveShowRetiredCount, 1);
      expect(cache.loadShowRetired(), isFalse);

      cache.clear();
      expect(cache.clearCount, 1);
      expect(cache.loadCollapsed(), isNull);
      expect(cache.loadShowRetired(), isNull);
    });

    test('DashboardStore seeds collapsed and showRetired from TreePreferencesCache', () {
      final cache = FakeTreePreferencesCache(
        storedCollapsed: {'actor-a', 'actor-b'},
        storedShowRetired: true,
      );

      final store = DashboardStore(
        api: DashboardApi(),
        stream: FakeStream(),
        treePreferencesCache: cache,
      );

      expect(store.collapsed.value, {'actor-a', 'actor-b'});
      expect(store.showRetired.value, isTrue);

      // Toggling collapsed state saves to cache.
      store.toggleCollapsed('actor-c');
      expect(store.collapsed.value, {'actor-a', 'actor-b', 'actor-c'});
      expect(cache.saveCollapsedCount, 1);
      expect(cache.storedCollapsed, {'actor-a', 'actor-b', 'actor-c'});

      store.toggleCollapsed('actor-a');
      expect(store.collapsed.value, {'actor-b', 'actor-c'});
      expect(cache.saveCollapsedCount, 2);
      expect(cache.storedCollapsed, {'actor-b', 'actor-c'});

      // Toggling showRetired saves to cache.
      store.setShowRetired(false);
      expect(store.showRetired.value, isFalse);
      expect(cache.saveShowRetiredCount, 1);
      expect(cache.storedShowRetired, isFalse);
    });
  });
}
