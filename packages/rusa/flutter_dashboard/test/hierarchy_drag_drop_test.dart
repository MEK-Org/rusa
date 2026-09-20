import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/widgets/hierarchy_drag_drop.dart';

void main() {
  group('classifyHierarchyDropZone', () {
    test('reserves the outer quarters for sibling insertion', () {
      expect(
        classifyHierarchyDropZone(localDy: 1, height: 100),
        HierarchyDropZone.before,
      );
      expect(
        classifyHierarchyDropZone(localDy: 99, height: 100),
        HierarchyDropZone.after,
      );
    });

    test('makes the center a deliberate on-row reparent zone', () {
      expect(
        classifyHierarchyDropZone(localDy: 50, height: 100),
        HierarchyDropZone.on,
      );
      expect(
        classifyHierarchyDropZone(localDy: 0, height: 0),
        HierarchyDropZone.on,
      );
    });
  });

  group('HierarchyDropTarget', () {
    const dragKey = Key('drag');
    const targetKey = Key('target');
    const targetHeight = 100.0;

    /// A draggable row above a 100px-tall target whose acceptance rule is
    /// [canAccept]; mirrors the work tab, where a ready root sits above a
    /// waiting parent that can only be landed on, never reordered against.
    Future<void> pumpHierarchy(
      WidgetTester tester, {
      required bool Function(String data, HierarchyDropZone zone) canAccept,
      required void Function(String data, HierarchyDropZone zone) onDrop,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Draggable<String>(
                  data: 'dragged',
                  dragAnchorStrategy: pointerDragAnchorStrategy,
                  feedback: const SizedBox(width: 20, height: 20),
                  child: const SizedBox(
                    key: dragKey,
                    width: 200,
                    height: 40,
                    child: ColoredBox(color: Colors.grey),
                  ),
                ),
                const SizedBox(height: 60),
                HierarchyDropTarget<String>(
                  canAccept: canAccept,
                  onDrop: onDrop,
                  builder: (context, activeZone) => SizedBox(
                    key: targetKey,
                    width: 200,
                    height: targetHeight,
                    child: ColoredBox(
                      color: Colors.grey,
                      child: Text(activeZone?.name ?? 'idle'),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    Future<TestGesture> lift(WidgetTester tester) async {
      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(dragKey)),
      );
      await tester.pump();
      return gesture;
    }

    Future<void> hoverTarget(
      WidgetTester tester,
      TestGesture gesture,
      double dy,
    ) async {
      final top = tester.getTopLeft(find.byKey(targetKey));
      await gesture.moveTo(top + Offset(100, dy));
      await tester.pump();
    }

    testWidgets('lands on a row entered through an edge that cannot reorder', (
      tester,
    ) async {
      HierarchyDropZone? dropped;
      await pumpHierarchy(
        tester,
        canAccept: (_, zone) => zone == HierarchyDropZone.on,
        onDrop: (_, zone) => dropped = zone,
      );

      final gesture = await lift(tester);
      // Dragging downward crosses the top quarter first: a reorder zone
      // this target rejects. Flutter decides candidacy at that crossing
      // and never asks again while the pointer stays inside, so the row
      // must stay a candidate for its middle to remain reachable.
      await hoverTarget(tester, gesture, 5);
      expect(find.text('idle'), findsOneWidget);
      await hoverTarget(tester, gesture, targetHeight / 2);
      expect(find.text('on'), findsOneWidget);

      await gesture.up();
      await tester.pump();
      expect(dropped, HierarchyDropZone.on);
    });

    testWidgets('releases nothing over a zone the row cannot accept', (
      tester,
    ) async {
      var drops = 0;
      await pumpHierarchy(
        tester,
        canAccept: (_, zone) => zone == HierarchyDropZone.on,
        onDrop: (_, _) => drops++,
      );

      final gesture = await lift(tester);
      await hoverTarget(tester, gesture, targetHeight / 2);
      expect(find.text('on'), findsOneWidget);
      // Sliding from the middle back out to the bottom quarter withdraws the
      // highlight, and releasing there must not fall back to the last good
      // zone.
      await hoverTarget(tester, gesture, targetHeight - 5);
      expect(find.text('idle'), findsOneWidget);

      await gesture.up();
      await tester.pump();
      expect(drops, 0);
    });

    testWidgets('never highlights a row that accepts no zone', (tester) async {
      var drops = 0;
      await pumpHierarchy(
        tester,
        canAccept: (_, _) => false,
        onDrop: (_, _) => drops++,
      );

      final gesture = await lift(tester);
      for (final dy in [5.0, targetHeight / 2, targetHeight - 5]) {
        await hoverTarget(tester, gesture, dy);
        expect(find.text('idle'), findsOneWidget);
      }

      await gesture.up();
      await tester.pump();
      expect(drops, 0);
    });
  });
}
