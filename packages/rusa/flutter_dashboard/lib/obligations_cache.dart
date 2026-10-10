import 'dart:convert';

import 'models.dart';
import 'obligation_store.dart';

/// One persisted capture of the obligations forest, written after an authoritative
/// `/api/mesh/obligations/forest` sync and replayed on the next return or reload
/// after the viewing principal is resolved, before the background forest request
/// completes (#505).
///
/// Cache identity is strictly isolated by both server/instance [scope] and
/// authenticated [principalId], so obligations never leak across users or environments.
class PersistedObligationsSnapshot {
  const PersistedObligationsSnapshot({
    required this.scope,
    required this.principalId,
    required this.savedAt,
    required this.trees,
  });

  /// The dashboard server/instance this capture describes (e.g. scheme://host:port).
  final String scope;

  /// The authenticated user principal id owning or viewing this snapshot.
  final String principalId;

  /// ISO-8601 UTC instant the capture was written.
  final String savedAt;

  /// The cached obligation trees.
  final List<ObligationTreeDto> trees;

  /// Bumped whenever the persisted shape changes incompatibly.
  static const int schemaVersion = 2;

  /// Budget for the serialized capture. Browsers give an origin roughly 5 MiB
  /// of localStorage, so this takes about a tenth of it (512 KiB).
  static const int maxSerializedBytes = 512 * 1024;

  /// Captures older than this are ignored on load.
  static const Duration maxAge = Duration(days: 7);

  /// Small wall-clock adjustments between save and reload are expected.
  static const Duration maxFutureSkew = Duration(minutes: 1);

  factory PersistedObligationsSnapshot.capture({
    required String scope,
    required String principalId,
    required List<ObligationTreeDto> trees,
    required DateTime now,
  }) {
    return PersistedObligationsSnapshot(
      scope: scope,
      principalId: principalId,
      savedAt: now.toUtc().toIso8601String(),
      trees: trees,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': schemaVersion,
    'scope': scope,
    'principalId': principalId,
    'savedAt': savedAt,
    'trees': trees.map((t) => t.toJson()).toList(),
  };

  /// Encodes this complete capture exactly as it is stored in localStorage.
  String encode() => jsonEncode(toJson());

  /// Lets the browser adapter reject an oversized raw localStorage value before
  /// paying to parse it.
  static bool rawFitsStorageBudget(String raw) =>
      encodedSize(raw) <= maxSerializedBytes;

  /// Parses a persisted payload, or returns null when it is from another schema
  /// version, is larger than the budget, or is not the shape this reader
  /// expects. Never throws. Adapters that already measured the serialized
  /// payload may pass [serializedByteCount] to avoid re-encoding [decoded].
  /// Callers without that boundary retain the defensive serialized-size check.
  static PersistedObligationsSnapshot? fromJson(
    Object? decoded, {
    int? serializedByteCount,
  }) {
    try {
      if (decoded is! Map) return null;
      if (decoded['version'] != schemaVersion) return null;
      final byteCount = serializedByteCount ?? encodedSize(jsonEncode(decoded));
      if (byteCount < 0 || byteCount > maxSerializedBytes) return null;
      final scope = decoded['scope'];
      final principalId = decoded['principalId'];
      final savedAt = decoded['savedAt'];
      final rawTrees = decoded['trees'];

      if (scope is! String ||
          principalId is! String ||
          savedAt is! String ||
          rawTrees is! List) {
        return null;
      }

      final trees = <ObligationTreeDto>[];
      for (final raw in rawTrees) {
        if (raw is! Map) return null;
        trees.add(ObligationTreeDto.fromJson(Map<String, dynamic>.from(raw)));
      }

      return PersistedObligationsSnapshot(
        scope: scope,
        principalId: principalId,
        savedAt: savedAt,
        trees: trees,
      );
    } catch (_) {
      return null;
    }
  }

  /// Whether this capture may seed the obligations view: matching server scope,
  /// matching authenticated principal, and within max age.
  bool isUsableAt({
    required String scope,
    required String principalId,
    required DateTime now,
  }) {
    if (this.scope != scope) return false;
    if (this.principalId != principalId) return false;
    final written = DateTime.tryParse(savedAt);
    if (written == null) return false;
    final age = now.toUtc().difference(written.toUtc());
    return age >= -maxFutureSkew && age <= maxAge;
  }

  static int encodedSize(String value) => utf8.encode(value).length;
}

/// One persisted capture of the shared obligation store (#992), written after
/// each settled refresh and replayed once the viewing principal resolves on
/// the next page load, while the refresh runs. It holds the obligations of
/// the queries the store knew in full, those rows' recorded blockers, and the
/// queries themselves, so a replayed empty queue still reads as empty.
/// Identity, age and corruption rules match [PersistedObligationsSnapshot].
class PersistedObligationEntitiesSnapshot {
  const PersistedObligationEntitiesSnapshot({
    required this.scope,
    required this.principalId,
    required this.savedAt,
    required this.queries,
    required this.entities,
  });

  final String scope;
  final String principalId;
  final String savedAt;
  final List<ObligationQuery> queries;
  final ObligationEntities entities;

  static const int schemaVersion = 1;

  /// Half the forest budget, so both captures together stay well inside an
  /// origin's localStorage (768 KiB of roughly 5 MiB).
  static const int maxSerializedBytes = 256 * 1024;

