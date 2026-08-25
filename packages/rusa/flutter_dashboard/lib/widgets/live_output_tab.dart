import 'package:flutter/material.dart';
import 'package:rxdart/rxdart.dart';

import '../store.dart';
import '../theme.dart';

/// Live Output tab: a monospace console of the merged SSE `live_output` stream
/// for the selected actors. Consecutive chunks from one actor are coalesced into
/// a block; under multi-select each block gets a handle gutter so the streams
/// don't garble. Drop-oldest gaps (the `elided` frame) render as a marker.
class LiveOutputTab extends StatefulWidget {
  const LiveOutputTab({super.key, required this.store});

  final DashboardStore store;

  @override
  State<LiveOutputTab> createState() => _LiveOutputTabState();
}

class _LiveOutputTabState extends State<LiveOutputTab> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _autoScroll() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: MeshColors.bgConsole,
      child: StreamBuilder<List<Object?>>(
        stream: Rx.combineLatestList<Object?>([
          widget.store.live,
          widget.store.selection,
          widget.store.actorStates,
          widget.store.actorStates,
        ]),
        builder: (_, _) {
          final lines = widget.store.live.value;
          final selection = widget.store.selection.value;
          if (selection.isEmpty) {
            return _hintCentered('Select an actor to stream its live output.');
          }
          final multi = selection.length > 1;
          final handles = {
            for (final a in widget.store.actorStates.value.actors.values) a.thread.id: a.thread.handle,
          };
          // Only show the blinking cursor when a selected actor is genuinely
          // running; otherwise the run is over, so show an explicit idle marker
          // instead of a perpetual cursor on a stream that won't produce more.
          final anyRunning = selection.any(
            (id) => widget.store.actor(id)?.isActiveRun ?? false,
          );
          final blocks = _coalesce(lines);
          _autoScroll();
          return ListView.builder(
            controller: _scroll,
            padding: const EdgeInsets.all(12),
            itemCount: blocks.length + 1,
            itemBuilder: (_, i) {
              if (i == blocks.length) {
                return anyRunning ? const _Cursor() : const _IdleMarker();
              }
              final b = blocks[i];
              if (b.isGap) {
                return const Padding(
                  padding: EdgeInsets.symmetric(vertical: 6),
                  child: Center(
                    child: Text(
                      '… output elided …',
                      style: TextStyle(
                        color: MeshColors.textMuted,
                        fontStyle: FontStyle.italic,
                        fontSize: 12,
                      ),
                    ),
                  ),
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (multi)
                    Padding(
                      padding: const EdgeInsets.only(top: 6, bottom: 2),
                      child: Text(
                        handles[b.actorId] ?? b.actorId,
                        style: kMonoStyle.copyWith(
                          color: MeshColors.accent,
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  SelectableText(
                    b.text,
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textPrimary,
                      height: 1.4,
                    ),
                  ),
                ],
              );
            },
          );
        },
      ),
    );
  }

  /// Coalesce consecutive same-actor chunks into one block; gaps stand alone.
  List<_Block> _coalesce(List<LiveLine> lines) {
    final out = <_Block>[];
    for (final l in lines) {
      if (l.isGap) {
        out.add(_Block(actorId: '', text: '', isGap: true));
        continue;
      }
      if (out.isNotEmpty && !out.last.isGap && out.last.actorId == l.actorId) {
        out.last.text += l.text;
      } else {
        out.add(_Block(actorId: l.actorId, text: l.text));
      }
    }
    return out;
  }

  Widget _hintCentered(String msg) => Center(
    child: Text(msg, style: const TextStyle(color: MeshColors.textMuted)),
  );
}

class _Block {
  _Block({required this.actorId, required this.text, this.isGap = false});
  final String actorId;
  String text;
  final bool isGap;
}

/// Shown in place of the cursor when no selected actor is running: a clear,
/// static marker that the stream is idle rather than a cursor that blinks
/// forever on output that has stopped.
class _IdleMarker extends StatelessWidget {
  const _IdleMarker();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.circle, color: MeshColors.statusRetired, size: 8),
          const SizedBox(width: 8),
          Text(
            'idle — no active run',
            style: kMonoStyle.copyWith(
              color: MeshColors.textMuted,
              fontStyle: FontStyle.italic,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}

/// Blinking terminal cursor.
class _Cursor extends StatefulWidget {
  const _Cursor();
  @override
  State<_Cursor> createState() => _CursorState();
}

class _CursorState extends State<_Cursor> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1000),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) => Opacity(
        opacity: _c.value < 0.5 ? 1 : 0,
        child: Text('▋', style: kMonoStyle.copyWith(color: MeshColors.accent)),
      ),
    );
  }
}
