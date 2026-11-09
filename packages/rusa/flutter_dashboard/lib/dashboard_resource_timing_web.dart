import 'dart:collection';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'dashboard_resource_timing.dart';

/// Recent `fetch` entries only; enough to cover one interaction's requests.
const _maxRecentEntries = 128;

DashboardResourceTimingSource? _source;
bool _attempted = false;

/// The page's Resource Timing source, or null when the browser offers none.
///
/// It reads a `PerformanceObserver` rather than the performance buffer: the
/// buffer stops accepting entries once full (250 by default), which a
/// long-lived dashboard tab reaches, while an observer receives every entry.
DashboardResourceTimingSource? defaultDashboardResourceTimingSource() {
  if (_attempted) return _source;
  _attempted = true;
  try {
    _source = _ObservedResourceTiming();
  } catch (_) {
    // Timing is diagnostic: an unsupported browser just records no phases.
    _source = null;
  }
  return _source;
}

class _ObservedResourceTiming implements DashboardResourceTimingSource {
  _ObservedResourceTiming() {
    _observer = web.PerformanceObserver(
      ((web.PerformanceObserverEntryList list, web.PerformanceObserver _) {
        _keep(list.getEntries());
      }).toJS,
    );
    _observer.observe(web.PerformanceObserverInit(type: 'resource'));
  }

  late final web.PerformanceObserver _observer;
  final _recent = ListQueue<DashboardResourceTimingEntry>();

  void _keep(JSArray<web.PerformanceEntry> entries) {
    for (final raw in entries.toDart) {
      final entry = raw as web.PerformanceResourceTiming;
      if (entry.initiatorType != 'fetch') continue;
      _recent.addLast(
        DashboardResourceTimingEntry(
          name: entry.name,
          startTime: entry.startTime,
          fetchStart: entry.fetchStart,
          connectStart: entry.connectStart,
          connectEnd: entry.connectEnd,
          requestStart: entry.requestStart,
          responseStart: entry.responseStart,
          responseEnd: entry.responseEnd,
        ),
      );
      if (_recent.length > _maxRecentEntries) _recent.removeFirst();
    }
  }

  @override
  double now() => web.window.performance.now();

  @override
  DashboardRequestPhases? phasesFor(
    Uri url, {
    required double dispatchedAt,
    required double completedAt,
  }) {
    // Entries already queued for the observer but not yet delivered to its
    // callback would otherwise be missed by a lookup made right after a body.
    _keep(_observer.takeRecords());
    return matchResourceTiming(
      _recent,
      url: url,
      dispatchedAt: dispatchedAt,
      completedAt: completedAt,
    );
  }
}
