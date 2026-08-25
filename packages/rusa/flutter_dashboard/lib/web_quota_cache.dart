import 'dart:convert';

import 'package:web/web.dart' as web;

import 'models.dart';
import 'quota_cache.dart';

/// Browser `localStorage` implementation of [QuotaCache] (ISSUE_NUM ask 4). Imports
/// the web-only `package:web`, so — like `WebEventSourceStream` in `sse.dart` —
/// it is wired in only at the web entrypoint (`main.dart`) and never reached by
/// the headless store tests.
///
/// All access is wrapped: `localStorage` can throw (disabled in private mode,
/// blocked by policy) or hold a stale/corrupt value from an older schema. Any
/// failure degrades to a cold load rather than breaking the dashboard, so the
/// key is versioned — a future shape change bumps `_key` instead of trying to
/// migrate an incompatible blob.
class WebQuotaCache implements QuotaCache {
  static const String _key = 'rusa.dashboard.quota.v1';

  @override
  QuotaSnapshotDto? load() {
    try {
      final raw = web.window.localStorage.getItem(_key);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      return QuotaSnapshotDto.fromJson(decoded);
    } catch (_) {
      // Unreadable / corrupt / storage unavailable → cold start.
      return null;
    }
  }

  @override
  void save(QuotaSnapshotDto snapshot) {
    try {
      web.window.localStorage.setItem(_key, jsonEncode(snapshot.toJson()));
    } catch (_) {
      // Best-effort: a failed write just means the next load is a cold start.
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
