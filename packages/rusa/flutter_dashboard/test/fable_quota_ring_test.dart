import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// #752: Fable gets its own header ring beside Claude's, driven only by the
// model-scoped Fable window and never by (or in place of) Claude's own.
//
// Same convention as widget_test.dart: the store does real async I/O, so drive
// inside tester.runAsync and pump fixed durations.

const _weekMs = 604800000;

String _iso(DateTime t) => t.toUtc().toIso8601String();

QuotaWindowDto _claudeWeekly({required DateTime now, double used = 40}) =>
    QuotaWindowDto(
      id: 'weekly',
      label: 'Current week (all models)',
      usedPercent: used,
      status: 'available',
      headline: true,
      windowMs: _weekMs,
      resetAtIso: _iso(now.add(const Duration(days: 3))),
      scrapedAt: _iso(now.subtract(const Duration(minutes: 5))),
    );

QuotaWindowDto _claudeSession({required DateTime now}) => QuotaWindowDto(
  id: 'session',
  label: 'Current session',
  usedPercent: 20,
  status: 'available',
  headline: false,
  windowMs: 18000000,
  scrapedAt: _iso(now.subtract(const Duration(minutes: 5))),
);

QuotaWindowDto _fableWeekly({
  required DateTime now,
  double used = 75,
  List<String> modelIds = const ['claude-fable-5-1'],
  Duration resetIn = const Duration(days: 4),
  Duration scrapedAgo = const Duration(minutes: 5),
  bool estimated = false,
}) => QuotaWindowDto(
  id: 'weekly',
  label: 'Current week (Fable)',
  usedPercent: used,
  status: 'available',
  headline: true,
  windowMs: _weekMs,
  resetAtIso: _iso(now.add(resetIn)),
  scrapedAt: _iso(now.subtract(scrapedAgo)),
  modelIds: modelIds,
  estimated: estimated,
);

QuotaSnapshotDto _snapshot({
  required List<QuotaWindowDto> claudeWindows,
  List<QuotaWindowDto> modelWindows = const [],
  bool withCodex = true,
}) => QuotaSnapshotDto(
  generatedAt: '2026-09-28T14:00:00.000Z',
  providers: [
    ProviderQuotaDto(
      provider: 'claude',
      status: 'available',
      usedPercent: null,
      tier: null,
      message: null,
      windows: claudeWindows,
      modelWindows: modelWindows,
    ),
    if (withCodex)
      const ProviderQuotaDto(
        provider: 'codex',
        status: 'available',
        usedPercent: 30,
        tier: null,
        message: null,
        windows: [
          QuotaWindowDto(
            id: 'weekly',
            label: 'Weekly',
            usedPercent: 30,
            status: 'available',
            headline: true,
            windowMs: _weekMs,
          ),
        ],
      ),
  ],
);

Future<DashboardStore> _pumpRings(
  WidgetTester tester,
  QuotaSnapshotDto snapshot,
) async {
  final api = FakeApi()
    ..threadsResult = [makeThread('root', created: 't0')]
    ..quotaResult = snapshot;
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.init();
  await store.refreshQuota();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: QuotaIndicators(store: store)),
    ),
  );
  await tester.pump(const Duration(milliseconds: 50));
  return store;
}

Finder _staleWarning(String name) => find.descendant(
  of: _ringTooltip(name),
  matching: find.byKey(const ValueKey('quota-ring-stale-warning')),
);

Finder _ringTooltip(String name) => find.byWidgetPredicate(
  (w) => w is Tooltip && (w.message ?? '').startsWith('$name\n'),
);

String _tooltipOf(WidgetTester tester, String name) =>
    tester.widget<Tooltip>(_ringTooltip(name)).message!;

/// The outer (weekly) ring's fill fraction for the ring labelled [name].
double? _outerRingValue(WidgetTester tester, String name) => tester
    .widgetList<CircularProgressIndicator>(
      find.descendant(
        of: _ringTooltip(name),
        matching: find.byType(CircularProgressIndicator),
      ),
    )
    .first
    .value;

