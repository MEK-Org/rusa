import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// Issue #906: the header halt chip explains the active halt's authoritative
// scope, its scheduling effect, and the expiry, on desktop hover and phone
// long-press, from the structured `halt` field on the threads snapshot.

Widget _header(
  DashboardStore store, {
  double width = 1100,
  bool phone = false,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: width,
      child: MeshHeader(
        store: store,
        selected: DashboardView.actors,
        onSelect: (_) {},
        onMenuTap: phone ? () {} : null,
      ),
    ),
  ),
);

Future<DashboardStore> _store(WidgetTester tester, HaltStatusDto? halt) async {
  final api = FakeApi()
    ..halted = true
    ..halt = halt
    ..threadsResult = [makeThread('root', created: 't0')];
  final store = DashboardStore(api: api, stream: FakeStream());
  await tester.runAsync(store.init);
  return store;
}

final _chip = find.byIcon(Icons.pause_circle_filled);

void main() {
  group('haltTooltipText', () {
    final now = DateTime(2026, 10, 4, 12);

    test('global halt: every new run is skipped, indefinite', () {
      expect(
        haltTooltipText(const HaltStatusDto(scope: 'global'), now: now),
        'Halt scope: all providers.\n'
        'No new runs start.\n'
        'Runs already in flight finish.\n'
        'No expiry — holds until resumed.',
      );
    });

    test('provider halt names the providers and the pool fallback', () {
      final until = DateTime(2026, 10, 4, 17, 52);
      final text = haltTooltipText(
        HaltStatusDto(
          scope: 'providers',
          providers: const ['codex', 'kimi'],
          until: until.toUtc().toIso8601String(),
        ),
        now: now,
      );
      expect(text, startsWith('Halt scope: codex, kimi.\n'));
      expect(
        text,
        contains(
          'Actors run on an unheld candidate in their pool instead; an actor '
          'whose whole pool is held waits.\nRuns already in flight finish.',
        ),
      );
      expect(text, endsWith('Expires today 5:52 PM.'));
      expect(text, isNot(contains('No new runs start')));
    });

    test('model halt names the models on their provider', () {
      final text = haltTooltipText(
        const HaltStatusDto(
          scope: 'models',
          providers: ['claude'],
          models: ['claude-opus-5-5'],
        ),
        now: now,
      );
      expect(text, startsWith('Halt scope: claude-opus-5-5 on claude.\n'));
      expect(text, endsWith('No expiry — holds until resumed.'));
    });

    test('an expiry on a later day carries the date', () {
      final text = haltTooltipText(
        HaltStatusDto(
          scope: 'global',
          until: DateTime(2026, 10, 6, 9, 5).toUtc().toIso8601String(),
        ),
        now: now,
      );
      expect(text, endsWith('Expires Tue Oct 6, 9:05 AM.'));
    });

    test('a passed expiry is not worded as pending', () {
      final text = haltTooltipText(
        HaltStatusDto(
          scope: 'global',
          until: DateTime(2026, 10, 4, 11, 30).toUtc().toIso8601String(),
        ),
        now: now,
      );
      expect(
        text,
        endsWith(
          'Expiry passed today 11:30 AM; the badge clears on the next refresh.',
        ),
      );
      expect(text, isNot(contains('Expires')));
    });

    test('an older server without the field claims no scope', () {
      expect(
        haltTooltipText(null, now: now),
        'Mesh halted — scope not reported by this server.\n'
        'Runs already in flight finish.',
      );
    });
  });

  testWidgets('desktop hover on the chip shows the scope tooltip', (
    tester,
  ) async {
    final store = await _store(
      tester,
      const HaltStatusDto(scope: 'providers', providers: ['codex']),
    );
    await tester.pumpWidget(_header(store));
    await tester.pump();

    // Layout unchanged: the same icon + label chip.
    expect(find.text('Halted'), findsOneWidget);
    expect(find.textContaining('Halt scope:'), findsNothing);

    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(find.text('Halted')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(find.textContaining('Halt scope: codex.'), findsOneWidget);
    await tester.runAsync(store.dispose);
  });

  testWidgets('phone long-press on the compact chip shows the scope tooltip', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.binding.setSurfaceSize(const Size(390, 800));
    final store = await _store(tester, const HaltStatusDto(scope: 'global'));
    await tester.pumpWidget(_header(store, width: 390, phone: true));
    await tester.pump();

    expect(_chip, findsOneWidget);
    expect(find.text('Halted'), findsNothing); // compact: icon only, as before

    await tester.longPress(_chip);
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.textContaining('Halt scope: all providers.'), findsOneWidget);
    await tester.runAsync(store.dispose);
  });

  testWidgets('the chip announces its scope to assistive technology', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    final store = await _store(
      tester,
      const HaltStatusDto(
        scope: 'models',
        providers: ['claude'],
        models: ['claude-opus-5-5'],
      ),
    );
    await tester.pumpWidget(_header(store));
    await tester.pump();

    expect(
      find.bySemanticsLabel(
        RegExp(r'^Halt scope: claude-opus-5-5 on claude\.'),
      ),
      findsOneWidget,
    );
    handle.dispose();
    await tester.runAsync(store.dispose);
  });

  testWidgets(
    'tooltip evaluates dynamically on hover so a passed expiry is recognized '
    'without a widget rebuild',
    (tester) async {
      final until = DateTime.now().add(const Duration(milliseconds: 500));
      final store = await _store(
        tester,
        HaltStatusDto(
          scope: 'global',
          until: until.toUtc().toIso8601String(),
        ),
      );
      await tester.pumpWidget(_header(store));
      await tester.pump();

      // Advance real time past until so DateTime.now() exceeds until.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 600)),
      );
      await tester.pump();

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(find.text('Halted')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(find.textContaining('Expiry passed'), findsOneWidget);
      expect(find.textContaining('Expires today'), findsNothing);
      await tester.runAsync(store.dispose);
    },
  );
}
