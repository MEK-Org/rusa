import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';

/// The three intentional landing zones shared by hierarchy rows.  The edges
/// reorder beside a row; the middle lands *on* it and therefore reparents.
enum HierarchyDropZone { before, on, after }

/// Classifies a vertical pointer position without any entity-specific policy.
/// A quarter-height edge on either side leaves a generous, deliberate middle
/// zone for reparenting while keeping sibling insertion easy to discover.
HierarchyDropZone classifyHierarchyDropZone({
  required double localDy,
  required double height,
}) {
  if (height <= 0) return HierarchyDropZone.on;
  final edge = height * .25;
  if (localDy < edge) return HierarchyDropZone.before;
  if (localDy > height - edge) return HierarchyDropZone.after;
  return HierarchyDropZone.on;
}

/// A generic Flutter drag target with common zone selection and feedback.
/// Consumers own their acceptance rules and persistence callbacks; keeping
/// those here would blur the very different actor and obligation invariants.
/// [onDrop] is intentionally fire-and-forget so a successful drop can clear
/// its feedback immediately; consumers must catch, surface, and recover from
/// their own mutation errors in the callback.
class HierarchyDropTarget<T extends Object> extends StatefulWidget {
  const HierarchyDropTarget({
    super.key,
    required this.canAccept,
    required this.onDrop,
    required this.builder,
  });

  final bool Function(T data, HierarchyDropZone zone) canAccept;
  final FutureOr<void> Function(T data, HierarchyDropZone zone) onDrop;
  final Widget Function(BuildContext context, HierarchyDropZone? activeZone)
  builder;

  @override
  State<HierarchyDropTarget<T>> createState() => _HierarchyDropTargetState<T>();
}

class _HierarchyDropTargetState<T extends Object>
    extends State<HierarchyDropTarget<T>> {
  final _targetKey = GlobalKey();
  HierarchyDropZone? _activeZone;

  HierarchyDropZone _zoneAt(Offset globalPosition) {
    final box = _targetKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null) return HierarchyDropZone.on;
    final local = box.globalToLocal(globalPosition);
    return classifyHierarchyDropZone(
      localDy: local.dy,
      height: box.size.height,
    );
  }

  void _setActiveZone(HierarchyDropZone? zone) {
    if (_activeZone == zone || !mounted) return;
    setState(() => _activeZone = zone);
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: _targetKey,
      child: DragTarget<T>(
        onWillAcceptWithDetails: (details) {
          final zone = _zoneAt(details.offset);
          final accepted = widget.canAccept(details.data, zone);
          _setActiveZone(accepted ? zone : null);
          return accepted;
        },
        onMove: (details) {
          final zone = _zoneAt(details.offset);
          _setActiveZone(widget.canAccept(details.data, zone) ? zone : null);
        },
        onLeave: (_) => _setActiveZone(null),
        onAcceptWithDetails: (details) {
          final zone = _activeZone ?? _zoneAt(details.offset);
          _setActiveZone(null);
          unawaited(Future.sync(() => widget.onDrop(details.data, zone)));
        },
        builder: (context, candidateData, rejectedData) =>
            widget.builder(context, candidateData.isEmpty ? null : _activeZone),
      ),
    );
  }
}

/// Shared visual language for a hierarchy landing zone.  Edge drops draw an
/// insertion rule; an on-row drop encloses the row to make reparenting clear.
class HierarchyDropHighlight extends StatelessWidget {
  const HierarchyDropHighlight({
    super.key,
    required this.zone,
    required this.child,
  });

  final HierarchyDropZone? zone;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final isOn = zone == HierarchyDropZone.on;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: zone == null ? null : MeshColors.accent.withValues(alpha: 0.08),
        border: Border(
          top: zone == HierarchyDropZone.before
              ? const BorderSide(color: MeshColors.accent, width: 2)
              : BorderSide.none,
          bottom: zone == HierarchyDropZone.after
              ? const BorderSide(color: MeshColors.accent, width: 2)
              : BorderSide.none,
          left: isOn
              ? const BorderSide(color: MeshColors.accent, width: 2)
              : BorderSide.none,
          right: isOn
              ? const BorderSide(color: MeshColors.accent, width: 2)
              : BorderSide.none,
        ),
      ),
      child: child,
    );
  }
}

/// The lightweight lifted row used while either hierarchy is being dragged.
class HierarchyDragFeedback extends StatelessWidget {
  const HierarchyDragFeedback({
    super.key,
    required this.leading,
    required this.label,
  });

  final Widget leading;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      elevation: 6,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: MeshColors.accent),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            leading,
            const SizedBox(width: 8),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                color: MeshColors.textPrimary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
