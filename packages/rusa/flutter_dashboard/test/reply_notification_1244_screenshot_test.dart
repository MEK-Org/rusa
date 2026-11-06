// Public-safe review capture for #1244's notification-opened restricted
// assist transcript. The conversation is synthetic and no API is called.
// Run: flutter test test/reply_notification_1244_screenshot_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/walkie_controller.dart';
import 'package:rusa_dashboard/widgets/walkie_panel.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

const _phone = Size(390, 780);

Widget _frame(GlobalKey key, Widget child) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: Scaffold(
    body: RepaintBoundary(
      key: key,
      child: SizedBox(
        width: _phone.width,
        height: _phone.height,
        child: ColoredBox(color: MeshColors.bgPrimary, child: child),
      ),
    ),
  ),
);

void main() {
  setUpAll(loadFonts);

  testWidgets('captures selected reply before and after history restoration', (
    tester,
  ) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(_phone);
      final api = FakeApi();
      final walkie = FakeWalkie(api);
      final controller = WalkieController(actorId: 'root', deps: walkie.deps);
      addTearDown(controller.dispose);
      await controller.init();
      await controller.enable();
      controller.presentNotificationReply(
        makeAnnouncement(
          'reply-1',
          actor: 'root',
          text: 'Yes — the report is queued.',
        ),
      );
      final key = GlobalKey();

      await tester.pumpWidget(
        _frame(
          key,
          Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: WalkiePanel(controller: controller, expanded: true),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await tester.pump();

      expect(find.text('Should I send the report?'), findsNothing);
      expect(find.text('Yes — the report is queued.'), findsOneWidget);
      await captureBoundary(
        key,
        'screenshots/1244_reply_history_phone_before.png',
      );
      controller.restoreConversation([
        makeChat('memo-1', body: 'Should I send the report?'),
      ]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));

      expect(find.text('Should I send the report?'), findsOneWidget);
      await captureBoundary(
        key,
        'screenshots/1244_reply_history_phone_after.png',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    });
  });
}
