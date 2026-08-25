import 'models.dart';

/// One rendered row in the Events Log. Usually a single [MeshEvent], but a
/// `run_end` that was preceded by its run's own `run_yielded` is coalesced into
/// a single row carrying both (ISSUE_NUM item 6).
class EventRow {
  const EventRow(this.primary, [this.yielded]);

  /// The event this row is anchored on. For a coalesced row this is the
  /// `run_end` (the run's terminal moment); for everything else it's the event
  /// itself.
  final MeshEvent primary;

  /// The merged `run_yielded` for a coalesced row, else null.
  final MeshEvent? yielded;

  bool get isCoalesced => yielded != null;

  /// The yield status ("complete" | "blocked") when coalesced, else null.
  String? get yieldStatus => yielded?.detail;
}

/// Status strings a live `run_yielded` carries (see `actor-mesh.ts declareYield`).
/// A yield to a non-live actor instead carries a "dropped — no live actor"
/// detail and has *no* paired `run_end` (no run happened) — so it is never
/// coalesced.
const _kYieldStatuses = {'complete', 'blocked'};

/// Coalesce adjacent `run_yielded` + `run_end` pairs for the same actor into one
/// row. Input is the store's newest-first event list (server order = rowid desc).
///
/// Why this is safe as a pure presentation pass (confirmed with the mesh elder):
///   • `run_yielded` is recorded mid-turn by the `yield_run` tool; `run_end` is
///     recorded after the provider run returns — so `run_yielded` always has a
///     *strictly newer* `run_end` for that actor (yield rowid < end rowid). In a
///     newest-first list the `run_end` therefore sits *above* (before) its yield.
///   • The TriggerRunner is single-flight, so an actor's runs never overlap.
///     There is no run-id on events, but non-overlap makes a `run_yielded`
///     pair unambiguously with that same actor's next `run_end`.
///   • The implication is one-way: every `run_yielded` has a following
///     `run_end`, NOT vice-versa (the root never yields; auto-continued, capped,
///     and failed runs are `run_end`-only). So only the explicit-yield case
///     merges — every other `run_end` stays a standalone row.
///
/// Pairing keys off actorId + run-boundary scanning (NOT global list adjacency:
/// the timeline is global and other actors' events interleave between an actor's
/// yield and end). We re-coalesce the whole accumulated list on every render, so
/// a pair split across a pagination boundary self-heals when the next page loads
/// (the older `run_yielded` page appends and the `run_end` above it merges) —
/// no half-pair is ever rendered as a permanent state.
List<EventRow> coalesceRunEvents(List<MeshEvent> events) {
  final consumed = List<bool>.filled(events.length, false);
  final rows = <EventRow>[];
  for (var i = 0; i < events.length; i++) {
    if (consumed[i]) continue;
    final e = events[i];
    if (e.kind == 'run_end' && e.actorId != null) {
      final j = _pairedYieldIndex(events, i, consumed);
      if (j != null) {
        consumed[j] = true;
        rows.add(EventRow(e, events[j]));
        continue;
      }
    }
    rows.add(EventRow(e));
  }
  return rows;
}

/// Index of the `run_yielded` belonging to the run that ended at [endIdx], or
/// null if that run had no yield. Scans toward older events (higher index) for
/// the same actor, stopping at the run's own boundary so we never pair across
/// runs.
int? _pairedYieldIndex(
  List<MeshEvent> events,
  int endIdx,
  List<bool> consumed,
) {
  final actor = events[endIdx].actorId;
  for (var j = endIdx + 1; j < events.length; j++) {
    if (consumed[j]) continue;
    final e = events[j];
    if (e.actorId != actor) continue; // other actors interleave — skip
    switch (e.kind) {
      case 'run_yielded':
        // This run's terminal yield → pair. A "dropped" yield (no run) is not a
        // boundary and not a pair; keep scanning past it.
        if (_kYieldStatuses.contains(e.detail)) return j;
        continue;
      case 'run_end':
      case 'run_start':
      case 'run_continued':
      case 'continuation_capped':
        return null; // hit an earlier run's boundary — this run_end had no yield
      default:
        continue; // unrelated same-actor event (e.g. a message to this actor)
    }
  }
  return null;
}
