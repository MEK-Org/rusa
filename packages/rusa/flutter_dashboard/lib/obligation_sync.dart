import 'dart:async';

import 'package:rxdart/rxdart.dart';

import 'api.dart';
import 'models.dart';
import 'obligation_store.dart';

/// Where one query's data stands with the server.
class QueryFreshness {
  const QueryFreshness({
    this.known = false,
    this.stale = false,
    this.error,
    this.fetchedAt,
  });

  /// The store has held this query's full membership at some point: from a
  /// response, or a persisted capture replayed after a reload. An empty
  /// projection of a known query means the queue is empty; of an unknown
  /// one, only that nothing has said otherwise yet.
  final bool known;

  /// An obligation change since the last response may have moved it.
  final bool stale;

  /// The latest refresh's failure, cleared by the next success.
  final Object? error;

  /// When the last successful response arrived in this session; null after a
  /// replay until the first one.
  final DateTime? fetchedAt;

  QueryFreshness get markedStale => QueryFreshness(
    known: known,
    stale: true,
    error: error,
    fetchedAt: fetchedAt,
  );

  QueryFreshness failedWith(Object error) => QueryFreshness(
    known: known,
    stale: stale,
    error: error,
    fetchedAt: fetchedAt,
  );
}

/// Owns the obligation store's freshness (#992): decides when a query needs
/// a request, sends at most one at a time per query, and writes each response
/// into the [ObligationStore], whose projections the views render. Views only
/// say what they show ([ensureFresh]) or that the operator asked
/// ([refresh]); obligation events and the viewer's own mutations arrive here
/// to mark what they may have moved.
class ObligationSync {
  ObligationSync({
    required DashboardApi api,
    required ObligationStore store,
    this.onSettled,
    this.onStale,
    DateTime Function()? now,
  }) : _api = api,
       _store = store,
       _now = now ?? DateTime.timestamp;

  /// A query answered within this long, and not marked stale since, is shown
  /// without a request. Obligation events mark what they touch stale, so
  /// this only bounds how long an update the dashboard missed can linger.
  static const freshFor = Duration(seconds: 30);

  final DashboardApi _api;
  final ObligationStore _store;
  final DateTime Function() _now;

  /// Called after a response lands that no later change overtook, so its
  /// state may be persisted.
  final void Function()? onSettled;

  /// Called when a change may have moved a known query, so no persisted
  /// state of it outlives the change.
  final void Function()? onStale;

  final _freshness =
      BehaviorSubject<Map<ObligationQuery, QueryFreshness>>.seeded(const {});

  /// Bumped when no in-flight response may land: the viewer changed, or the
  /// viewer's own mutation committed after it was sent.
  int _epoch = 0;

  /// Per query, bumped whenever it is marked stale; a response is only
  /// trusted to drop rows if its query was not marked stale while in flight.
  final Map<ObligationQuery, int> _versions = {};
  final Map<ObligationQuery, Future<void>> _inFlight = {};

  ValueStream<Map<ObligationQuery, QueryFreshness>> get freshness =>
      _freshness.stream;

  QueryFreshness freshnessOf(ObligationQuery query) =>
      _freshness.value[query] ?? const QueryFreshness();

  /// Queries whose stored rows reflect the latest response: known, and not
  /// marked stale since.
  Iterable<ObligationQuery> get settledQueries => _freshness.value.entries
      .where((e) => e.value.known && !e.value.stale)
      .map((e) => e.key);

  /// Starts over for a new viewer. [replayed] queries' rows were seeded from
  /// a persisted capture, so they are known but still need a response.
  void reset({Iterable<ObligationQuery> replayed = const []}) {
    _epoch++;
    for (final q in {..._versions.keys, ...replayed}) {
      _bump(q);
    }
    _setAll({for (final q in replayed) q: const QueryFreshness(known: true)});
  }

  /// Requests every query in [queries] that is not fresh: never answered in
  /// this session, failed last time, marked stale, or older than [freshFor].
  Future<void> ensureFresh(List<ObligationQuery> queries) =>
      refresh(queries.where(_needsRequest).toList());

  /// Requests [queries] now, sharing any request already in flight for one.
  /// Never throws: a failure is recorded in [freshness] and the stored rows
  /// stay.
  Future<void> refresh(List<ObligationQuery> queries) => Future.wait([
    for (final q in queries) _inFlight[q] ??= _runRefreshesOnce(q),
  ]);

  // The removal's result is not returned: `whenComplete` would wait on the
  // very future it is completing.
  Future<void> _runRefreshesOnce(ObligationQuery q) =>
      _runRefreshes(q).whenComplete(() {
        _inFlight.remove(q);
      });

  /// An obligation event named [ids], or did not say which it touched (an
  /// empty set): every query showing one of them may have moved.
  void obligationsChanged(Set<String> ids) =>
      _markStale((q) => ids.isEmpty || _mentions(q, ids));

