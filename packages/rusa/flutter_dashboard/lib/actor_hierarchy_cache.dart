import 'dart:convert';

import 'models.dart';

/// One persisted capture of the actor hierarchy, written after an authoritative
/// `/api/mesh/threads` sync and replayed on the next cold load so the tree can
/// paint at 0ms instead of an empty "No actors" panel while the request is
/// still in flight (#273).
///
/// The payload is deliberately *not* the server snapshot. It is a **record of
/// the tree row**: the fields an actor row actually draws, and nothing else.
///
/// - **Liveness is not a field.** `runState`, `queuePosition` and
///   `estimatedStartAt` describe what the mesh was doing in a previous browser
///   session; replaying them would paint green "running" dots and queue
///   positions that no longer correspond to anything. They are absent from the
///   record by construction, so a restored actor is always [RunState.unknown]
///   — the neutral dot — whatever a stale or hand-edited blob contains. So is
///   the mesh halt state: the emergency brake is live safety state, and a
///   stale "HALTED" banner would be worse than no banner.
/// - **Operational detail is not persisted either.** `provider`,
///   `desiredProvider`, `charterPreview`, `waitingOn`, `chatDisabled`,
///   `ownerExpectsRetirement` and the selected obligation are drawn by the
///   detail panel, the chat tab and the overview — all of them a click away,
///   and all of them behind the same round trip that is already in flight. A
///   cached row shows them empty for that moment rather than showing a
///   previous session's answer.
/// - **The set is bounded** ([maxSerializedBytes]) and **expires**
///   ([maxAge]), so a long-lived browser profile can't grow an unbounded blob
///   or resurrect a hierarchy from weeks ago.
/// - **The capture records the server [scope] it came from** — see
///   `DashboardStore.cacheScopeFor` for exactly what that does and does not
///   distinguish.
class PersistedActorHierarchy {
  const PersistedActorHierarchy({
    required this.scope,
    required this.savedAt,
    required this.threads,
  });

  /// The dashboard server this capture describes — see
  /// `DashboardStore.cacheScopeFor`. A load whose scope differs is discarded.
  final String scope;

  /// ISO-8601 UTC instant the capture was written. Used only for expiry; it is
  /// never presented as if it were fresh server data.
  final String savedAt;

  /// The actors, already filtered and bounded by [capture]. Every thread here
  /// carries only [_record]'s fields; the rest read as their DTO defaults.
  final List<ThreadDto> threads;

  /// Bumped whenever the persisted shape changes in a way an older reader
  /// would misread. A payload carrying any other version is dropped rather
  /// than migrated — the cost of a single cold load is lower than the cost of
  /// a migration path nobody exercises. v2 narrowed the record from a whole
  /// `ThreadDto` to the row fields below.
  static const int schemaVersion = 2;

  /// Budget for the serialized capture. Browsers give an origin roughly 5 MiB
  /// of `localStorage`, shared across every key this dashboard writes (the
  /// quota snapshot and the tree preferences are already in there), so this
  /// takes about a tenth of it and leaves the rest alone.
  ///
  /// This is **anticipated protection, not a measured limit**: no hierarchy
  /// size distribution was observed to pick it. What is measured is the cost
  /// per actor — a plain row encodes to about 310 bytes, and about 530 when it
  /// carries a staged model, a two-candidate pool and a commitment — so the
  /// budget holds roughly a thousand actors, well past any hierarchy this
  /// dashboard renders usefully today. It bounds bytes rather than rows because
  /// bytes are what the storage backend actually limits.
  static const int maxSerializedBytes = 512 * 1024;

  /// Captures older than this are ignored on load. Also anticipated
  /// protection: a week is a judgment about when a hierarchy stops being a
  /// plausible picture of the mesh, not a measurement.
  static const Duration maxAge = Duration(days: 7);

