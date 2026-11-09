import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/dashboard_resource_timing.dart';
import 'package:rusa_dashboard/dashboard_timing.dart';

const _requestId = '123e4567-e89b-42d3-a456-426614174000';
final _base = Uri.parse('https://dashboard.example/');
final _listUrl = _base.resolve('/api/mesh/obligations?owner=private-actor');

DashboardResourceTimingEntry _entry({
  String? name,
  double startTime = 1001,
  double fetchStart = 1001,
  double connectStart = 1001,
  double connectEnd = 1001,
  double requestStart = 1003.4,
  double responseStart = 1006.6,
  double responseEnd = 1008,
}) => DashboardResourceTimingEntry(
  name: name ?? _listUrl.toString(),
  startTime: startTime,
  fetchStart: fetchStart,
  connectStart: connectStart,
  connectEnd: connectEnd,
  requestStart: requestStart,
  responseStart: responseStart,
  responseEnd: responseEnd,
);

/// Clock starts at 1000 and advances 10 ms per read: dispatch reads 1000 and
/// body completion reads 1010, the window the matching entries fall inside.
class _FakeResourceTiming implements DashboardResourceTimingSource {
  final entries = <DashboardResourceTimingEntry>[];
  double _clock = 990;

  @override
  double now() => _clock += 10;

  @override
  DashboardRequestPhases? phasesFor(
    Uri url, {
    required double dispatchedAt,
    required double completedAt,
  }) => matchResourceTiming(
    entries,
    url: url,
    dispatchedAt: dispatchedAt,
    completedAt: completedAt,
  );
}

Future<Map<String, dynamic>> _measureListGet(
  _FakeResourceTiming source, {
  void Function()? afterBody,
}) async {
  final receipt = Completer<Map<String, dynamic>>();
  final client = DashboardTimingClient(
    MockClient((request) async {
      if (request.url.path == '/api/dashboard/timing') {
        receipt.complete(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{"accepted":true}', 202);
      }
      return http.Response(
        '[]',
        200,
        headers: const {'X-Rusa-Request-Id': _requestId},
      );
    }),
    resourceTiming: source,
  );
  addTearDown(client.close);
  final reporter = DashboardTimingReporter(client: client, base: _base);
  await reporter.measure(DashboardInteraction.primaryNavigation, () async {
    await client.get(_listUrl);
    afterBody?.call();
  });
  return receipt.future.timeout(const Duration(seconds: 2));
}

void main() {
  group('phasesFromResourceTiming', () {
    test('splits one entry into rounded integer phases', () {
      final phases = phasesFromResourceTiming(
        _entry(
          fetchStart: 100,
          connectStart: 100.2,
          connectEnd: 140.9,
          requestStart: 1100.4,
          responseStart: 1393.5,
          responseEnd: 1401.2,
        ),
      )!;
      expect(phases.toJson(), {
        'queueMs': 1000,
        'connectMs': 41,
        'firstByteMs': 293,
        'bodyMs': 8,
      });
      // A reused connection reports zero connect time.
      expect(phasesFromResourceTiming(_entry())!.connectMs, 0);
    });

    test('invents nothing from withheld or out-of-order timestamps', () {
      expect(phasesFromResourceTiming(_entry(requestStart: 0)), isNull);
      expect(phasesFromResourceTiming(_entry(responseStart: 0)), isNull);
      expect(
        phasesFromResourceTiming(
          _entry(responseStart: 1009, responseEnd: 1008),
        ),
        isNull,
      );
    });
  });

  group('matchResourceTiming', () {
    DashboardRequestPhases? match(List<DashboardResourceTimingEntry> entries) =>
        matchResourceTiming(
          entries,
          url: _listUrl,
          dispatchedAt: 1000,
          completedAt: 1010,
        );

    test('finds the single entry for the URL inside the request window', () {
      expect(match([_entry(name: '${_base}other'), _entry()]), isNotNull);
    });

    test('ignores same-URL entries from outside the request window', () {
      expect(
        match([
          _entry(startTime: 980, responseEnd: 990),
          _entry(startTime: 1005, responseEnd: 1020),
        ]),
        isNull,
      );
    });

    test('attributes nothing when the URL was fetched concurrently', () {
      expect(match([_entry(), _entry(startTime: 1002)]), isNull);
    });
  });

  group('DashboardTimingClient', () {
    test('adds browser phases to the paired request timing only', () async {
      final source = _FakeResourceTiming()..entries.add(_entry());
      final receipt = await _measureListGet(source);

      expect(receipt['requestTimings'], [
        {
          'requestId': _requestId,
          'requestMs': isA<int>(),
          'queueMs': 2,
          'connectMs': 0,
          'firstByteMs': 3,
          'bodyMs': 1,
        },
      ]);
      final encoded = jsonEncode(receipt);
      expect(encoded, isNot(contains('obligations')));
      expect(encoded, isNot(contains('private-actor')));
      expect(encoded, isNot(contains('dashboard.example')));
    });

    test(
      'picks up an entry reported after the body, before the interaction ends',
      () async {
        final source = _FakeResourceTiming();
        final receipt = await _measureListGet(
          source,
          afterBody: () => source.entries.add(_entry()),
        );

        final timing =
            (receipt['requestTimings'] as List).single as Map<String, dynamic>;
        expect(timing['firstByteMs'], 3);
      },
    );

    test('keeps the existing timing shape when no entry matches', () async {
      final receipt = await _measureListGet(_FakeResourceTiming());

      expect(receipt['requestTimings'], [
        {'requestId': _requestId, 'requestMs': isA<int>()},
      ]);
    });
  });
}