  /// Captures what [entities] holds for [queries]: their rows, and the
  /// recorded blockers of those rows.
  factory PersistedObligationEntitiesSnapshot.capture({
    required String scope,
    required String principalId,
    required Iterable<ObligationQuery> queries,
    required ObligationEntities entities,
    required DateTime now,
  }) {
    final kept = queries.toList();
    final rows = {
      for (final q in kept)
        for (final o in entities.select(q)) o.id: o,
    };
    final blockers = {for (final id in rows.keys) id: ?entities.blockers[id]};
    return PersistedObligationEntitiesSnapshot(
      scope: scope,
      principalId: principalId,
      savedAt: now.toUtc().toIso8601String(),
      queries: kept,
      entities: ObligationEntities(
        byId: {
          ...rows,
          for (final children in blockers.values)
            for (final c in children) c: ?entities.byId[c],
        },
        blockers: blockers,
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'version': schemaVersion,
    'scope': scope,
    'principalId': principalId,
    'savedAt': savedAt,
    'queries': [
      for (final q in queries) {'ownerId': q.ownerId, 'queue': q.queue.name},
    ],
    'obligations': entities.byId.values.map((o) => o.toJson()).toList(),
    'blockers': entities.blockers,
  };

  String encode() => jsonEncode(toJson());

  static bool rawFitsStorageBudget(String raw) =>
      PersistedObligationsSnapshot.encodedSize(raw) <= maxSerializedBytes;

  /// Parses a persisted payload, or returns null for another schema version,
  /// an oversized payload or an unexpected shape. Never throws.
  static PersistedObligationEntitiesSnapshot? fromJson(
    Object? decoded, {
    int? serializedByteCount,
  }) {
    try {
      if (decoded is! Map) return null;
      if (decoded['version'] != schemaVersion) return null;
      final byteCount =
          serializedByteCount ??
          PersistedObligationsSnapshot.encodedSize(jsonEncode(decoded));
      if (byteCount < 0 || byteCount > maxSerializedBytes) return null;
      final scope = decoded['scope'];
      final principalId = decoded['principalId'];
      final savedAt = decoded['savedAt'];
      final queries = decoded['queries'];
      final obligations = decoded['obligations'];
      final blockers = decoded['blockers'];
      if (scope is! String ||
          principalId is! String ||
          savedAt is! String ||
          queries is! List ||
          obligations is! List ||
          blockers is! Map) {
        return null;
      }
      return PersistedObligationEntitiesSnapshot(
        scope: scope,
        principalId: principalId,
        savedAt: savedAt,
        queries: [
          for (final q in queries.cast<Map<dynamic, dynamic>>())
            ObligationQuery(
              ownerId: q['ownerId'] as String,
              queue: ObligationQueue.values.byName(q['queue'] as String),
            ),
        ],
        entities: ObligationEntities(
          byId: {
            for (final o in obligations.map(
              (raw) =>
                  ObligationDto.fromJson(Map<String, dynamic>.from(raw as Map)),
            ))
              o.id: o,
          },
          blockers: {
            for (final e in blockers.entries)
              e.key as String: (e.value as List).cast<String>().toList(),
          },
        ),
      );
    } catch (_) {
      return null;
    }
  }

  bool isUsableAt({
    required String scope,
    required String principalId,
    required DateTime now,
  }) {
    if (this.scope != scope || this.principalId != principalId) return false;
    final written = DateTime.tryParse(savedAt);
    if (written == null) return false;
    final age = now.toUtc().difference(written.toUtc());
    return age >= -PersistedObligationsSnapshot.maxFutureSkew &&
        age <= PersistedObligationsSnapshot.maxAge;
  }
}

/// Persists the last authoritative obligations snapshot across page loads and
/// navigation returns (#505).
/// Concrete implementation is `WebObligationsCache` (browser localStorage).
abstract interface class ObligationsCache {
  /// The last capture saved for [scope] and [principalId], or null on a cold start.
  PersistedObligationsSnapshot? load({
    required String scope,
    required String principalId,
  });

  /// Persist [snapshot] as the new last-known capture.
  void save(PersistedObligationsSnapshot snapshot);

  /// Invalidate or remove cached obligations for [scope] and [principalId].
  void invalidate({required String scope, required String principalId});

  /// The last shared obligation store capture for [scope] and [principalId]
  /// (#992).
  PersistedObligationEntitiesSnapshot? loadEntities({
    required String scope,
    required String principalId,
  });

  void saveEntities(PersistedObligationEntitiesSnapshot snapshot);

  void invalidateEntities({required String scope, required String principalId});

  /// Drop every persisted capture, forest and shared store, across all scopes
  /// and principals.
  void clear();
}

/// A no-op cache: the default when no persistence port is injected (headless
/// store tests, or a host without localStorage).
class NoopObligationsCache implements ObligationsCache {
  const NoopObligationsCache();

  @override
  PersistedObligationsSnapshot? load({
    required String scope,
    required String principalId,
  }) => null;

  @override
  void save(PersistedObligationsSnapshot snapshot) {}

  @override
  void invalidate({required String scope, required String principalId}) {}

  @override
  PersistedObligationEntitiesSnapshot? loadEntities({
    required String scope,
    required String principalId,
  }) => null;

  @override
  void saveEntities(PersistedObligationEntitiesSnapshot snapshot) {}

  @override
  void invalidateEntities({
    required String scope,
    required String principalId,
  }) {}

  @override
  void clear() {}
}
