import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:multi_split_view/multi_split_view.dart';

import '../theme.dart';

/// Narrowest a resizable sidebar may be dragged.
const double kSidebarMinWidth = 240;

/// Narrowest the detail pane beside a resizable sidebar may become, whether by
/// dragging or by the window shrinking. Small enough that both sidebars keep
/// their default width at the narrow breakpoint.
const double kSidebarDetailMinWidth = 320;

/// Width of the draggable divider between the sidebar and the detail pane.
const double kSidebarDividerWidth = 6;

/// A wide-layout master-detail with a draggable divider (#897): the sidebar
/// keeps a fixed pixel width the user can drag, and the detail takes the rest.
///
/// Built on the `multi_split_view` fork glass goals uses (the dashboard already
/// resolves it through goals_widgets). The fork enforces both minimums while
/// dragging; this widget adds what it leaves to the caller:
///
///  • Viewport clamp. A fixed area keeps its size when the window narrows, so
///    the width actually laid out is the user's preferred width clamped to
///    what leaves the detail [minDetailWidth]. The preference survives the
///    clamp, so widening the window again restores it.
///  • Session memory. [onWidthChanged] reports the preferred width when the
///    widget goes away, so a caller can hand it back as [initialWidth] after a
///    view switch. Nothing is persisted.
///  • Reset. Double-clicking the divider restores [defaultWidth].
///
/// The sidebar and detail are laid out in a stack that keeps their elements
/// across drags and clamps, so tree selection, expansion and scroll survive.
class ResizableSidebar extends StatefulWidget {
  const ResizableSidebar({
    super.key,
    required this.sidebar,
    required this.detail,
    required this.defaultWidth,
    this.initialWidth,
    this.minWidth = kSidebarMinWidth,
    this.minDetailWidth = kSidebarDetailMinWidth,
    this.onWidthChanged,
  });

  final Widget sidebar;
  final Widget detail;
  final double defaultWidth;

  /// The preferred width to start from; [defaultWidth] when null.
  final double? initialWidth;
  final double minWidth;
  final double minDetailWidth;

  /// Called with the preferred width when the widget is disposed.
  final ValueChanged<double>? onWidthChanged;

  @override
  State<ResizableSidebar> createState() => _ResizableSidebarState();
}

class _ResizableSidebarState extends State<ResizableSidebar> {
  late double _preferred = widget.initialWidth ?? widget.defaultWidth;
  MultiSplitViewController? _controller;

  /// The width last handed to [_controller]. The fork writes a drag's result
  /// back into the area, so a differing area size means the user dragged.
  double? _applied;

  void _syncFromDrag() {
    final live = _controller?.getArea(0).size;
    if (live != null && live != _applied) {
      _preferred = live;
      _applied = live;
    }
  }

  // The fork matches areas to children by key: an unkeyed area is never
  // reused, and the child it was meant for gets a fresh, evenly split one.
  static const _sidebarKey = ValueKey('resizable-sidebar');
  static const _detailKey = ValueKey('resizable-detail');

  // The fork collapses an area to zero once a drag would push it below its
  // collapse size, which defaults to zero — so a drag that runs past the
  // window edge would make a pane vanish. Neither pane collapses here.
  static const _neverCollapse = double.negativeInfinity;

  List<Area> _areas(double width) => [
    Area(
      key: _sidebarKey,
      size: width,
      minimalSize: widget.minWidth,
      collapseSize: _neverCollapse,
    ),
    Area(
      key: _detailKey,
      weight: 1,
      flex: true,
      minimalSize: widget.minDetailWidth,
      collapseSize: _neverCollapse,
    ),
  ];

  double _clamped(double maxWidth) {
    final ceiling = math.max(
      widget.minWidth,
      maxWidth - kSidebarDividerWidth - widget.minDetailWidth,
    );
    return _preferred.clamp(widget.minWidth, ceiling).toDouble();
  }

  void _reset() {
    _preferred = widget.defaultWidth;
    setState(() => _controller = null);
    // A fresh controller is the only way to put a new size on a keyed area
    // (the fork's `areas` setter keeps resolving keys to the old ones), and
    // the split view only re-measures for a new viewport or a notification.
    // Once it has subscribed, resetSizes() sends that notification; the new
    // areas' initial sizes are the ones it resets to.
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => mounted ? _controller?.resetSizes() : null,
    );
  }

  @override
  void dispose() {
    _syncFromDrag();
    widget.onWidthChanged?.call(_preferred);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        _syncFromDrag();
        final width = _clamped(constraints.maxWidth);
        if (_controller == null || width != _applied) {
          // A fresh controller (not the notifying setter) because this runs
          // during layout. The clamp only moves when the viewport does, and a
          // new viewport width makes the split view re-measure anyway.
          _controller = MultiSplitViewController(areas: _areas(width));
          _applied = width;
        }
        return MultiSplitViewTheme(
          data: MultiSplitViewThemeData(dividerThickness: kSidebarDividerWidth),
          child: MultiSplitView(
            controller: _controller,
            onDividerDoubleTap: (_) => _reset(),
            dividerBuilder:
                (axis, index, resizable, dragging, highlighted, theme) =>
                    _SidebarDivider(active: dragging || highlighted),
            children: [
              KeyedSubtree(key: _sidebarKey, child: widget.sidebar),
              KeyedSubtree(key: _detailKey, child: widget.detail),
            ],
          ),
        );
      },
    );
  }
}

/// The divider's resting look is the 1px border the fixed sidebar had, hugging
/// the sidebar; on hover or drag it brightens to the accent. The transparent
/// fill makes the whole strip, not just the line, hit-testable.
class _SidebarDivider extends StatelessWidget {
  const _SidebarDivider({required this.active});

  final bool active;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      key: const ValueKey('sidebar-divider'),
      color: Colors.transparent,
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          width: active ? 2 : 1,
          color: active ? MeshColors.accent : MeshColors.border,
        ),
      ),
    );
  }
}
