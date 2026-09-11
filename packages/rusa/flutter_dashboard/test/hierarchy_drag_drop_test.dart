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
}
