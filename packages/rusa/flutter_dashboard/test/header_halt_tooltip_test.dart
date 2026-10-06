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
  DateTime Function()? haltTooltipNow,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: width,
      child: MeshHeader(
        store: store,
        selected: DashboardView.actors,
        onSelect: (_) {},
        onMenuTap: phone ? () {} : null,
        haltTooltipNow: haltTooltipNow,
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

    test('global halt: scope only when indefinite', () {
      expect(
        haltTooltipText(const HaltStatusDto(scope: 'global'), now: now),
        'Halt scope: all providers.',
      );
    });

    test('provider halt names the providers with expiry', () {
      final until = DateTime(2026, 10, 4, 17, 52);
      final text = haltTooltipText(
        HaltStatusDto(
          scope: 'providers',
          providers: const ['codex', 'kimi'],
          until: until.toUtc().toIso8601String(),
        ),
        now: now,
      );
      expect(text, 'Halt scope: codex, kimi.\nExpires today 5:52 PM.');
      expect(text, isNot(contains('Actors run')));
      expect(text, isNot(contains('in flight')));
    });

    test('model halt names the models on their provider without expiry line', () {
      final text = haltTooltipText(
        const HaltStatusDto(
          scope: 'models',
          providers: ['claude'],
          models: ['claude-opus-5-5'],
        ),
        now: now,
      );
      expect(text, 'Halt scope: claude-opus-5-5 on claude.');
      expect(text, isNot(contains('No expiry')));
      expect(text, isNot(contains('Actors run')));
    });

    test('an expiry on a later day carries the date', () {
      final text = haltTooltipText(
        HaltStatusDto(
          scope: 'global',
          until: DateTime(2026, 10, 6, 9, 5).toUtc().toIso8601String(),
        ),
        now: now,
      );
      expect(text, 'Halt scope: all providers.\nExpires Tue Oct 6, 9:05 AM.');
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
        'Reported halt scope: all providers.\n'
        'Expiry passed today 11:30 AM.',
      );
      expect(text, isNot(contains('in force')));
      expect(text, isNot(contains('in flight')));
      expect(text, isNot(contains('Expires')));
    });

    test('an older server without the field claims no scope', () {
      expect(
        haltTooltipText(null, now: now),
        'Mesh halted — scope not reported by this server.',
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

  testWidgets('the tooltip text keeps the tooltip theme style', (tester) async {
    final store = await _store(tester, const HaltStatusDto(scope: 'global'));
    await tester.pumpWidget(_header(store));
    await tester.pump();

    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(find.text('Halted')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    // The lazily built text must read like a plain tooltip message, not a
    // hard-coded colour that vanishes on the theme's tooltip background.
    final text = find.textContaining('Halt scope: all providers.');
    final themed = DefaultTextStyle.of(tester.element(text)).style;
    final rendered = tester
        .widget<RichText>(
          find.descendant(of: text, matching: find.byType(RichText)),
        )
        .text
        .style!;
    expect(rendered.color, themed.color);
    expect(rendered.fontSize, themed.fontSize);
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

  testWidgets(
    'the chip announces its scope and stable expiry to assistive technology',
    (tester) async {
      final handle = tester.ensureSemantics();
      final until = DateTime.utc(2026, 10, 4, 17, 52);
      final store = await _store(
        tester,
        HaltStatusDto(
          scope: 'models',
          providers: ['claude'],
          models: ['claude-opus-5-5'],
          until: until.toUtc().toIso8601String(),
        ),
      );
      await tester.pumpWidget(_header(store));
      await tester.pump();

      const expectedSemantics =
          'Halted. Reported halt scope: claude-opus-5-5 on claude.\n'
          'Reported expiry: Sun Oct 4, 2026, 5:52 PM UTC.';
      expect(find.bySemanticsLabel(expectedSemantics), findsOneWidget);
      handle.dispose();
      await tester.runAsync(store.dispose);
    },
  );

  testWidgets(
    'the chip announces its scope without expiry line when indefinite',
    (tester) async {
      final handle = tester.ensureSemantics();
      final store = await _store(
        tester,
        const HaltStatusDto(scope: 'global'),
      );
      await tester.pumpWidget(_header(store));
      await tester.pump();

      const expectedSemantics = 'Halted. Reported halt scope: all providers.';
      expect(find.bySemanticsLabel(expectedSemantics), findsOneWidget);
      handle.dispose();
      await tester.runAsync(store.dispose);
    },
  );

  testWidgets(
    'tooltip evaluates dynamically on hover so a passed expiry is recognized '
    'without a widget rebuild',
    (tester) async {
      // The controllable presentation clock alone crosses the expiry after the
      // header has built.
      final until = DateTime.now().add(const Duration(days: 1));
      var now = until.subtract(const Duration(minutes: 1));
      final store = await _store(
        tester,
        HaltStatusDto(scope: 'global', until: until.toUtc().toIso8601String()),
      );
      await tester.pumpWidget(_header(store, haltTooltipNow: () => now));
      await tester.pump();

      // Do not pump/rebuild after this transition. Replacing the lazy Builder
      // with build-time text makes this assertion fail.
      now = until.add(const Duration(minutes: 1));

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