  /// Builds the capture to persist for [threads], newest first, admitting each
  /// actor together with any ancestors not already admitted and stopping at
  /// [maxSerializedBytes].
  ///
  /// Newest-first is the point: when a hierarchy does not fit, the actors worth
  /// painting immediately are the ones just spawned, not the ones that have
  /// been sitting there since the mesh started. Ancestors ride along because a
  /// row whose parent is missing is not drawn at all — the tree walk descends
  /// from the roots — so an actor and its chain are admitted or dropped
  /// together, and the capture always renders as a tree.
  ///
  /// Long-retired actors are not filtered here: the tree already hides retired
  /// actors it considers stale, so persisting is bounded by that rendering rule
  /// rather than by a second copy of it, and newest-first admission
  /// deprioritizes them on its own.
  factory PersistedActorHierarchy.capture({
    required String scope,
    required List<ThreadDto> threads,
    required DateTime now,
  }) {
    final byId = {for (final t in threads) t.id: t};
    final newestFirst = [...threads]..sort((a, b) {
      final c = b.createdAt.compareTo(a.createdAt);
      return c != 0 ? c : b.id.compareTo(a.id);
    });

    final kept = <String, Map<String, dynamic>>{};
    var bytes = 0;
    for (final thread in newestFirst) {
      if (kept.containsKey(thread.id)) continue;
      final chain = <ThreadDto>[];
      final seen = <String>{};
      var node = thread;
      while (!kept.containsKey(node.id) && seen.add(node.id)) {
        chain.add(node);
        final parentId = node.parentId;
        final parent = parentId == null ? null : byId[parentId];
        if (parent == null) break;
        node = parent;
      }
      final records = {for (final t in chain) t.id: _record(t)};
      final size = records.values.fold(0, (sum, r) => sum + _encodedSize(r));
      if (bytes + size > maxSerializedBytes) break;
      kept.addAll(records);
      bytes += size;
    }

    final retained = kept.values.map(_threadFromRecord).toList()
      ..sort((a, b) {
        final c = a.createdAt.compareTo(b.createdAt);
        return c != 0 ? c : a.id.compareTo(b.id);
      });
    return PersistedActorHierarchy(
      scope: scope,
      savedAt: now.toUtc().toIso8601String(),
      threads: retained,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': schemaVersion,
    'scope': scope,
    'savedAt': savedAt,
    'threads': threads.map(_record).toList(),
  };

  /// Parses a persisted payload, or returns null when it is from another schema
  /// version, is larger than the budget, or is not the shape this reader
  /// expects. Never throws: a corrupt blob degrades to a cold load.
  static PersistedActorHierarchy? fromJson(Object? decoded) {
    if (decoded is! Map) return null;
    if (decoded['version'] != schemaVersion) return null;
    final scope = decoded['scope'];
    final savedAt = decoded['savedAt'];
    final rawThreads = decoded['threads'];
    if (scope is! String || savedAt is! String || rawThreads is! List) {
      return null;
    }
    // [capture] bounds what this writer stores; checking again on the way in
    // means a blob from anywhere else can't hand the tree more than the budget.
    if (_encodedSize(rawThreads) > maxSerializedBytes) return null;
    final threads = <ThreadDto>[];
    for (final raw in rawThreads) {
      if (raw is! Map) return null;
      try {
        threads.add(_threadFromRecord(Map<String, dynamic>.from(raw)));
      } catch (_) {
        // One unreadable actor means the blob no longer matches the record the
        // rest of the dashboard speaks — take the cold load over a half tree.
        return null;
      }
    }
    return PersistedActorHierarchy(
      scope: scope,
      savedAt: savedAt,
      threads: threads,
    );
  }

  /// Whether this capture may seed the tree: same server, and young enough to
  /// still be a plausible picture of it.
  bool isUsableAt({required String scope, required DateTime now}) {
    if (this.scope != scope) return false;
    final written = DateTime.tryParse(savedAt);
    if (written == null) return false;
    final age = now.toUtc().difference(written.toUtc());
    return !age.isNegative && age <= maxAge;
  }

  /// One actor, as the tree row draws it: identity and place in the tree, the
  /// label and its timestamps, and the model/effort/pool/commitment chips
  /// (`widgets/actor_tree.dart` reads exactly these). Optional fields are
  /// emitted only when set, which keeps a plain row near 310 bytes.
  ///
  /// Nothing here asserts what the mesh is doing *now*, so this is the whole
  /// reason a restored row cannot lie about liveness.
  static Map<String, dynamic> _record(ThreadDto t) => {
    'id': t.id,
    'handle': t.handle,
    if (t.parentId != null) 'parentId': t.parentId,
    'status': t.status,
    if (t.title.isNotEmpty) 'title': t.title,
    'createdAt': t.createdAt,
    if (t.lastActiveAt != null) 'lastActiveAt': t.lastActiveAt,
    if (t.model != null) 'model': t.model,
    if (t.desiredModel != null) 'desiredModel': t.desiredModel,
    if (t.effort != null) 'effort': t.effort,
    // Keyed on presence, not value: an explicit null `desiredEffort` is a
    // staged *clear*, which reads differently from nothing staged at all.
    if (t.effortChangePending) 'desiredEffort': t.desiredEffort,
    if (t.modelConfig.isNotEmpty)
      'modelConfig': t.modelConfig.map((c) => c.toJson()).toList(),
    // A staged pool is never empty (the server rejects one), so a null must
    // stay absent rather than come back as `[]` and draw "staged (0)".
    if (t.desiredModelConfig != null)
      'desiredModelConfig': t.desiredModelConfig!
          .map((c) => c.toJson())
          .toList(),
    if (t.commitmentKind != null) 'commitmentKind': t.commitmentKind,
  };

  /// The inverse of [_record]. Every field the record omits takes its DTO
  /// default — which for the run fields is [RunState.unknown] and no queue
  /// position, and for the detail-panel fields is empty until the sync lands.
  static ThreadDto _threadFromRecord(Map<String, dynamic> j) => ThreadDto(
    id: j['id'] as String,
    handle: j['handle'] as String,
    parentId: j['parentId'] as String?,
    status: j['status'] as String,
    provider: null,
    model: j['model'] as String?,
    effort: j['effort'] as String?,
    desiredModel: j['desiredModel'] as String?,
    desiredEffort: j['desiredEffort'] as String?,
    effortChangePending: j.containsKey('desiredEffort'),
    modelConfig: _configs(j['modelConfig']) ?? const [],
    desiredModelConfig: _configs(j['desiredModelConfig']),
    charterPreview: '',
    title: j['title'] as String? ?? '',
    createdAt: j['createdAt'] as String? ?? '',
    lastActiveAt: j['lastActiveAt'] as String?,
    commitmentKind: j['commitmentKind'] as String?,
  );

  static List<ProviderModelConfig>? _configs(Object? raw) => raw is List
      ? raw
            .map(
              (e) => ProviderModelConfig.fromJson(
                Map<String, dynamic>.from(e as Map),
              ),
            )
            .toList()
      : null;

  static int _encodedSize(Object? value) => utf8.encode(jsonEncode(value)).length;
}

/// Persists the last authoritative actor hierarchy across page loads (#273).
/// The real implementation is `WebActorHierarchyCache` (browser localStorage,
/// in `web_actor_hierarchy_cache.dart`); the store depends only on this
/// interface so it — and its headless tests — never import the web-only
/// `package:web`, mirroring the `QuotaCache`/`WebQuotaCache` split.
abstract interface class ActorHierarchyCache {
  /// The last capture [save]d, or null on a cold start / unreadable store.
  /// Implementations must swallow their own errors and return null rather than
  /// throw — a broken cache degrades to a cold load, it never breaks boot.
  PersistedActorHierarchy? load();

  /// Persist [hierarchy] as the new last-known capture. Best-effort: a failed
  /// write (quota exceeded, private mode) is swallowed by the implementation.
  void save(PersistedActorHierarchy hierarchy);

  /// Drop any persisted capture — used when a stored payload turns out to
  /// belong to another server or to have expired.
  void clear();
}

/// A no-op cache: the default when no persistence port is injected (headless
/// store tests, or a host without localStorage). Every load is a cold start.
class NoopActorHierarchyCache implements ActorHierarchyCache {
  const NoopActorHierarchyCache();

  @override
  PersistedActorHierarchy? load() => null;

  @override
  void save(PersistedActorHierarchy hierarchy) {}

  @override
  void clear() {}
}
