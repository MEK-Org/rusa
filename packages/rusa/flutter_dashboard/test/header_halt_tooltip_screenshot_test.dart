// Screenshot harness for #906's halt-scope tooltip on synthetic fixtures. Run:
//
//   flutter test test/header_halt_tooltip_screenshot_test.dart
//
// It writes `screenshots/906_*_after.png`. The `before` images come from the
// same file run against staging with the `// after-only` lines removed and
// `--dart-define=SHOT_SUFFIX=before`: the same hover/long-press on the chip,
// which had no tooltip there. The passed-expiry phone scene has no `before`:
// staging showed no tooltip for any halt, as `global_longpress_phone_before`.
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment(
  'SHOT_SUFFIX',
  defaultValue: 'after',
);

void main() {
  setUpAll(() async {
    await loadFonts();
  });

  Future<void> scene(
    WidgetTester tester, {
    required String name,
    required Size size,
    required bool halted,
    HaltStatusDto? halt, // after-only
    Future<void> Function()? reveal,
  }) async {
    final api = FakeApi()
      ..halted = halted
      ..halt = halt // after-only
      ..threadsResult = [makeThread('root', created: 't0')];
    final store = DashboardStore(api: api, stream: FakeStream());
    await tester.runAsync(store.init);

    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final phone = size.width < 600;
    final key = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: Align(
              alignment: Alignment.topCenter,
              child: MeshHeader(
                store: store,
                selected: DashboardView.overview,
                onSelect: (_) {},
                onMenuTap: phone ? () {} : null,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    await reveal?.call();
    await tester.pump(const Duration(seconds: 1));
    await tester.runAsync(
      () => captureBoundary(key, '$_outDir/906_${name}_$_suffix.png'),
    );
    await tester.runAsync(store.dispose);
  }

  final chip = find.byIcon(Icons.pause_circle_filled);
  final until = DateTime.now()
      .add(const Duration(minutes: 40))
      .toUtc()
      .toIso8601String();
  final passed = DateTime.now()
      .subtract(const Duration(minutes: 20))
      .toUtc()
      .toIso8601String();

  testWidgets('normal header (no halt)', (tester) async {
    await scene(
      tester,
      name: 'normal_wide',
      size: const Size(1200, 220),
      halted: false,
    );
    expect(chip, findsNothing);
  });

  testWidgets('wide: hover on a provider-scoped halt with expiry', (
    tester,
  ) async {
    await scene(
      tester,
      name: 'provider_hover_wide',
      size: const Size(1200, 220),
      halted: true,
      halt: HaltStatusDto( // after-only
        scope: 'providers', // after-only
        providers: const ['codex'], // after-only
        until: until, // after-only
      ), // after-only
      reveal: () async {
        final mouse = await tester.createGesture(
          kind: PointerDeviceKind.mouse,
        );
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);
        await mouse.moveTo(tester.getCenter(chip));
        await tester.pump();
      },
    );
  });

  testWidgets('wide: hover on a model-scoped indefinite halt', (tester) async {
    await scene(
      tester,
      name: 'model_hover_wide',
      size: const Size(1200, 220),
      halted: true,
      halt: const HaltStatusDto( // after-only
        scope: 'models', // after-only
        providers: ['claude'], // after-only
        models: ['claude-opus-5-5'], // after-only
      ), // after-only
      reveal: () async {
        final mouse = await tester.createGesture(
          kind: PointerDeviceKind.mouse,
        );
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);
        await mouse.moveTo(tester.getCenter(chip));
        await tester.pump();
      },
    );
  });

  testWidgets('phone: long-press on a provider-scoped halt past its expiry', (
    tester,
  ) async {
    await scene(
      tester,
      name: 'provider_passed_longpress_phone',
      size: const Size(390, 320),
      halted: true,
      halt: HaltStatusDto( // after-only
        scope: 'providers', // after-only
        providers: const ['codex', 'gemini'], // after-only
        until: passed, // after-only
      ), // after-only
      reveal: () async {
        await tester.longPress(chip);
        await tester.pump();
      },
    );
    expect(find.textContaining('Expiry passed'), findsOneWidget);
  });

  testWidgets('phone: long-press on a global halt', (tester) async {
    await scene(
      tester,
      name: 'global_longpress_phone',
      size: const Size(390, 260),
      halted: true,
      halt: const HaltStatusDto(scope: 'global'), // after-only
      reveal: () async {
        await tester.longPress(chip);
        await tester.pump();
      },
    );
  });
}
