/// Interface for persisting actor tree UI preferences (expansion/collapse
/// state and show-retired toggle) across browser sessions .
///
/// Implemented by `WebTreePreferencesCache` in `web_tree_preferences_cache.dart`
/// via browser localStorage. The store depends only on this interface so it
/// and its headless tests never import the web-only `package:web`.
abstract interface class TreePreferencesCache {
  /// The set of collapsed actor IDs persisted from prior sessions, or null
  /// on a cold start / unreadable store.
  Set<String>? loadCollapsed();

  /// Persists [collapsed] as the new set of collapsed actor IDs.
  void saveCollapsed(Set<String> collapsed);

  /// The show-retired preference persisted from prior sessions, or null.
  bool? loadShowRetired();

  /// Persists [showRetired] preference.
  void saveShowRetired(bool showRetired);

  /// The custom sibling ordering per parent ID persisted from prior sessions, or null.
  Map<String, List<String>>? loadActorOrder();

  /// Persists [order] as the custom sibling ordering map per parent ID.
  void saveActorOrder(Map<String, List<String>> order);

  /// Drops any persisted tree preferences.
  void clear();
}

/// A no-op cache: the default when no persistence port is injected (headless
/// store tests, or a host without localStorage).
class NoopTreePreferencesCache implements TreePreferencesCache {
  const NoopTreePreferencesCache();

  @override
  Set<String>? loadCollapsed() => null;

  @override
  void saveCollapsed(Set<String> collapsed) {}

  @override
  bool? loadShowRetired() => null;

  @override
  void saveShowRetired(bool showRetired) {}

  @override
  Map<String, List<String>>? loadActorOrder() => null;

  @override
  void saveActorOrder(Map<String, List<String>> order) {}

  @override
  void clear() {}
}
