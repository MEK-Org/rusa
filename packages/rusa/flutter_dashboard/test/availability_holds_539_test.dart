import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/quota_tooltip.dart';

import 'fakes.dart';

// #539: the header names every availability hold in force (scope, expiry, who
// placed it) whatever their mix with the HALT brake, and the quota rings mark
// the providers and models those holds cover. Reasons stay server-side (#908).

const _weekMs = 604800000;

const _codexWide = AvailabilityHoldDto(
  provider: 'codex',
  origin: 'mesh',
  createdBy: 'root',
);

AvailabilityHoldDto _fableHold(String expiry) => AvailabilityHoldDto(
  provider: 'claude',
  model: 'claude-fable-5-1',
  origin: 'chat',
  expiry: expiry,
  createdBy: 'chat:operator',
);

QuotaWindowDto _weekly(double used) => QuotaWindowDto(
  id: 'weekly',
  label: 'Weekly',
  usedPercent: used,
  status: 'available',
  headline: true,
  windowMs: _weekMs,
);

ProviderQuotaDto _provider(String id, double used) => ProviderQuotaDto(
  provider: id,
  status: 'available',
  usedPercent: null,
  tier: null,
  message: null,
  windows: [_weekly(used)],
);

Future<DashboardStore> _store(
  WidgetTester tester, {
  HaltStatusDto? halt,
  HaltStatusDto? brake,
  List<AvailabilityHoldDto>? holds,
  FakeApi? api,
}) async {
  api ??= FakeApi();
  api
    ..halted = halt != null || brake != null || (holds?.isNotEmpty ?? false)
    ..halt = halt
    ..haltBrake = brake
    ..availabilityHolds = holds
    ..threadsResult = [makeThread('root', created: 't0')]
    ..quotaResult = QuotaSnapshotDto(
      generatedAt: '2026-10-17T12:00:00.000Z',
      providers: [_provider('claude', 40), _provider('codex', 30)],
    );
  final store = DashboardStore(api: api, stream: FakeStream());
  addTearDown(() => tester.runAsync(store.dispose));
  await tester.runAsync(() async {
    await store.init();
    await store.refreshQuota();
  });
  return store;
}

Finder _ring(String name) =>
    find.ancestor(of: find.text(name), matching: find.byType(Tooltip));

Finder _marker(String name, String key) =>
    find.descendant(of: _ring(name), matching: find.byKey(ValueKey(key)));

String _ringTip(WidgetTester tester, String name) {
  final rich = tester.widget<Tooltip>(_ring(name)).richMessage;
  return ((rich as WidgetSpan).child as QuotaTooltip).toPlainText();
}

