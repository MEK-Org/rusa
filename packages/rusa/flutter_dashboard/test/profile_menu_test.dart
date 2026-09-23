import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'fakes.dart';

void main() {
  testWidgets(
    'profile stays upper-right on desktop (width 1100) and is hidden without auth',
    (tester) async {
      const width = 1100.0;
      await tester.binding.setSurfaceSize(const Size(width, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      addTearDown(store.dispose);
      Widget header(VoidCallback? onLogout) => MaterialApp(
        home: Scaffold(
          body: MeshHeader(
            store: store,
            onLogout: onLogout,
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

  testWidgets(
    'mobile header omits ProfileMenu when drawerNav is active (#516)',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MeshHeader(
              store: store,
              onLogout: () {},
              onMenuTap: () {},
            ),
          ),
        ),
      );
      await tester.pump();
      // On mobile with drawer navigation, ProfileMenu is omitted from the header
      // (it is relocated to the drawer Account row to avoid header duplication).
      expect(find.byType(ProfileMenu), findsNothing);
    },
  );
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

  testWidgets('drawer account renders the authenticated display name', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProfileMenu(
            displayName: 'Ada Lovelace',
            onLogout: () {},
            showLabel: true,
          ),
        ),
      ),
    );

    expect(find.text('Ada Lovelace'), findsOneWidget);
    expect(find.text('Account'), findsNothing);
  });
}
