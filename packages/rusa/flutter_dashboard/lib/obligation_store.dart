import 'dart:async';

import 'package:rxdart/rxdart.dart';

import 'models.dart';

/// One section of an owner's queue, as `GET /api/mesh/obligations?queue=`
/// pages it. Snoozed rows sit in [waiting], never in [ready] or [scheduled].
enum ObligationQueue { ready, waiting, scheduled }

/// An owner's queue section: which obligations it holds and in what order,
/// mirroring the server's queue predicates and owner-queue order so a page of
/// it can be checked against what the store already knows.
class ObligationQuery {
  const ObligationQuery({required this.ownerId, required this.queue});

  final String ownerId;
  final ObligationQueue queue;

  bool matches(ObligationDto o) =>
      o.ownerId == ownerId &&
      switch (queue) {
        ObligationQueue.ready => o.isReady,
        ObligationQueue.waiting => o.isWaiting,
        ObligationQueue.scheduled => o.isScheduled,
      };

  /// The server's owner-queue order within one section: responsive ready
  /// work first, then effective priority, then id.
  int compare(ObligationDto a, ObligationDto b) {
    if (queue == ObligationQueue.ready &&
        a.effectiveResponsive != b.effectiveResponsive) {
      return a.effectiveResponsive ? -1 : 1;
    }
    final byPriority = a.effectivePriority.compareTo(b.effectivePriority);
    return byPriority != 0 ? byPriority : a.id.compareTo(b.id);
  }

  String get key => '${queue.name}:$ownerId';

  @override
  bool operator ==(Object other) =>
      other is ObligationQuery &&
      other.ownerId == ownerId &&
      other.queue == queue;

  @override
  int get hashCode => Object.hash(ownerId, queue);

  @override
  String toString() => 'ObligationQuery($key)';
}

/// What the store knows at one instant: every obligation it holds by id, and
/// the blocking children of the obligations whose detail it has read.
class ObligationEntities {
  const ObligationEntities({this.byId = const {}, this.blockers = const {}});

  final Map<String, ObligationDto> byId;

  /// Obligation id -> ids of its blocking children, in the detail's order. An
  /// obligation without an entry has not had its blockers read.
  final Map<String, List<String>> blockers;

  /// The obligations [query] holds, in its order.
  List<ObligationDto> select(ObligationQuery query) =>
      byId.values.where(query.matches).toList()..sort(query.compare);

  /// The blocking children recorded for [id], or null if none were read.
  /// A child the store no longer holds is left out.
  List<ObligationDto>? blockersOf(String id) =>
      blockers[id]?.map((c) => byId[c]).nonNulls.toList();
}

/// The rows of a set of queries plus the recorded blockers of those rows:
/// what a view subscribed to those queries renders.
class ObligationProjection {
  const ObligationProjection(this.rows, this.blockers);

  factory ObligationProjection.of(
    ObligationEntities entities,
    Iterable<ObligationQuery> queries,
  ) {
    final rows = {for (final q in queries) q: entities.select(q)};
    return ObligationProjection(rows, {
      for (final o in rows.values.expand((r) => r))
        o.id: ?entities.blockersOf(o.id),
    });
  }

  final Map<ObligationQuery, List<ObligationDto>> rows;
  final Map<String, List<ObligationDto>> blockers;

  List<ObligationDto> of(ObligationQuery query) => rows[query] ?? const [];

  /// Whether nothing either projection shows differs: same rows, by identity,
  /// in the same order, with the same blockers.
  bool sameAs(ObligationProjection other) {
    bool same(List<ObligationDto>? a, List<ObligationDto>? b) {
      if (a == null || b == null || a.length != b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!identical(a[i], b[i])) return false;
      }
      return true;
    }

    return rows.length == other.rows.length &&
        rows.keys.every((q) => same(rows[q], other.rows[q])) &&
        blockers.length == other.blockers.length &&
        blockers.keys.every((id) => same(blockers[id], other.blockers[id]));
  }
}

/// The dashboard's shared obligation store (#992): one observable map from
/// obligation id to the latest obligation object any view's request returned.
/// Views subscribe to projections of it ([watch]); requests, and the policy
/// for when to send them, belong to [ObligationSync], which writes its
/// responses here so a refresh behind one view updates every other.
///
/// It holds a single viewer's knowledge: [reset] replaces it wholesale when
/// the viewing principal changes.
class ObligationStore {
  final _entities = BehaviorSubject<ObligationEntities>.seeded(
    const ObligationEntities(),
  );
  final Map<ObligationQuery, int> _watchers = {};

