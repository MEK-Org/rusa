// Review captures for #1193: the phone drawer before the change (no
// assistant entry, as without the role), its default-assistant entry (unset
// and held), and the assist screen recording to root. All data is
// synthetic; no API is called.
// Run: flutter test test/assistant_1193_screenshot_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/assistant_page.dart';
import 'package:rusa_dashboard/assistant_platform.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

const _phone = Size(390, 780);

Widget _frame(GlobalKey key, Widget child) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: RepaintBoundary(
    key: key,
    child: ColoredBox(color: MeshColors.bgPrimary, child: child),
  ),
);

void main() {
  setUpAll(loadFonts);

  testWidgets('captures the drawer assistant entry', (tester) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(_phone);
      for (final held in [null, false, true]) {
        final store = DashboardStore(api: FakeApi(), stream: FakeStream());
        addTearDown(store.dispose);
        final key = GlobalKey();
        await tester.pumpWidget(
          _frame(
            key,
            Align(
              alignment: Alignment.centerLeft,
              child: SizedBox(
                width: 304,
                child: MobileNavDrawer(
                  store: store,
                  selected: DashboardView.overview,
                  onSelect: (_) {},
                  assistantRole: held == null
                      ? null
                      : FakeAssistant(
                          roleStatus: AssistantRoleStatus(
                            available: true,
                            held: held,
                          ),
                        ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(
          find.byKey(const ValueKey('drawer-assistant')),
          held == null ? findsNothing : findsOne,
        );
        final name = switch (held) {
          null => 'before',
          true => 'assistant_held',
          false => 'assistant_unset',
        };
        await captureBoundary(key, 'screenshots/1193_drawer_$name.png');
        await tester.pumpWidget(const SizedBox.shrink());
      }
    });
  });

  testWidgets('captures the assist screen recording to root', (tester) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(_phone);
      final api = FakeApi()..threadsResult = [makeThread('root')];
      final walkie = FakeWalkie(api);
      final key = GlobalKey();
      await tester.pumpWidget(
        _frame(
          key,
          AssistantPage(
            createApi: () => api,
            createWalkieDeps: (_) => walkie.deps,
            signals: FakeAssistant(),
            onClose: () {},
          ),
        ),
      );
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await tester.pump();
      expect(walkie.recorder.startCalls, 1);
      await captureBoundary(key, 'screenshots/1193_assist_recording.png');
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    });
  });
}
