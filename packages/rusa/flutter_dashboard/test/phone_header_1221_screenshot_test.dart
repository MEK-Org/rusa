// Screenshot harness for MEK-Org/rusa#1221: Android phone header status bar
// and navigation bar insets.
// Run:
//   flutter test test/phone_header_1221_screenshot_test.dart
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _phoneSize = Size(390, 844);
const _statusBarHeight = 40.0;
const _navBarHeight = 48.0;

/// Simulated Android system status bar (translucent overlay showing clock and system icons).
class _SimulatedStatusBar extends StatelessWidget {
  const _SimulatedStatusBar();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: _statusBarHeight,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            const Text(
              '9:41',
              style: TextStyle(
                color: Colors.white,
                fontSize: 14,
                fontWeight: FontWeight.w600,
                fontFamily: 'Roboto',
              ),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: const [
                Icon(Icons.wifi, size: 16, color: Colors.white),
                SizedBox(width: 6),
                Icon(Icons.signal_cellular_4_bar, size: 16, color: Colors.white),
                SizedBox(width: 6),
                Icon(Icons.battery_full, size: 16, color: Colors.white),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Simulated Android 3-button navigation bar (Back, Home, Recents).
class _SimulatedNavigationBar extends StatelessWidget {
  const _SimulatedNavigationBar();

  @override
  Widget build(BuildContext context) {
    return Container(
      height: _navBarHeight,
      color: Colors.black.withValues(alpha: 0.8),
      padding: const EdgeInsets.symmetric(horizontal: 48),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: const [
          Icon(Icons.arrow_back_ios_new, size: 18, color: Colors.white70),
          Icon(Icons.circle_outlined, size: 20, color: Colors.white70),
          Icon(Icons.crop_square, size: 20, color: Colors.white70),
        ],
      ),
    );
  }
}

/// A realistic phone frame with Android system bars overlaid.
Widget _deviceFrame({
  required GlobalKey key,
  required Widget child,
}) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildMeshTheme(),
    home: RepaintBoundary(
      key: key,
      child: SizedBox(
        width: _phoneSize.width,
        height: _phoneSize.height,
        child: Stack(
          children: [
            Positioned.fill(child: child),
            const Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: _SimulatedStatusBar(),
            ),
            const Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: _SimulatedNavigationBar(),
            ),
          ],
        ),
      ),
    ),
  );
}

void main() {
  setUpAll(loadFonts);

  testWidgets('captures phone header before and after status bar insets', (
    tester,
  ) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(_phoneSize);

      // ── 1. BEFORE CAPTURE ────────────────────────────────────────────────
      // In the unpatched code, the header has no top view padding and starts at y=0,
      // so the status bar covers the hamburger and title, leaving only an empty
      // strip of the header color visible.
      {
        final store = DashboardStore(
          api: FakeApi()..threadsResult = [makeThread('root', created: 't0')],
          stream: FakeStream(),
        );
        addTearDown(store.dispose);
        await store.init();

        final beforeKey = GlobalKey();
        await tester.pumpWidget(
          _deviceFrame(
            key: beforeKey,
            // Recreating unpatched behavior: zero top padding in MediaQuery
            child: MediaQuery(
              data: const MediaQueryData(
                size: _phoneSize,
                padding: EdgeInsets.zero,
                viewPadding: EdgeInsets.zero,
              ),
              child: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: DashboardBody(store: store),
              ),
            ),
          ),
        );
        await tester.pump();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        await tester.pump();

        await captureBoundary(
          beforeKey,
          '$_outDir/1221_phone_header_before.png',
        );
      }

      // ── 2. AFTER CAPTURE ─────────────────────────────────────────────────
      // With the fix, top view padding insets the header contents below the
      // status bar while keeping the header color behind the status bar, and
      // bottom view padding protects against the 3-button nav bar.
      {
        final store = DashboardStore(
          api: FakeApi()..threadsResult = [makeThread('root', created: 't0')],
          stream: FakeStream(),
        );
        addTearDown(store.dispose);
        await store.init();

        final afterKey = GlobalKey();
        await tester.pumpWidget(
          _deviceFrame(
            key: afterKey,
            child: MediaQuery(
              data: const MediaQueryData(
                size: _phoneSize,
                padding: EdgeInsets.only(
                  top: _statusBarHeight,
                  bottom: _navBarHeight,
                ),
                viewPadding: EdgeInsets.only(
                  top: _statusBarHeight,
                  bottom: _navBarHeight,
                ),
              ),
              child: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: DashboardBody(store: store),
              ),
            ),
          ),
        );
        await tester.pump();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        await tester.pump();

        await captureBoundary(
          afterKey,
          '$_outDir/1221_phone_header_after.png',
        );
      }

      // ── 3. DRAWER OPENED ON TAP ──────────────────────────────────────────
      // Demonstrates that tapping the hamburger opens the drawer.
      {
        final store = DashboardStore(
          api: FakeApi()..threadsResult = [makeThread('root', created: 't0')],
          stream: FakeStream(),
        );
        addTearDown(store.dispose);
        await store.init();

        final drawerKey = GlobalKey();
        await tester.pumpWidget(
          _deviceFrame(
            key: drawerKey,
            child: MediaQuery(
              data: const MediaQueryData(
                size: _phoneSize,
                padding: EdgeInsets.only(
                  top: _statusBarHeight,
                  bottom: _navBarHeight,
                ),
                viewPadding: EdgeInsets.only(
                  top: _statusBarHeight,
                  bottom: _navBarHeight,
                ),
              ),
              child: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: DashboardBody(store: store),
              ),
            ),
          ),
        );
        await tester.pump();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        await tester.pump();

        // Tap the hamburger icon
        await tester.tap(find.byIcon(Icons.menu));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        expect(find.byType(MobileNavDrawer), findsOneWidget);

        await captureBoundary(
          drawerKey,
          '$_outDir/1221_phone_drawer_after.png',
        );
      }
    });
  });
}