  ValueStream<ObligationEntities> get entities => _entities.stream;
  ObligationEntities get current => _entities.value;
  ObligationDto? operator [](String id) => _entities.value.byId[id];

  /// The projection of [queries], re-emitted whenever what it shows changes.
  /// It may be listened to more than once, as a remounted view does; while
  /// any listener remains, each query counts as watched ([isWatched]).
  Stream<ObligationProjection> watch(List<ObligationQuery> queries) =>
      Stream.multi((out) {
        for (final q in queries) {
          _watchers.update(q, (n) => n + 1, ifAbsent: () => 1);
        }
        final sub = _entities
            .map((e) => ObligationProjection.of(e, queries))
            .distinct((a, b) => a.sameAs(b))
            .listen(out.add, onError: out.addError, onDone: out.close);
        out.onCancel = () {
          for (final q in queries) {
            final n = (_watchers[q] ?? 1) - 1;
            if (n <= 0) {
              _watchers.remove(q);
            } else {
              _watchers[q] = n;
            }
          }
          return sub.cancel();
        };
      });

  /// Whether a view is subscribed to [query] right now.
  bool isWatched(ObligationQuery query) => _watchers.containsKey(query);

  /// Writes [obligations] over what the store holds. A stored row whose
  /// `updatedAt` is strictly later than the incoming one is kept, so a
  /// response that left the server before a change cannot undo it.
  void upsert(Iterable<ObligationDto> obligations) =>
      _write((byId, _) => _upsertInto(byId, obligations));

  /// Applies one page of [query] in server order. Its rows are upserted.
  /// When [evict] is set, an obligation the store has under [query] that the
  /// page left out is dropped, as long as the server would have ordered it
  /// within the page: every one when the page is the whole query, and only
  /// those ordered before its last row when more follow. Its current state is
  /// unknown, so the store forgets it rather than keep it where it is not;
  /// whatever sits past a partial page is left alone.
  void applyPage(
    ObligationQuery query,
    ObligationPage page, {
    required bool evict,
  }) => _write((byId, blockers) {
    final rows = page.obligations;
    if (evict) {
      final returned = {for (final o in rows) o.id};
      final last = page.hasMore && rows.isNotEmpty ? rows.last : null;
      final stale = [
        for (final o in byId.values)
          if (query.matches(o) &&
              !returned.contains(o.id) &&
              (!page.hasMore || (last != null && query.compare(o, last) < 0)))
            o.id,
      ];
      for (final id in stale) {
        byId.remove(id);
        blockers.remove(id);
      }
    }
    _upsertInto(byId, rows);
  });

  /// Records [children] as [id]'s blocking children and upserts them.
  void setBlockers(String id, List<ObligationDto> children) =>
      _write((byId, blockers) {
        _upsertInto(byId, children);
        blockers[id] = [for (final c in children) c.id];
      });

  /// Replaces everything the store holds, as on a change of viewer.
  void reset([ObligationEntities seed = const ObligationEntities()]) {
    if (!_entities.isClosed) _entities.add(seed);
  }

  Future<void> close() => _entities.close();

  void _write(
    void Function(
      Map<String, ObligationDto> byId,
      Map<String, List<String>> blockers,
    )
    change,
  ) {
    if (_entities.isClosed) return;
    final before = _entities.value;
    final byId = Map.of(before.byId);
    final blockers = Map.of(before.blockers);
    change(byId, blockers);
    _entities.add(ObligationEntities(byId: byId, blockers: blockers));
  }

  static void _upsertInto(
    Map<String, ObligationDto> byId,
    Iterable<ObligationDto> obligations,
  ) {
    for (final o in obligations) {
      final held = byId[o.id];
      if (held == null || !_isNewer(held, than: o)) byId[o.id] = o;
    }
  }

  /// Whether [a] was written strictly after [than]. Rows without a parseable
  /// stamp never count as newer, so the incoming row wins.
  static bool _isNewer(ObligationDto a, {required ObligationDto than}) {
    final at = DateTime.tryParse(a.updatedAt ?? '');
    final other = DateTime.tryParse(than.updatedAt ?? '');
    return at != null && other != null && at.isAfter(other);
  }
}
