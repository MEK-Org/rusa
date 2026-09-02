import 'dart:convert';

import 'package:web/web.dart' as web;

import 'tree_preferences_cache.dart';

/// Browser `localStorage` implementation of [TreePreferencesCache] .
///
/// Wraps all storage access so unreadable / disabled / corrupt storage
/// degrades cleanly to defaults without crashing the dashboard.
class WebTreePreferencesCache implements TreePreferencesCache {
  static const String _collapsedKey = 'rusa.dashboard.tree.collapsed.v1';
  static const String _showRetiredKey = 'rusa.dashboard.tree.show_retired.v1';
  static const String _actorOrderKey = 'rusa.dashboard.tree.actor_order.v1';

  @override
  Set<String>? loadCollapsed() {
    try {
      final raw = web.window.localStorage.getItem(_collapsedKey);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! List) return null;
      return decoded.map((e) => e.toString()).toSet();
    } catch (_) {
      return null;
    }
  }

  @override
  void saveCollapsed(Set<String> collapsed) {
    try {
      web.window.localStorage.setItem(
        _collapsedKey,
        jsonEncode(collapsed.toList()),
      );
    } catch (_) {
      // Best-effort: failed write is swallowed.
    }
  }

  @override
  bool? loadShowRetired() {
    try {
      final raw = web.window.localStorage.getItem(_showRetiredKey);
      if (raw == null || raw.isEmpty) return null;
      return raw == 'true';
    } catch (_) {
      return null;
    }
  }

  @override
  void saveShowRetired(bool showRetired) {
    try {
      web.window.localStorage.setItem(_showRetiredKey, showRetired.toString());
    } catch (_) {
      // Best-effort.
    }
  }

  @override
  Map<String, List<String>>? loadActorOrder() {
    try {
      final raw = web.window.localStorage.getItem(_actorOrderKey);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final result = <String, List<String>>{};
      for (final entry in decoded.entries) {
        if (entry.value is List) {
          result[entry.key.toString()] = (entry.value as List)
              .map((e) => e.toString())
              .toList();
        }
      }
      return result;
    } catch (_) {
      return null;
    }
  }

  @override
  void saveActorOrder(Map<String, List<String>> order) {
    try {
      web.window.localStorage.setItem(_actorOrderKey, jsonEncode(order));
    } catch (_) {
      // Best-effort.
    }
  }

  @override
  void clear() {
    try {
      web.window.localStorage.removeItem(_collapsedKey);
      web.window.localStorage.removeItem(_showRetiredKey);
      web.window.localStorage.removeItem(_actorOrderKey);
    } catch (_) {}
  }
}