void main() {
  group('haltDetailTooltipText', () {
    final now = DateTime(2026, 10, 17, 12);
    final later = DateTime(2026, 10, 17, 14, 30).toUtc().toIso8601String();
    final earlier = DateTime(2026, 10, 17, 9).toUtc().toIso8601String();

    test('an older server (holds unknown) keeps the folded #906 text', () {
      expect(
        haltDetailTooltipText(
          halt: const HaltStatusDto(scope: 'global'),
          now: now,
        ),
        'Halt scope: all providers.',
      );
    });

    test('a brake and holds of mixed scope are each named', () {
      final text = haltDetailTooltipText(
        halt: const HaltStatusDto(scope: 'global'),
        brake: const HaltStatusDto(scope: 'global'),
        holds: [_codexWide, _fableHold(later)],
        handleOf: (id) => id == 'root' ? 'steward' : null,
        now: now,
      );
      expect(
        text,
        'Halt scope: all providers.\n'
        'Availability holds:\n'
        '• codex, all models: until cleared. Set by steward.\n'
        '• claude-fable-5-1 on claude: expires today 2:30 PM. Set from chat.',
      );
    });

    test('holds alone, with no folded halt, still name each hold', () {
      final text = haltDetailTooltipText(
        holds: [
          _codexWide,
          AvailabilityHoldDto(
            provider: 'kimi',
            model: 'kimi-k2',
            origin: 'chat',
            expiry: earlier,
            createdBy: kHaltFileImportCreator,
          ),
        ],
        now: now,
      );
      expect(
        text,
        'Availability holds:\n'
        '• codex, all models: until cleared. Set by root.\n'
        '• kimi-k2 on kimi: expiry passed today 9:00 AM. '
        'Imported from a HALT file.',
      );
    });

    test('the accessible label states expiries in UTC', () {
      final text = haltDetailSemanticsText(
        holds: [_fableHold('2026-10-17T21:30:00.000Z')],
      );
      expect(
        text,
        'Availability holds:\n'
        'claude-fable-5-1 on claude: reported expiry '
        'Sat Oct 17, 2026, 9:30 PM UTC. Set from chat.',
      );
    });
  });

  group('header badge', () {
    testWidgets('hover names each hold and its setter by handle', (
      tester,
    ) async {
      final store = await _store(
        tester,
        holds: [_codexWide, _fableHold('2099-01-01T00:00:00.000Z')],
      );
      expect(store.haltDetail.value.holds?.map((h) => h.provider), [
        'codex',
        'claude',
      ]);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1100,
              child: MeshHeader(
                store: store,
                selected: DashboardView.actors,
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(find.text('Halted')));
      await tester.pump(const Duration(seconds: 1));
      expect(
        find.textContaining(
          '• codex, all models: until cleared. Set by root-handle.',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining('• claude-fable-5-1 on claude: expires'),
        findsOneWidget,
      );
    });
  });

  group('clear-all', () {
    Future<void> pumpHeader(WidgetTester tester, DashboardStore store) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1100,
              child: MeshHeader(
                store: store,
                selected: DashboardView.actors,
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }

    final clearAll = find.byKey(const ValueKey('halt-clear-all'));

    testWidgets('the ✕ lists the brake and every hold before releasing', (
      tester,
    ) async {
      final api = FakeApi();
      final store = await _store(
        tester,
        api: api,
        halt: const HaltStatusDto(scope: 'global'),
        brake: const HaltStatusDto(scope: 'global'),
        holds: [_codexWide, _fableHold('2099-01-01T00:00:00.000Z')],
      );
      await pumpHeader(tester, store);

      await tester.tap(clearAll);
      await tester.pumpAndSettle();
      expect(find.text('Clear all halts?'), findsOneWidget);
      expect(
        find.text('• HALT brake. Halt scope: all providers.'),
        findsOneWidget,
      );
      expect(
        find.text('• codex, all models: until cleared. Set by root-handle.'),
        findsOneWidget,
      );
      expect(
        find.textContaining('• claude-fable-5-1 on claude: expires'),
        findsOneWidget,
      );

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Clear all halts?'), findsNothing);
      expect(api.clearAllHaltsCalls, 0);

      await tester.tap(clearAll);
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const ValueKey('halt-clear-all-confirm')));
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      await tester.pumpAndSettle();
      expect(api.clearAllHaltsCalls, 1);
      expect(
        find.text('Released the HALT brake and 2 availability holds.'),
        findsOneWidget,
      );
    });

    testWidgets('a refused clear-all is reported, not swallowed', (
      tester,
    ) async {
      final api = FakeApi()..clearAllHaltsError = Exception('403');
      final store = await _store(tester, api: api, holds: const [_codexWide]);
      await pumpHeader(tester, store);

      await tester.tap(clearAll);
      await tester.pumpAndSettle();
      expect(find.textContaining('HALT brake'), findsNothing);
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const ValueKey('halt-clear-all-confirm')));
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      await tester.pumpAndSettle();
      expect(api.clearAllHaltsCalls, 1);
      expect(
        find.text('Could not clear halts: Exception: 403'),
        findsOneWidget,
      );
    });

    testWidgets('an older server without the holds field shows no ✕', (
      tester,
    ) async {
      final store = await _store(
        tester,
        halt: const HaltStatusDto(scope: 'global'),
      );
      await pumpHeader(tester, store);
      expect(find.text('Halted'), findsOneWidget);
      expect(clearAll, findsNothing);
    });
  });

  group('quota rings', () {
    Future<void> pumpRings(WidgetTester tester, DashboardStore store) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: QuotaIndicators(store: store)),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }

    testWidgets('no holds, no markers', (tester) async {
      await pumpRings(tester, await _store(tester, holds: const []));
      expect(find.byKey(const ValueKey('quota-ring-held')), findsNothing);
      expect(
        find.byKey(const ValueKey('quota-ring-held-in-part')),
        findsNothing,
      );
      expect(_ringTip(tester, 'Codex'), isNot(contains('Held:')));
    });

    testWidgets('a provider-wide hold marks only that provider held', (
      tester,
    ) async {
      await pumpRings(tester, await _store(tester, holds: const [_codexWide]));
      expect(_marker('Codex', 'quota-ring-held'), findsOneWidget);
      expect(find.byKey(const ValueKey('quota-ring-held')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('quota-ring-held-in-part')),
        findsNothing,
      );
      expect(
        _ringTip(tester, 'Codex'),
        startsWith(
          'Codex\n\nHeld: codex, all models: until cleared. '
          'Set by root-handle.\nWeekly: ',
        ),
      );
      expect(_ringTip(tester, 'Claude'), isNot(contains('Held:')));
    });

    testWidgets('a Fable hold holds the Fable ring and part of Claude', (
      tester,
    ) async {
      await pumpRings(
        tester,
        await _store(tester, holds: [_fableHold('2099-01-01T00:00:00.000Z')]),
      );
      expect(_marker('Fable', 'quota-ring-held'), findsOneWidget);
      expect(_marker('Claude', 'quota-ring-held-in-part'), findsOneWidget);
      expect(_marker('Claude', 'quota-ring-held'), findsNothing);
      expect(find.byKey(const ValueKey('quota-ring-held')), findsOneWidget);
      expect(
        _ringTip(tester, 'Fable'),
        contains('Held: claude-fable-5-1 on claude: expires'),
      );
      expect(_ringTip(tester, 'Codex'), isNot(contains('Held:')));
    });

    testWidgets('another Claude model holds Claude in part, not Fable', (
      tester,
    ) async {
      await pumpRings(
        tester,
        await _store(
          tester,
          holds: const [
            AvailabilityHoldDto(
              provider: 'claude',
              model: 'claude-opus-5-5',
              origin: 'mesh',
              createdBy: 'root',
            ),
          ],
        ),
      );
      expect(_marker('Claude', 'quota-ring-held-in-part'), findsOneWidget);
      expect(_ring('Fable'), findsOneWidget);
      expect(_ringTip(tester, 'Fable'), isNot(contains('Held:')));
    });

    testWidgets('a Claude-wide hold holds Claude and Fable outright', (
      tester,
    ) async {
      await pumpRings(
        tester,
        await _store(
          tester,
          holds: const [
            AvailabilityHoldDto(
              provider: 'claude',
              origin: 'chat',
              createdBy: 'chat:operator',
            ),
          ],
        ),
      );
      expect(_marker('Claude', 'quota-ring-held'), findsOneWidget);
      expect(_marker('Fable', 'quota-ring-held'), findsOneWidget);
    });
  });

  test('threads JSON carries the brake and holds apart', () {
    final snap = ThreadsSnapshot.fromJson({
      'threads': <dynamic>[],
      'halted': true,
      'halt': null,
      'haltBrake': {
        'scope': 'providers',
        'providers': ['kimi'],
      },
      'availabilityHolds': [
        {
          'provider': 'claude',
          'model': 'claude-fable-5-1',
          'origin': 'chat',
          'expiry': '2026-10-17T21:30:00.000Z',
          'createdBy': 'chat:operator',
          'createdAt': '2026-10-17T12:00:00.000Z',
        },
      ],
    });
    expect(snap.haltBrake?.providers, ['kimi']);
    final hold = snap.availabilityHolds!.single;
    expect(
      (hold.provider, hold.model, hold.origin, hold.expiry, hold.createdBy),
      (
        'claude',
        'claude-fable-5-1',
        'chat',
        '2026-10-17T21:30:00.000Z',
        'chat:operator',
      ),
    );
    expect(
      ThreadsSnapshot.fromJson({
        'threads': <dynamic>[],
        'halted': false,
      }).availabilityHolds,
      isNull,
    );
  });
}
