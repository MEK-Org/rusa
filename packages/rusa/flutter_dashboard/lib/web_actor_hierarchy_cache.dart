import 'dart:convert';

import 'package:web/web.dart' as web;

import 'actor_hierarchy_cache.dart';

/// Browser `localStorage` implementation of [ActorHierarchyCache] (#273).
/// Imports the web-only `package:web`, so — like `WebQuotaCache` — it is wired
/// in only at the web entrypoint (`main.dart`) and never reached by the
/// headless store tests.
///
/// All access is wrapped: `localStorage` can throw (disabled in private mode,
/// blocked by policy, over quota) or hold a value written by an older build.
/// Any failure degrades to a cold load rather than breaking the dashboard.
/// The key carries the schema version, so a shape change starts a fresh key
/// instead of trying to migrate an incompatible blob; the payload additionally
/// records which server it describes, which `DashboardStore` checks on load.
class WebActorHierarchyCache implements ActorHierarchyCache {
  static final String _key =
      'rusa.dashboard.actors.v${PersistedActorHierarchy.schemaVersion}';

  @override
  PersistedActorHierarchy? load() {
    try {
      final raw = web.window.localStorage.getItem(_key);
      if (raw == null || raw.isEmpty) return null;
      return PersistedActorHierarchy.fromJson(jsonDecode(raw));
    } catch (_) {
      // Unreadable / corrupt / storage unavailable → cold start.
      return null;
    }
  }

  @override
  void save(PersistedActorHierarchy hierarchy) {
    try {
      web.window.localStorage.setItem(_key, jsonEncode(hierarchy.toJson()));
    } catch (_) {
      // Best-effort: a failed write (commonly QuotaExceededError on a full
      // origin) just means the next load is a cold start.
    }
  }

  @override
  void clear() {
    try {
      web.window.localStorage.removeItem(_key);
    } catch (_) {
      // Nothing to do if the store is unavailable.
    }
  }
}
