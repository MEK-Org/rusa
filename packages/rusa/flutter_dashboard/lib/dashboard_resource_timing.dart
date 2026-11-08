/// Browser Resource Timing phases for one timed dashboard request.
///
/// This file is platform-neutral so headless tests can exercise phase
/// extraction and matching with fake entries. The browser source lives in
/// `dashboard_resource_timing_web.dart`; off the browser there is none.
library;

export 'dashboard_resource_timing_stub.dart'
    if (dart.library.html) 'dashboard_resource_timing_web.dart'
    show defaultDashboardResourceTimingSource;

const _maxPhaseMs = 86_400_000;

/// Browsers may coarsen `performance.now()`; this keeps a correctly ordered
/// entry from falling just outside its request window.
const _windowSlackMs = 1.0;

/// Durations only, as integer milliseconds. The URL that located the entry is
/// never part of this value, so it cannot reach a timing receipt.
class DashboardRequestPhases {
  const DashboardRequestPhases({
    required this.queueMs,
    required this.connectMs,
    required this.firstByteMs,
    required this.bodyMs,
  });

  /// `fetchStart` → `requestStart`: connection-pool wait, DNS and connect.
  final int queueMs;

  /// `connectStart` → `connectEnd`, TLS included; 0 on a reused connection.
  /// This interval lies inside [queueMs], so the two are never added.
  final int connectMs;

  /// `requestStart` → `responseStart`: time to the first response byte.
  final int firstByteMs;

  /// `responseStart` → `responseEnd`: the browser receiving the body.
  final int bodyMs;

  Map<String, int> toJson() => {
    'queueMs': queueMs,
    'connectMs': connectMs,
    'firstByteMs': firstByteMs,
    'bodyMs': bodyMs,
  };
}

/// The fields of one `PerformanceResourceTiming` entry this file reads, in the
/// page's `performance.now()` time base.
class DashboardResourceTimingEntry {
  const DashboardResourceTimingEntry({
    required this.name,
    required this.startTime,
    required this.fetchStart,
    required this.connectStart,
    required this.connectEnd,
    required this.requestStart,
    required this.responseStart,
    required this.responseEnd,
  });

  /// The request URL. Used only to find the entry, then discarded.
  final String name;
  final double startTime;
  final double fetchStart;
  final double connectStart;
  final double connectEnd;
  final double requestStart;
  final double responseStart;
  final double responseEnd;
}

int? _span(double from, double to) {
  if (!from.isFinite || !to.isFinite || to < from) return null;
  final ms = (to - from).round();
  return ms > _maxPhaseMs ? _maxPhaseMs : ms;
}

/// Phases of [entry], or null when the browser withheld or could not order
/// them. A zero `requestStart` or `responseStart` is how the browser reports
/// detailed timing as unavailable, so no phase is invented from it.
DashboardRequestPhases? phasesFromResourceTiming(
  DashboardResourceTimingEntry entry,
) {
  if (entry.requestStart <= 0 || entry.responseStart <= 0) return null;
  final queueMs = _span(entry.fetchStart, entry.requestStart);
  final connectMs = _span(entry.connectStart, entry.connectEnd);
  final firstByteMs = _span(entry.requestStart, entry.responseStart);
  final bodyMs = _span(entry.responseStart, entry.responseEnd);
  if (queueMs == null ||
      connectMs == null ||
      firstByteMs == null ||
      bodyMs == null) {
    return null;
  }
  return DashboardRequestPhases(
    queueMs: queueMs,
    connectMs: connectMs,
    firstByteMs: firstByteMs,
    bodyMs: bodyMs,
  );
}

/// Phases of the single entry for [url] that started and finished inside the
/// request's own `[dispatchedAt, completedAt]` window. Two candidates (the
/// same URL fetched concurrently) are ambiguous, so neither is attributed.
DashboardRequestPhases? matchResourceTiming(
  Iterable<DashboardResourceTimingEntry> entries, {
  required Uri url,
  required double dispatchedAt,
  required double completedAt,
}) {
  final name = url.toString();
  DashboardResourceTimingEntry? match;
  for (final entry in entries) {
    if (entry.name != name ||
        entry.startTime < dispatchedAt - _windowSlackMs ||
        entry.responseEnd > completedAt + _windowSlackMs) {
      continue;
    }
    if (match != null) return null;
    match = entry;
  }
  return match == null ? null : phasesFromResourceTiming(match);
}

/// Where a timed request's browser phases come from.
abstract interface class DashboardResourceTimingSource {
  /// The current time in the entries' time base.
  double now();

  /// Phases for the request to [url] timed over `[dispatchedAt, completedAt]`,
  /// or null when no single entry matches yet.
  DashboardRequestPhases? phasesFor(
    Uri url, {
    required double dispatchedAt,
    required double completedAt,
  });
}