void main() {
  group('Fable header ring (#752)', () {
    testWidgets('shows Claude and Fable weekly readings on separate rings', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await _pumpRings(
          tester,
          _snapshot(
            claudeWindows: [
              _claudeSession(now: now),
              _claudeWeekly(now: now),
            ],
            modelWindows: [_fableWeekly(now: now)],
          ),
        );

        final labels = tester
            .widgetList<Text>(find.byType(Text))
            .map((t) => t.data)
            .toList();
        expect(labels, ['Claude', 'Fable', 'Codex']);

        expect(_outerRingValue(tester, 'Claude'), closeTo(0.60, 1e-9));
        expect(_outerRingValue(tester, 'Fable'), closeTo(0.25, 1e-9));

        final claudeTip = _tooltipOf(tester, 'Claude');
        final fableTip = _tooltipOf(tester, 'Fable');
        expect(claudeTip, contains('Current week (all models): 60% quota'));
        expect(claudeTip, isNot(contains('Fable')));
        expect(fableTip, contains('Current week (Fable): 25% quota'));
        expect(fableTip, contains('resets '));
        expect(fableTip, contains('as of '));
        expect(fableTip, isNot(contains('all models')));

        // The label is styled like every other ring label (#758); semantics
        // name it too.
        TextStyle? labelStyle(String name) =>
            tester.widget<Text>(find.text(name)).style;
        expect(labelStyle('Fable'), labelStyle('Claude'));
        expect(labelStyle('Fable'), labelStyle('Codex'));
        expect(labelStyle('Fable')?.color, isNot(MeshColors.fable));
        expect(find.bySemanticsLabel(RegExp(r'^Fable\n')), findsOneWidget);
        // Only Claude's ring has an inner session ring.
        expect(
          find.descendant(
            of: _ringTooltip('Fable'),
            matching: find.byType(CircularProgressIndicator),
          ),
          findsOneWidget,
        );
        await store.dispose();
      });
    });

    testWidgets('never fills a missing Claude weekly with Fable\'s', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await _pumpRings(
          tester,
          _snapshot(
            claudeWindows: [_claudeSession(now: now)],
            modelWindows: [_fableWeekly(now: now)],
          ),
        );

        expect(_outerRingValue(tester, 'Claude'), 0.0);
        expect(_tooltipOf(tester, 'Claude'), contains('Weekly: n/a'));
        expect(_outerRingValue(tester, 'Fable'), closeTo(0.25, 1e-9));
        await store.dispose();
      });
    });

    testWidgets('reads unknown, not live, when no Fable window is known', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await _pumpRings(
          tester,
          _snapshot(
            claudeWindows: [
              _claudeSession(now: now),
              _claudeWeekly(now: now),
            ],
          ),
        );

        expect(_outerRingValue(tester, 'Fable'), 0.0);
        final tip = _tooltipOf(tester, 'Fable');
        expect(tip, 'Fable\nWeekly: n/a');
        // Claude's own reading is untouched.
        expect(_outerRingValue(tester, 'Claude'), closeTo(0.60, 1e-9));
        await store.dispose();
      });
    });

    testWidgets('reads unknown when the Fable identity is ambiguous', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await _pumpRings(
          tester,
          _snapshot(
            claudeWindows: [_claudeWeekly(now: now)],
            modelWindows: [
              _fableWeekly(now: now, used: 10),
              _fableWeekly(now: now, used: 90, modelIds: ['claude-fable-5']),
              // A window naming Fable and another model is not Fable's own.
              _fableWeekly(
                now: now,
                used: 50,
                modelIds: ['claude-fable-5-1', 'claude-opus-5-5'],
              ),
            ],
          ),
        );

        expect(_outerRingValue(tester, 'Fable'), 0.0);
        expect(_tooltipOf(tester, 'Fable'), 'Fable\nWeekly: n/a');
        await store.dispose();
      });
    });

    testWidgets('a model window for another model is not Fable', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await _pumpRings(
          tester,
          _snapshot(
            claudeWindows: [_claudeWeekly(now: now)],
            modelWindows: [
              _fableWeekly(now: now, modelIds: ['claude-opus-5-5']),
            ],
          ),
        );

        expect(_tooltipOf(tester, 'Fable'), 'Fable\nWeekly: n/a');
        await store.dispose();
      });
    });

    testWidgets('an expired Fable window reads reset, not its old percentage', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await _pumpRings(
          tester,
          _snapshot(
            claudeWindows: [_claudeWeekly(now: now)],
            modelWindows: [
              _fableWeekly(
                now: now,
                resetIn: const Duration(hours: -2),
                scrapedAgo: const Duration(days: 2),
              ),
            ],
          ),
        );

        expect(_outerRingValue(tester, 'Fable'), 0.0);
        final tip = _tooltipOf(tester, 'Fable');
        expect(tip, contains('window reset at'));
        expect(tip, contains('no fresh read since'));
        expect(tip, isNot(contains('25%')));
        expect(tip, contains('(2d ago)'));
        await store.dispose();
      });
    });

    testWidgets('leaves Claude pacing out of the Fable tooltip', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final base = _snapshot(
          claudeWindows: [_claudeWeekly(now: now)],
          modelWindows: [_fableWeekly(now: now)],
          withCodex: false,
        );
        final claude = base.providers.single;
        final store = await _pumpRings(
          tester,
          QuotaSnapshotDto(
            generatedAt: base.generatedAt,
            providers: [
              ProviderQuotaDto(
                provider: 'claude',
                status: claude.status,
                usedPercent: claude.usedPercent,
                tier: null,
                message: null,
                windows: claude.windows,
                modelWindows: claude.modelWindows,
                throttle: const QuotaThrottleDto(
                  intervalSeconds: 90,
                  expired: false,
                  capped: false,
                  buckets: [],
                  updatedAt: '2026-09-28T14:00:00.000Z',
                ),
              ),
            ],
          ),
        );

        expect(_tooltipOf(tester, 'Claude'), contains('Normal launch pacing'));
        expect(_tooltipOf(tester, 'Fable'), isNot(contains('pacing')));
        await store.dispose();
      });
    });

    testWidgets('shows no Fable ring without a Claude reading', (tester) async {
      await tester.runAsync(() async {
        final store = await _pumpRings(
          tester,
          const QuotaSnapshotDto(
            generatedAt: '2026-09-28T14:00:00.000Z',
            providers: [
              ProviderQuotaDto(
                provider: 'codex',
                status: 'available',
                usedPercent: 30,
                tier: null,
                message: null,
                windows: [],
              ),
            ],
          ),
        );

        expect(find.text('Codex'), findsOneWidget);
        expect(find.text('Fable'), findsNothing);
        await store.dispose();
      });
    });
  });

  test('model windows and their IDs survive the cached JSON round trip', () {
    final now = DateTime.utc(2026, 9, 28, 14);
    final snapshot = _snapshot(
      claudeWindows: [_claudeWeekly(now: now)],
      modelWindows: [_fableWeekly(now: now)],
    );
    final restored = QuotaSnapshotDto.fromJson(
      jsonDecode(jsonEncode(snapshot.toJson())) as Map<String, dynamic>,
    );
    final claude = restored.provider('claude')!;

    expect(claude.windows.single.modelIds, isEmpty);
    expect(claude.modelWindows.single.modelIds, ['claude-fable-5-1']);
    expect(fableWeeklyWindow(claude)?.usedPercent, 75);
  });

  test('the estimate marking survives the cached JSON round trip (#759)', () {
    final now = DateTime.utc(2026, 9, 28, 14);
    final snapshot = _snapshot(
      claudeWindows: [_claudeWeekly(now: now)],
      modelWindows: [_fableWeekly(now: now, estimated: true)],
    );
    final restored = QuotaSnapshotDto.fromJson(
      jsonDecode(jsonEncode(snapshot.toJson())) as Map<String, dynamic>,
    );
    final claude = restored.provider('claude')!;

    expect(fableWeeklyWindow(claude)?.estimated, isTrue);
    expect(claude.windows.single.estimated, isFalse);
  });

  test('a payload without modelWindows parses as none', () {
    final provider = ProviderQuotaDto.fromJson({
      'provider': 'claude',
      'status': 'available',
      'windows': <dynamic>[],
    });

    expect(provider.modelWindows, isEmpty);
    expect(fableWeeklyWindow(provider), isNull);
  });

  group('dead-reckoned ring estimates (#759)', () {
    Future<DashboardStore> pumpFable(
      WidgetTester tester,
      QuotaWindowDto fable,
    ) {
      final now = DateTime.now();
      return _pumpRings(
        tester,
        _snapshot(
          claudeWindows: [_claudeWeekly(now: now)],
          modelWindows: [fable],
          withCodex: false,
        ),
      );
    }

    testWidgets('renders the estimate and says it is one', (tester) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final lastReading = now.subtract(const Duration(minutes: 40));
        final store = await pumpFable(
          tester,
          _fableWeekly(
            now: now,
            used: 37.5,
            scrapedAgo: const Duration(minutes: 40),
            estimated: true,
          ),
        );

        expect(_outerRingValue(tester, 'Fable'), closeTo(0.625, 1e-9));
        final tip = _tooltipOf(tester, 'Fable');
        expect(
          tip,
          contains(
            'estimate: extended from the last real reading at '
            '${DateFormat('HH:mm').format(lastReading)}',
          ),
        );
        expect(_tooltipOf(tester, 'Claude'), isNot(contains('estimate')));
        expect(_staleWarning('Fable'), findsNothing);
        await store.dispose();
      });
    });

    testWidgets('shows a rollover estimate as approximately full', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        final store = await pumpFable(
          tester,
          QuotaWindowDto(
            id: 'weekly',
            label: 'Current week (Fable)',
            usedPercent: 5,
            status: 'available',
            headline: true,
            windowMs: _weekMs,
            scrapedAt: _iso(now.subtract(const Duration(minutes: 90))),
            modelIds: const ['claude-fable-5-1'],
            estimated: true,
          ),
        );

        expect(_outerRingValue(tester, 'Fable'), closeTo(0.95, 1e-9));
        final tip = _tooltipOf(tester, 'Fable');
        expect(tip, contains('Current week (Fable): 95% remaining'));
        expect(tip, contains('estimate: extended from the last real reading'));
        await store.dispose();
      });
    });

    testWidgets('draws the warning triangle only after two hours', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        var store = await pumpFable(
          tester,
          _fableWeekly(
            now: now,
            scrapedAgo: const Duration(hours: 1, minutes: 55),
            estimated: true,
          ),
        );
        expect(_staleWarning('Fable'), findsNothing);
        expect(_tooltipOf(tester, 'Fable'), isNot(contains('no real reading')));
        await store.dispose();

        store = await pumpFable(
          tester,
          _fableWeekly(
            now: now,
            scrapedAgo: const Duration(hours: 3, minutes: 5),
            estimated: true,
          ),
        );
        expect(_staleWarning('Fable'), findsOneWidget);
        expect(_staleWarning('Claude'), findsNothing);
        expect(
          tester.widget<Icon>(_staleWarning('Fable')).color,
          MeshColors.quotaStaleWarning,
        );
        expect(
          _tooltipOf(tester, 'Fable'),
          contains(
            'Warning: no real reading for 3h; the ring is estimated from the last one',
          ),
        );
        await store.dispose();
      });
    });

    testWidgets('keeps the warning on an estimate drawn down to 0%', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        // A paced estimate can run out before the reset: the ring is empty
        // because the lane is exhausted, not because it is unknown.
        final store = await pumpFable(
          tester,
          _fableWeekly(
            now: now,
            used: 100,
            scrapedAgo: const Duration(hours: 3),
            estimated: true,
          ),
        );
        expect(_outerRingValue(tester, 'Fable'), 0.0);
        expect(_staleWarning('Fable'), findsOneWidget);
        await store.dispose();
      });
    });

    testWidgets('leaves a window it cannot estimate empty past its reset', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final now = DateTime.now();
        // The server estimates a rolled-over window with no reset time; one
        // still past its reset here is one it had nothing to estimate from, so
        // it reads empty however recent its reading, and carries no warning.
        var store = await pumpFable(
          tester,
          _fableWeekly(
            now: now,
            resetIn: const Duration(minutes: -30),
            scrapedAgo: const Duration(minutes: 90),
          ),
        );
        expect(_outerRingValue(tester, 'Fable'), 0.0);
        expect(_tooltipOf(tester, 'Fable'), contains('estimated ~100%'));
        expect(_staleWarning('Fable'), findsNothing);
        await store.dispose();

        // Inside the window, however old the reading, the ring keeps its value.
        store = await pumpFable(
          tester,
          _fableWeekly(
            now: now,
            used: 60,
            scrapedAgo: const Duration(days: 2),
            estimated: true,
          ),
        );
        expect(_outerRingValue(tester, 'Fable'), closeTo(0.4, 1e-9));
        expect(_staleWarning('Fable'), findsOneWidget);
        await store.dispose();
      });
    });
  });
}
