import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'fakes.dart';

void main() {
  for (final width in [390.0, 1100.0]) {
    testWidgets(
      'profile stays upper-right at width $width and is hidden without auth',
      (tester) async {
        await tester.binding.setSurfaceSize(Size(width, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final store = DashboardStore(api: FakeApi(), stream: FakeStream());
        addTearDown(store.dispose);
        Widget header(VoidCallback? onLogout) => MaterialApp(
          home: Scaffold(
            body: MeshHeader(
              store: store,
              onLogout: onLogout,
              onMenuTap: width < 520 ? () {} : null,
            ),
          ),
        );
        await tester.pumpWidget(header(() {}));
        await tester.pump();
        final center = tester.getCenter(find.byType(ProfileMenu));
        expect(center.dx, greaterThan(width - 70));
        expect(center.dy, lessThan(56));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(header(null));
        expect(find.byType(ProfileMenu), findsNothing);
      },
    );
  }
  testWidgets(
    'profile opens a dismissible menu and only logs out on selection',
    (tester) async {
      var logouts = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topRight,
              child: ProfileMenu(onLogout: () => logouts++),
            ),
          ),
        ),
      );
      expect(find.byIcon(Icons.person_outline), findsOneWidget);
      expect(find.text('Log out'), findsNothing);
      await tester.tap(find.byTooltip('Profile menu'));
      await tester.pumpAndSettle();
      expect(find.text('Log out'), findsOneWidget);
      expect(logouts, 0);
      await tester.tapAt(const Offset(10, 500));
      await tester.pumpAndSettle();
      expect(find.text('Log out'), findsNothing);
      expect(logouts, 0);
      await tester.tap(find.byTooltip('Profile menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Log out'));
      await tester.pumpAndSettle();
      expect(logouts, 1);
    },
  );

  testWidgets('profile uses the photo and falls back if it cannot load', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProfileMenu(
            photoUrl: 'https://example.com/profile.png',
            onLogout: () {},
          ),
        ),
      ),
    );
    final image = tester.widget<Image>(find.byType(Image));
    expect(
      (image.image as NetworkImage).url,
      'https://example.com/profile.png',
    );
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.person_outline), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