  /// Obligations moved to these statuses. A query moves if it shows one of
  /// them, or if a new status could put one into it: status events carry no
  /// owner, so an arrival in a queue looks like any other.
  void statusesChanged(Map<String, String> statuses) {
    if (statuses.isEmpty) return obligationsChanged(const {});
    final ids = statuses.keys.toSet();
    final entering = statuses.values.toSet();
    _markStale(
      (q) =>
          _mentions(q, ids) ||
          switch (q.queue) {
            // A snoozed row of any live status sits in waiting.
            ObligationQueue.waiting => entering.any(_isLive),
            ObligationQueue.ready => entering.contains('ready'),
            ObligationQueue.scheduled => entering.contains('scheduled'),
          },
    );
  }

  /// The viewer's own mutation committed: a response sent before it would
  /// briefly undo it, so none in flight may land, and every query may have
  /// moved.
  void mutated() {
    _epoch++;
    _markStale((_) => true);
  }

  Future<void> close() => _freshness.close();

  static bool _isLive(String status) =>
      status != 'done' && status != 'cancelled';

  bool _needsRequest(ObligationQuery q) {
    final f = freshnessOf(q);
    final at = f.fetchedAt;
    return at == null ||
        f.stale ||
        f.error != null ||
        _now().difference(at) > freshFor;
  }

  bool _mentions(ObligationQuery q, Set<String> ids) {
    final entities = _store.current;
    return entities
        .select(q)
        .any(
          (o) =>
              ids.contains(o.id) ||
              (entities.blockers[o.id]?.any(ids.contains) ?? false),
        );
  }

  /// Marks the known queries [test] picks stale and refreshes those a view
  /// shows. Off screen, the next [ensureFresh] refreshes them, so nobody pays
  /// for a view nobody is looking at.
  void _markStale(bool Function(ObligationQuery) test) {
    final moved = [
      for (final e in _freshness.value.entries)
        if (e.value.known && test(e.key)) e.key,
    ];
    if (moved.isEmpty) return;
    for (final q in moved) {
      _bump(q);
    }
    _setAll({
      ..._freshness.value,
      for (final q in moved) q: freshnessOf(q).markedStale,
    });
    onStale?.call();
    unawaited(refresh(moved.where(_store.isWatched).toList()));
  }

  /// Repeats while changes keep marking a watched query stale during its
  /// request, so the last response it shows started after the last change.
  Future<void> _runRefreshes(ObligationQuery q) async {
    int startedAt;
    do {
      startedAt = _versions[q] ?? 0;
      await _refreshOnce(q, startedAt);
    } while (startedAt != (_versions[q] ?? 0) &&
        _store.isWatched(q) &&
        !_freshness.isClosed);
  }

  Future<void> _refreshOnce(ObligationQuery q, int startedAt) async {
    final epoch = _epoch;
    bool current() => epoch == _epoch && !_freshness.isClosed;
    final ObligationPage page;
    try {
      page = await _api.fetchObligations(
        ownerId: q.ownerId,
        queue: q.queue.name,
      );
    } catch (e) {
      if (current()) _set(q, freshnessOf(q).failedWith(e));
      return;
    }
    if (!current()) return;
    // A response a change overtook still shows what it found, but only the
    // follow-up may drop rows or be persisted: the change may be what it
    // is missing.
    final settled = startedAt == (_versions[q] ?? 0);
    _store.applyPage(q, page, evict: settled);
    _set(q, QueryFreshness(known: true, stale: !settled, fetchedAt: _now()));
    if (settled) onSettled?.call();
    if (q.queue == ObligationQueue.waiting) {
      await _readBlockers(page.obligations, current);
      if (current() && startedAt == (_versions[q] ?? 0)) onSettled?.call();
    }
  }

  /// Reads each waiting row's blocking children after the rows are shown; a
  /// failed detail leaves that row as it was for the next refresh.
  Future<void> _readBlockers(
    List<ObligationDto> waiting,
    bool Function() current,
  ) async {
    final details = await Future.wait(
      waiting.map(
        (o) => _api
            .fetchObligationDetail(o.id)
            .then<List<ObligationDto>?>(
              (d) => d.blockingChildren,
              onError: (Object _) => null,
            ),
      ),
    );
    if (!current()) return;
    for (var i = 0; i < waiting.length; i++) {
      if (details[i] case final children?) {
        _store.setBlockers(waiting[i].id, children);
      }
    }
  }

  void _bump(ObligationQuery q) => _versions[q] = (_versions[q] ?? 0) + 1;

  void _set(ObligationQuery q, QueryFreshness f) =>
      _setAll({..._freshness.value, q: f});

  void _setAll(Map<ObligationQuery, QueryFreshness> all) {
    if (!_freshness.isClosed) _freshness.add(all);
  }
}
