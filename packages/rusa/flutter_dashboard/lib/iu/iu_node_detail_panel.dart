import 'package:flutter/material.dart';
import 'package:goals_core/model.dart' show Goal, GoalPath, getDocumentEntry;
import 'package:goals_core/sync.dart' show DocumentContentsEntry;

import '../theme.dart';
import 'simple_markdown.dart';

/// The right pane of the IU calibration split-view (ISSUE_NUM task 3): renders the selected
/// node's contents. An IU node's body is its latest `documentContents` log entry, which the
/// distiller writes as Markdown — so we pull it via [getDocumentEntry] and render it with
/// [SimpleMarkdown]. The node title (`goal.text`) heads the panel. Strictly read-only.
///
/// **Externalized bodies :** glass_goals externalizes a log entry's text into a separate
/// key-value store, so a baseline node's `DocumentContentsEntry` arrives with `text == null` and
/// the body must be loaded separately via [loadBody] (`syncClient.loadString` over the op-getter's
/// strings endpoint). The distiller's own writes keep text inline and resolve with no fetch. A
/// body that's referenced but can't be resolved (Firestore miss / view-time outage) degrades to a
/// per-node "content unavailable" placeholder — distinct from a node that genuinely has no body.
class IuNodeDetailPanel extends StatefulWidget {
  const IuNodeDetailPanel({
    super.key,
    required this.path,
    required this.goalMap,
    this.loadBody,
    this.onClose,
  });

  /// The selected node's path (its id is `path.goalId`).
  final GoalPath path;
  final Map<String, Goal> goalMap;

  /// Resolve an externalized body by its entry id (typically `syncClient.loadString`). Null →
  /// no resolver wired (only inline bodies render; externalized ones show "content unavailable").
  final Future<String?> Function(String entryId)? loadBody;

  final VoidCallback? onClose;

  @override
  State<IuNodeDetailPanel> createState() => _IuNodeDetailPanelState();
}

class _IuNodeDetailPanelState extends State<IuNodeDetailPanel> {
  /// The pending fetch for an externalized body — memoized so rebuilds don't refetch/flicker.
  Future<String?>? _bodyFuture;

  /// The entry id [_bodyFuture] was started for, to recompute only when the selection changes.
  String? _bodyEntryId;

  /// The selected node's latest document-contents entry (its body), or null when it has none.
  DocumentContentsEntry? get _docEntry {
    final entry = getDocumentEntry(widget.path, goalMap: widget.goalMap);
    return entry is DocumentContentsEntry ? entry : null;
  }

  @override
  Widget build(BuildContext context) {
    final goal = widget.goalMap[widget.path.goalId];
    return Container(
      decoration: const BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border(left: BorderSide(color: MeshColors.border)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    goal?.text ?? '(node not in graph)',
                    style: const TextStyle(
                      color: MeshColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (widget.onClose != null)
                  IconButton(
                    icon: const Icon(
                      Icons.close,
                      size: 18,
                      color: MeshColors.textSecondary,
                    ),
                    tooltip: 'Close',
                    onPressed: widget.onClose,
                    splashRadius: 18,
                  ),
              ],
            ),
          ),
          const Divider(color: MeshColors.border, height: 1),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: _body(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body() {
    final entry = _docEntry;
    if (entry == null) {
      // No (uncleared) document-contents entry → the node genuinely has no body.
      return _placeholder('This node has no document contents.');
    }
    final inline = entry.text;
    if (inline != null && inline.trim().isNotEmpty) {
      return SimpleMarkdown(
        inline,
      ); // distiller-written (inline) body — no fetch needed
    }
    // Externalized body: load it separately (glass_goals pattern).
    if (widget.loadBody == null) {
      return _placeholder('Content unavailable.');
    }
    if (_bodyEntryId != entry.id) {
      _bodyEntryId = entry.id;
      _bodyFuture = widget.loadBody!(entry.id);
    }
    return FutureBuilder<String?>(
      future: _bodyFuture,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.only(top: 4),
            child: SizedBox(
              height: 18,
              width: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        }
        final text = snap.data;
        if (text == null || text.trim().isEmpty) {
          // Referenced but unresolved (Firestore miss / view-time outage) — degrade per-node.
          return _placeholder('Content unavailable.');
        }
        return SimpleMarkdown(text);
      },
    );
  }

  Widget _placeholder(String message) => Text(
    message,
    style: const TextStyle(
      color: MeshColors.textMuted,
      fontStyle: FontStyle.italic,
    ),
  );
}
