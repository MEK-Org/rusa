import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Fixed client interaction names accepted by the bounded dashboard timing API.
/// They deliberately carry no route, actor, obligation, or user identity.
enum DashboardInteraction {
  initialLoad('initial_load'),
  primaryNavigation('primary_navigation'),
  actorDetail('actor_detail'),
  obligationDetail('obligation_detail'),
  obligationStatus('obligation_status'),
  obligationSnooze('obligation_snooze'),
  actorInterrupt('actor_interrupt'),
  dashboardMutation('dashboard_mutation');

  const DashboardInteraction(this.wireName);
  final String wireName;
}

const _maxRequestIds = 32;
const _maxDurationMs = 86_400_000;
final _timingContextKey = Object();
final _uuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  caseSensitive: false,
);

class _TimingContext {
  _TimingContext(this.interaction) : stopwatch = Stopwatch()..start();

  final DashboardInteraction interaction;
  final Stopwatch stopwatch;
  final Set<String> requestIds = <String>{};
  final Map<String, int> requestTimings = <String, int>{};

  bool addRequestId(String? value) {
    if (value == null || !_uuidPattern.hasMatch(value)) return false;
    if (requestIds.contains(value)) return true;
    if (requestIds.length >= _maxRequestIds) return false;
    requestIds.add(value);
    return true;
  }

  void addRequestTiming(String requestId, int requestMs) {
    if (requestIds.contains(requestId)) {
      requestTimings.putIfAbsent(
        requestId,
        () => requestMs.clamp(0, _maxDurationMs),
      );
    }
  }
}

/// Captures only a dashboard response's opaque correlation header while an
/// explicitly named interaction is in flight. The request URL stays local.
class DashboardTimingClient extends http.BaseClient {
  DashboardTimingClient(this._inner);

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final context = Zone.current[_timingContextKey] as _TimingContext?;
    final requestStopwatch =
        context != null && request.url.path != '/api/dashboard/timing'
        ? (Stopwatch()..start())
        : null;
    final response = await _inner.send(request);
    final requestId = response.headers.entries
        .where((entry) => entry.key.toLowerCase() == 'x-rusa-request-id')
        .map((entry) => entry.value)
        .firstOrNull;
    if (context == null ||
        requestStopwatch == null ||
        !context.addRequestId(requestId)) {
      return response;
    }

    var recorded = false;
    void recordBodyConsumed() {
      if (recorded || requestId == null) return;
      recorded = true;
      requestStopwatch.stop();
      // `Stopwatch` is monotonic. Stopping in the response stream's terminal
      // handler deliberately excludes decode/store/render work after the body.
      context.addRequestTiming(requestId, requestStopwatch.elapsedMilliseconds);
    }

    final timedStream = response.stream.transform(
      StreamTransformer<List<int>, List<int>>.fromHandlers(
        handleData: (data, sink) => sink.add(data),
        handleError: (error, stackTrace, sink) {
          recordBodyConsumed();
          sink.addError(error, stackTrace);
        },
        handleDone: (sink) {
          recordBodyConsumed();
          sink.close();
        },
      ),
    );
    return http.StreamedResponse(
      timedStream,
      response.statusCode,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  @override
  void close() => _inner.close();
}

/// Posts one best-effort, content-free interaction receipt after its work ends.
class DashboardTimingReporter {
  DashboardTimingReporter({required http.Client client, required Uri base})
    : _client = client,
      _timingUri = base.resolve('/api/dashboard/timing');

  final http.Client _client;
  final Uri _timingUri;

  Future<T> measure<T>(
    DashboardInteraction interaction,
    Future<T> Function() action,
  ) {
    final context = _TimingContext(interaction);
    return runZoned(() async {
      try {
        final result = await action();
        context.stopwatch.stop();
        unawaited(_post(context, 'success'));
        return result;
      } catch (_) {
        context.stopwatch.stop();
        unawaited(_post(context, 'failure'));
        rethrow;
      }
    }, zoneValues: {_timingContextKey: context});
  }

  Future<void> _post(_TimingContext context, String outcome) async {
    try {
      await _client.post(
        _timingUri,
        headers: const {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'interaction': context.interaction.wireName,
          'durationMs': context.stopwatch.elapsedMilliseconds.clamp(
            0,
            _maxDurationMs,
          ),
          'requestIds': context.requestIds.toList(growable: false),
          if (context.requestTimings.isNotEmpty)
            'requestTimings': context.requestTimings.entries
                .map(
                  (entry) => {'requestId': entry.key, 'requestMs': entry.value},
                )
                .toList(growable: false),
          'outcome': outcome,
        }),
      );
    } catch (_) {
      // Timing is diagnostic: it must never alter the operation it observed.
    }
  }
}
