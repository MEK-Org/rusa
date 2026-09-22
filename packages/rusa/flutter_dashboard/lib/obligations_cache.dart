import 'dart:convert';

import 'models.dart';

/// One persisted capture of the obligations forest, written after an authoritative
/// `/api/mesh/obligations/forest` sync and replayed on the next return or reload
/// so the Work tab can paint at 0ms instead of an empty loading spinner (#505).
///
/// Cache identity is strictly isolated by both server/instance [scope] and
/// authenticated [principalId], so obligations never leak across users or environments.
class PersistedObligationsSnapshot {
  const PersistedObligationsSnapshot({
    required this.scope,
    required this.principalId,
    required this.savedAt,
    required this.trees,
    this.total = 0,
    this.hasMore = false,
  });

  /// The dashboard server/instance this capture describes (e.g. scheme://host:port).
  final String scope;

  /// The authenticated user principal id owning or viewing this snapshot.
  final String principalId;

  /// ISO-8601 UTC instant the capture was written.
  final String savedAt;

  /// The cached obligation trees.
  final List<ObligationTreeDto> trees;

  /// Total count reported by the server.
  final int total;

  /// Whether more roots exist beyond the fetched page.
  final bool hasMore;

  /// Bumped whenever the persisted shape changes incompatibly.
  static const int schemaVersion = 1;

  /// Budget for the serialized capture. Browsers give an origin roughly 5 MiB
  /// of localStorage, so this takes about a tenth of it (512 KiB).
  static const int maxSerializedBytes = 512 * 1024;

  /// Captures older than this are ignored on load.
  static const Duration maxAge = Duration(days: 7);

  factory PersistedObligationsSnapshot.capture({
    required String scope,
    required String principalId,
    required List<ObligationTreeDto> trees,
    required DateTime now,
    int total = 0,
    bool hasMore = false,
  }) {
    return PersistedObligationsSnapshot(
      scope: scope,
      principalId: principalId,
      savedAt: now.toUtc().toIso8601String(),
      trees: trees,
      total: total,
      hasMore: hasMore,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': schemaVersion,
    'scope': scope,
    'principalId': principalId,
    'savedAt': savedAt,
    'trees': trees.map((t) => t.toJson()).toList(),
    'total': total,
    'hasMore': hasMore,
  };

  /// Parses a persisted payload, or returns null when it is from another schema
  /// version, is larger than the budget, or is not the shape this reader
  /// expects. Never throws.
  static PersistedObligationsSnapshot? fromJson(Object? decoded) {
    if (decoded is! Map) return null;
    if (decoded['version'] != schemaVersion) return null;
    final scope = decoded['scope'];
    final principalId = decoded['principalId'];
    final savedAt = decoded['savedAt'];
    final rawTrees = decoded['trees'];
    final total = decoded['total'] as int? ?? 0;
    final hasMore = decoded['hasMore'] as bool? ?? false;

    if (scope is! String ||
        principalId is! String ||
        savedAt is! String ||
        rawTrees is! List) {
      return null;
    }
    if (_encodedSize(rawTrees) > maxSerializedBytes) return null;

    final trees = <ObligationTreeDto>[];
    for (final raw in rawTrees) {
      if (raw is! Map) return null;
      try {
        trees.add(ObligationTreeDto.fromJson(Map<String, dynamic>.from(raw)));
      } catch (_) {
        return null;
      }
    }

    return PersistedObligationsSnapshot(
      scope: scope,
      principalId: principalId,
      savedAt: savedAt,
      trees: trees,
      total: total,
      hasMore: hasMore,
    );
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
    return !age.isNegative && age <= maxAge;
  }

  static int _encodedSize(Object? value) =>
      utf8.encode(jsonEncode(value)).length;
}

/// Persists the last authoritative obligations snapshot across page loads and
/// navigation returns (#505).
/// Concrete implementation is `WebObligationsCache` (browser localStorage).
abstract interface class ObligationsCache {
  /// The last capture saved for [scope] and [principalId], or null on a cold start.
  /// If [principalId] is omitted, loads the last capture saved for [scope].
  PersistedObligationsSnapshot? load({
    required String scope,
    String? principalId,
  });

  /// Persist [snapshot] as the new last-known capture.
  void save(PersistedObligationsSnapshot snapshot);

  /// Invalidate or remove cached obligations for [scope] and optional [principalId].
  void invalidate({
    required String scope,
    String? principalId,
  });

  /// Drop any persisted capture across all scopes and principals.
  void clear();
}

/// A no-op cache: the default when no persistence port is injected (headless
/// store tests, or a host without localStorage).
class NoopObligationsCache implements ObligationsCache {
  const NoopObligationsCache();

  @override
  PersistedObligationsSnapshot? load({
    required String scope,
    String? principalId,
  }) => null;

  @override
  void save(PersistedObligationsSnapshot snapshot) {}

  @override
  void invalidate({
    required String scope,
    String? principalId,
  }) {}

  @override
  void clear() {}
}
