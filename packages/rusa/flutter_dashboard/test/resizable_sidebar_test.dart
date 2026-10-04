import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/resizable_sidebar.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

final _divider = find.byKey(const ValueKey('sidebar-divider'));

/// The sidebar's laid-out width: the divider sits directly after it.
double _sidebarWidth(WidgetTester tester) => tester.getTopLeft(_divider).dx;

void _sizeView(WidgetTester tester, Size size) {
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1.0;
}

Future<void> _doubleTapDivider(WidgetTester tester) async {
  await tester.tap(_divider);
  await tester.pump(const Duration(milliseconds: 50));
  await tester.tap(_divider);
  await tester.pumpAndSettle();
}

/// Counts its own builds' state so a test can tell a kept State from a new one.
class _Probe extends StatefulWidget {
  const _Probe();

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  final scroll = ScrollController();

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListView.builder(
    controller: scroll,
    itemCount: 200,
    itemBuilder: (_, i) => SizedBox(height: 30, child: Text('row $i')),
  );
}

void main() {
  group('ResizableSidebar', () {
    Future<List<double>> pump(
      WidgetTester tester, {
      Size size = const Size(1280, 800),
      double? initialWidth,
      bool show = true,
    }) async {
      final reported = <double>[];
      _sizeView(tester, size);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: show
                ? ResizableSidebar(
                    defaultWidth: 360,
                    initialWidth: initialWidth,
                    onWidthChanged: reported.add,
                    sidebar: const _Probe(),
                    detail: const ColoredBox(
                      key: ValueKey('detail'),
                      color: Colors.black,
                    ),
                  )
                : const SizedBox(),
          ),
        ),
      );
      return reported;
    }

    testWidgets('starts at the default, or at the width it is handed', (
      tester,
    ) async {
      await pump(tester);
      expect(_sidebarWidth(tester), 360);

      await pump(tester, initialWidth: 300, show: false);
      await pump(tester, initialWidth: 300);
      expect(_sidebarWidth(tester), 300);
    });

    testWidgets('dragging the divider resizes the sidebar', (tester) async {
      await pump(tester);
      await tester.drag(_divider, const Offset(100, 0));
      await tester.pumpAndSettle();
      expect(_sidebarWidth(tester), 460);

      await tester.drag(_divider, const Offset(-60, 0));
      await tester.pumpAndSettle();
      expect(_sidebarWidth(tester), 400);
    });

    testWidgets('dragging stops at the sidebar and detail minimums', (
      tester,
    ) async {
      await pump(tester);
      await tester.drag(_divider, const Offset(-1000, 0));
      await tester.pumpAndSettle();
      expect(_sidebarWidth(tester), kSidebarMinWidth);

      await tester.drag(_divider, const Offset(2000, 0));
      await tester.pumpAndSettle();
      expect(
        _sidebarWidth(tester),
        1280 - kSidebarDividerWidth - kSidebarDetailMinWidth,
      );
    });

    testWidgets('a narrowing window clamps the width and widening restores '
        'the dragged preference', (tester) async {
      await pump(tester);
      await tester.drag(_divider, const Offset(240, 0));
      await tester.pumpAndSettle();
      expect(_sidebarWidth(tester), 600);

      _sizeView(tester, const Size(800, 800));
      await tester.pumpAndSettle();
      expect(
        _sidebarWidth(tester),
        800 - kSidebarDividerWidth - kSidebarDetailMinWidth,
      );
      expect(tester.getSize(find.byKey(const ValueKey('detail'))).width, 320);

      _sizeView(tester, const Size(1280, 800));
      await tester.pumpAndSettle();
      expect(_sidebarWidth(tester), 600);
    });

    testWidgets('never squeezes the sidebar below its minimum, even when the '
        'window is too small for both minimums', (tester) async {
      await pump(tester, size: const Size(500, 800));
      expect(_sidebarWidth(tester), kSidebarMinWidth);
      expect(tester.takeException(), isNull);
    });

    testWidgets('double-clicking the divider resets to the default', (
      tester,
    ) async {
      await pump(tester);
      await tester.drag(_divider, const Offset(150, 0));
      await tester.pumpAndSettle();
      expect(_sidebarWidth(tester), 510);

      await _doubleTapDivider(tester);
      expect(_sidebarWidth(tester), 360);
    });

    testWidgets('keeps the sidebar State and scroll position through drags '
        'and clamps', (tester) async {
      await pump(tester);
      final probe = tester.state<_ProbeState>(find.byType(_Probe));
      probe.scroll.jumpTo(900);
      await tester.pump();

      await tester.drag(_divider, const Offset(120, 0));
      await tester.pumpAndSettle();
      _sizeView(tester, const Size(760, 800));
      await tester.pumpAndSettle();
      _sizeView(tester, const Size(1280, 800));
      await tester.pumpAndSettle();

      expect(tester.state<_ProbeState>(find.byType(_Probe)), same(probe));
      expect(probe.scroll.offset, 900);
    });

    testWidgets('reports the preferred width, not the clamped one, on '
        'dispose', (tester) async {
      final reported = await pump(tester);
      await tester.drag(_divider, const Offset(200, 0));
      await tester.pumpAndSettle();
      _sizeView(tester, const Size(760, 800));
      await tester.pumpAndSettle();

      await pump(tester, show: false);
      expect(reported, [560]);
    });
  });

  group('dashboard sidebars', () {
    FakeApi makeApi() => FakeApi()
      ..threadsResult = [makeThread('root')]
      ..obligationsResult = [
        makeObligation('ob-parent', ownerId: 'root', intent: 'Parent work'),
        makeObligation(
          'ob-child',
          ownerId: 'root',
          parentId: 'ob-parent',
          intent: 'Child work',
        ),
        for (var i = 0; i < 40; i++)
          makeObligation('ob-$i', ownerId: 'root', intent: 'Filler work $i'),
      ];

    Future<DashboardStore> makeStore() async {
      final store = DashboardStore(
        api: makeApi(),
        stream: FakeStream(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
      await store.init();
      return store;
    }

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    testWidgets('the Work tab keeps selection, expansion and tree scroll '
        'through a drag and a breakpoint round trip', (tester) async {
      await tester.runAsync(() async {
        final store = await makeStore();
        _sizeView(tester, const Size(1280, 800));
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await settle(tester);
        expect(_sidebarWidth(tester), 320);

        await tester.tap(find.byIcon(Icons.chevron_right).first);
        await settle(tester);
        await tester.tap(find.text('Child work'));
        await settle(tester);
        final tree = find
            .descendant(
              of: find.byType(WorkTab),
              matching: find.byType(Scrollable),
            )
            .first;
        tester.state<ScrollableState>(tree).position.jumpTo(120);
        await settle(tester);

        await tester.drag(_divider, const Offset(140, 0));
        await settle(tester);
        expect(_sidebarWidth(tester), 460);
        expect(tester.state<ScrollableState>(tree).position.pixels, 120);
        // The detail pane still shows the selection.
        expect(find.text('Select an obligation from the tree.'), findsNothing);
        tester.state<ScrollableState>(tree).position.jumpTo(0);
        await settle(tester);
        expect(find.byIcon(Icons.keyboard_arrow_down), findsOneWidget);
        expect(find.text('Child work'), findsNWidgets(2));

        // Below the breakpoint the existing narrow layout takes over: no
        // divider, the selected detail full width.
        _sizeView(tester, const Size(600, 800));
        await settle(tester);
        expect(_divider, findsNothing);
        expect(find.byIcon(Icons.arrow_back), findsOneWidget);

        _sizeView(tester, const Size(1280, 800));
        await settle(tester);
        expect(_sidebarWidth(tester), 460);
        expect(find.byIcon(Icons.keyboard_arrow_down), findsOneWidget);
        expect(find.text('Child work'), findsNWidgets(2));
        await tester.pumpWidget(const SizedBox());
        await store.dispose();
      });
    });

    testWidgets('the actor sidebar is resizable and keeps its width across '
        'a view switch', (tester) async {
      await tester.runAsync(() async {
        final store = await makeStore();
        _sizeView(tester, const Size(1280, 800));
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: DashboardBody(store: store)),
          ),
        );
        await settle(tester);
        await tester.tap(find.text('Actors'));
        await settle(tester);
        expect(find.byType(ActorTree), findsOneWidget);
        expect(_sidebarWidth(tester), 360);
        expect(tester.getSize(find.byType(ActorTree)).width, 360);

        await tester.drag(_divider, const Offset(-80, 0));
        await settle(tester);
        expect(_sidebarWidth(tester), 280);
        expect(tester.getSize(find.byType(ActorTree)).width, 280);

        await tester.tap(find.text('Work'));
        await settle(tester);
        expect(_sidebarWidth(tester), 320);
        await tester.tap(find.text('Actors'));
        await settle(tester);
        expect(_sidebarWidth(tester), 280);
        expect(store.sidebarWidth('actors'), 280);
        await tester.pumpWidget(const SizedBox());
        await store.dispose();
      });
    });
  });
}
