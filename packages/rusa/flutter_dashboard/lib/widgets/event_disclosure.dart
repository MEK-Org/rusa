import 'package:flutter/material.dart';

import '../theme.dart';

/// An event row whose first line carries a chevron that reveals more about the
/// event underneath it. Any event kind can supply its own [content]; it is
/// built only while expanded, so whatever it loads is requested on expansion
/// and again on each reopen.
class EventDisclosure extends StatefulWidget {
  const EventDisclosure({
    super.key,
    required this.header,
    required this.content,
    this.label = 'details',
  });

  /// The row's first line, given the toggle to place in it.
  final Widget Function(Widget toggle) header;
  final WidgetBuilder content;

  /// What the chevron reveals, for its tooltip and semantics.
  final String label;

  @override
  State<EventDisclosure> createState() => _EventDisclosureState();
}

class _EventDisclosureState extends State<EventDisclosure> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      widget.header(
        DisclosureChevron(
          expanded: _expanded,
          label: widget.label,
          onPressed: () => setState(() => _expanded = !_expanded),
        ),
      ),
      if (_expanded) ...[const SizedBox(height: 6), widget.content(context)],
    ],
  );
}

/// The small circular ▸ / ⌄ button that opens an [EventDisclosure].
class DisclosureChevron extends StatelessWidget {
  const DisclosureChevron({
    super.key,
    required this.expanded,
    required this.onPressed,
    this.label = 'details',
  });

  final bool expanded;
  final VoidCallback onPressed;
  final String label;

  @override
  Widget build(BuildContext context) {
    final action = expanded ? 'Hide $label' : 'Show $label';
    return Tooltip(
      message: action,
      child: Semantics(
        button: true,
        expanded: expanded,
        label: action,
        excludeSemantics: true,
        child: Material(
          color: expanded ? MeshColors.bgTertiary : Colors.transparent,
          shape: const CircleBorder(side: BorderSide(color: MeshColors.border)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox(
              width: 20,
              height: 20,
              child: Icon(
                expanded ? Icons.expand_more : Icons.chevron_right,
                size: 16,
                color: expanded
                    ? MeshColors.textPrimary
                    : MeshColors.textSecondary,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
