import 'dart:convert';

import 'package:web/web.dart' as web;

import 'obligations_cache.dart';

/// Browser `localStorage` implementation of [ObligationsCache] (#505).
/// Imports the web-only `package:web`, so it is wired in only at the web
/// entrypoint (`main.dart`) and never reached by headless tests.
///
/// All access is wrapped: localStorage can throw or hold a corrupted value.
/// Any failure degrades gracefully to a cold load rather than breaking the UI.
/// Keys carry the schema version and are strictly scoped to the server instance
/// and authenticated user principal.
class WebObligationsCache implements ObligationsCache {
  static String _snapshotKey(String scope, String principalId) {
    final sanitizedScope = Uri.encodeComponent(scope);
    final sanitizedPrincipal = Uri.encodeComponent(principalId);
    return 'rusa.dashboard.obligations.v${PersistedObligationsSnapshot.schemaVersion}.$sanitizedScope.$sanitizedPrincipal';
  }

  @override
  PersistedObligationsSnapshot? load({
    required String scope,
    required String principalId,
  }) {
    try {
      if (principalId.isEmpty) return null;
      final key = _snapshotKey(scope, principalId);
      final raw = web.window.localStorage.getItem(key);
      if (raw == null || raw.isEmpty) {
        return null;
      }
      final rawByteCount = PersistedObligationsSnapshot.encodedSize(raw);
      if (rawByteCount > PersistedObligationsSnapshot.maxSerializedBytes) {
        return null;
      }
      return PersistedObligationsSnapshot.fromJson(
        jsonDecode(raw),
        serializedByteCount: rawByteCount,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  void save(PersistedObligationsSnapshot snapshot) {
    try {
      final raw = snapshot.encode();
      if (!PersistedObligationsSnapshot.rawFitsStorageBudget(raw)) return;
      final key = _snapshotKey(snapshot.scope, snapshot.principalId);
      web.window.localStorage.setItem(key, raw);
    } catch (_) {
      // Best-effort: swallow quota or private browsing exceptions.
    }
  }

  @override
  void invalidate({required String scope, required String principalId}) {
    try {
      if (principalId.isEmpty) return;
      web.window.localStorage.removeItem(_snapshotKey(scope, principalId));
    } catch (_) {
      // Best-effort.
    }
  }

  static String _entitiesKey(String scope, String principalId) =>
      'rusa.dashboard.obligations.entities.v${PersistedObligationEntitiesSnapshot.schemaVersion}.'
      '${Uri.encodeComponent(scope)}.${Uri.encodeComponent(principalId)}';

  @override
  PersistedObligationEntitiesSnapshot? loadEntities({
    required String scope,
    required String principalId,
  }) {
    try {
      if (principalId.isEmpty) return null;
      final raw = web.window.localStorage.getItem(
        _entitiesKey(scope, principalId),
      );
      if (raw == null || raw.isEmpty) return null;
      final rawByteCount = PersistedObligationsSnapshot.encodedSize(raw);
      if (rawByteCount >
          PersistedObligationEntitiesSnapshot.maxSerializedBytes) {
        return null;
      }
      return PersistedObligationEntitiesSnapshot.fromJson(
        jsonDecode(raw),
        serializedByteCount: rawByteCount,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  void saveEntities(PersistedObligationEntitiesSnapshot snapshot) {
    try {
      final raw = snapshot.encode();
      final key = _entitiesKey(snapshot.scope, snapshot.principalId);
      if (!PersistedObligationEntitiesSnapshot.rawFitsStorageBudget(raw)) {
        // A store that outgrew the budget must not leave an older capture
        // behind to replay.
        web.window.localStorage.removeItem(key);
        return;
      }
      web.window.localStorage.setItem(key, raw);
    } catch (_) {
      // Quota or private browsing: drop the older capture rather than keep it.
      invalidateEntities(
        scope: snapshot.scope,
        principalId: snapshot.principalId,
      );
    }
  }

  @override
  void invalidateEntities({
    required String scope,
    required String principalId,
  }) {
    try {
      if (principalId.isEmpty) return;
      web.window.localStorage.removeItem(_entitiesKey(scope, principalId));
    } catch (_) {
      // Best-effort.
    }
  }

  @override
  void clear() {
    try {
      final storage = web.window.localStorage;
      final keys = <String>[];
      for (var i = 0; i < storage.length; i++) {
        final key = storage.key(i);
        if (key != null && key.startsWith('rusa.dashboard.obligations.')) {
          keys.add(key);
        }
      }
      for (final key in keys) {
        storage.removeItem(key);
      }
    } catch (_) {
      // Best-effort.
    }
  }
}
