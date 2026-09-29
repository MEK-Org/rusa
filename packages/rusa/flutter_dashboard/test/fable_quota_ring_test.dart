import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/quota_tooltip.dart';

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

Finder _ringTooltip(String name) => find.ancestor(
  of: find.text(name),
  matching: find.byType(Tooltip),
);

String _tooltipOf(WidgetTester tester, String name) {
  final tooltip = tester.widget<Tooltip>(_ringTooltip(name));
  if (tooltip.message != null) return tooltip.message!;
  final rich = tooltip.richMessage;
  if (rich is WidgetSpan && rich.child is QuotaTooltip) {
    return (rich.child as QuotaTooltip).toPlainText();
  }
  return '';
}

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
        expect(claudeTip, contains('Weekly: '));
        expect(claudeTip, contains('Session: '));
        expect(claudeTip, contains('60%'));
        expect(claudeTip, isNot(contains('Fable')));
        expect(fableTip, startsWith('Fable\n'));
        expect(fableTip, contains('Weekly: '));
        expect(fableTip, isNot(contains('(Fable)')));
        expect(fableTip, contains('25%'));
        expect(fableTip, contains('Resets in'));
        expect(fableTip, contains('Last Read: 5 minutes ago'));
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
        expect(tip, contains('Weekly: n/a'));
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
        expect(_tooltipOf(tester, 'Fable'), contains('Weekly: n/a'));
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

        expect(_tooltipOf(tester, 'Fable'), contains('Weekly: n/a'));
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
        expect(tip, contains('2 days ago'));
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

        expect(_tooltipOf(tester, 'Claude'), contains('Pacing: every'));
        expect(_tooltipOf(tester, 'Fable'), isNot(contains('Pacing:')));
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

  test('a payload without modelWindows parses as none', () {
    final provider = ProviderQuotaDto.fromJson({
      'provider': 'claude',
      'status': 'available',
      'windows': <dynamic>[],
    });

    expect(provider.modelWindows, isEmpty);
    expect(fableWeeklyWindow(provider), isNull);
  });
}
