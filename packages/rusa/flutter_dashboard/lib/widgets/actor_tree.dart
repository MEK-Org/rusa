import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:rxdart/rxdart.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'avatar.dart';
import 'status_dot.dart';

/// Left sidebar: "Active Hierarchy" header + Show-Retired toggle + the alive
/// actor tree. Selection honors click / ctrl·cmd-click (toggle) / shift-click
/// (range), driven by the store's state machine.
class ActorTree extends StatelessWidget {
  const ActorTree({
    super.key,
    required this.store,
    this.width = 360,
    this.touchTargets = false,
  });

  final DashboardStore store;

  /// Fixed sidebar width on wide screens; pass `double.infinity` to fill the
  /// available width when the tree is the full-screen list on narrow (mobile)
  /// layouts.
  final double width;

  /// Enlarges row tap targets (taller rows) for comfortable touch on phones.
  final bool touchTargets;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      decoration: const BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border(right: BorderSide(color: MeshColors.border)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(context),
          const Divider(height: 1, color: MeshColors.border),
          Expanded(
            child: StreamBuilder<List<Object?>>(
              stream: Rx.combineLatestList<Object?>([
                store.showRetired,
                store.selection,
                store.actorStates,
                store.primary,
                store.collapsed,
                store.customActorOrder,
              ]),
              builder: (_, _) {
                final visible = store.flattenedVisible();
                final depths = _depths(store.flattenedVisible());
                final selection = store.selection.value;
                final primary = store.primary.value;
                if (visible.isEmpty) {
                  return const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text(
                        'No actors',
                        style: TextStyle(color: MeshColors.textMuted),
                      ),
                    ),
                  );
                }
                return ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: visible.length,
                  itemBuilder: (_, i) {
                    final t = visible[i];
                    final hasVisibleChildren = store.actorStates.value.actors.values.any(
                      (c) => c.thread.parentId == t.id && store.isThreadVisible(c.thread),
                    );
                    final isCollapsed = store.collapsed.value.contains(t.id);
                    return _ActorRow(
                      thread: t,
                      depth: depths[t.id] ?? 0,
                      selected: selection.contains(t.id),
                      isPrimary: primary == t.id,
                      dot: store.dotFor(t),
                      touchTargets: touchTargets,
                      onSelect: () => _select(t.id),
                      hasChildren: hasVisibleChildren,
                      isCollapsed: isCollapsed,
                      onToggleCollapse: () => store.toggleCollapsed(t.id),
                      store: store,
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _header(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 16, 12, 12),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        const Flexible(
          child: Text(
            'Active Hierarchy',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: MeshColors.textSecondary,
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
            ),
          ),
        ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              tooltip: 'Spawn actor',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.add, size: 19),
              onPressed: () => _showSpawnDialog(context),
            ),
            StreamBuilder<bool>(
              stream: store.showRetired,
              initialData: false,
              builder: (_, snap) => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Retired',
                    style: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                  ),
                  const SizedBox(width: 4),
                  Transform.scale(
                    scale: 0.8,
                    child: Switch(
                      value: snap.data ?? false,
                      activeThumbColor: MeshColors.accent,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      onChanged: store.setShowRetired,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    ),
  );

  Future<void> _showSpawnDialog(BuildContext context) async {
    try {
      final providers = await store.fetchRootControlProviders();
      if (!context.mounted) return;
      final request = await showDialog<_SpawnRequest>(
        context: context,
        builder: (_) => _SpawnActorDialog(providers: providers),
      );
      if (request == null || !context.mounted) return;
      await store.spawnRootChild(
        charter: request.charter,
        title: request.title,
        provider: request.provider,
        model: request.model,
        maxRuns: request.maxRuns,
      );
    } catch (err) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Could not spawn actor: $err')));
    }
  }

  void _select(String id) {
    final keys = HardwareKeyboard.instance.logicalKeysPressed;
    final shift =
        keys.contains(LogicalKeyboardKey.shiftLeft) ||
        keys.contains(LogicalKeyboardKey.shiftRight);
    final ctrlOrCmd =
        keys.contains(LogicalKeyboardKey.controlLeft) ||
        keys.contains(LogicalKeyboardKey.controlRight) ||
        keys.contains(LogicalKeyboardKey.metaLeft) ||
        keys.contains(LogicalKeyboardKey.metaRight);
    if (shift) {
      store.rangeSelectTo(id);
    } else if (ctrlOrCmd) {
      store.toggleActor(id);
    } else {
      store.clickActor(id);
    }
  }

  /// Depth of each node from its root ancestor (root = 0).
  Map<String, int> _depths(List<ThreadDto> all) {
    final parent = {for (final t in all) t.id: t.parentId};
    final cache = <String, int>{};
    int depthOf(String id) {
      final cached = cache[id];
      if (cached != null) return cached;
      final p = parent[id];
      final d = (p == null || !parent.containsKey(p)) ? 0 : depthOf(p) + 1;
      cache[id] = d;
      return d;
    }

    return {for (final t in all) t.id: depthOf(t.id)};
  }
}

class _SpawnRequest {
  const _SpawnRequest({
    required this.charter,
    this.title,
    this.provider,
    this.model,
    this.maxRuns,
  });

  final String charter;
  final String? title;
  final String? provider;
  final String? model;
  final int? maxRuns;
}

class _SpawnActorDialog extends StatefulWidget {
  const _SpawnActorDialog({required this.providers});

  final List<String> providers;

  @override
  State<_SpawnActorDialog> createState() => _SpawnActorDialogState();
}

class _SpawnActorDialogState extends State<_SpawnActorDialog> {
  final _formKey = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _charter = TextEditingController();
  final _model = TextEditingController();
  final _maxRuns = TextEditingController();
  String? _provider;

  @override
  void initState() {
    super.initState();
    _provider = widget.providers.firstOrNull;
  }

  @override
  void dispose() {
    _title.dispose();
    _charter.dispose();
    _model.dispose();
    _maxRuns.dispose();
    super.dispose();
  }

  String? _optional(String value) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Spawn actor'),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: _title,
                  decoration: const InputDecoration(labelText: 'Title'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _charter,
                  minLines: 3,
                  maxLines: 6,
                  decoration: const InputDecoration(labelText: 'Charter'),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? 'Charter is required'
                      : null,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _provider,
                  decoration: const InputDecoration(labelText: 'Provider'),
                  items: widget.providers
                      .map(
                        (provider) => DropdownMenuItem(
                          value: provider,
                          child: Text(provider),
                        ),
                      )
                      .toList(),
                  onChanged: (value) => setState(() => _provider = value),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _model,
                  decoration: const InputDecoration(labelText: 'Model'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _maxRuns,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Maximum runs'),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) return null;
                    final parsed = int.tryParse(value);
                    return parsed == null || parsed < 1
                        ? 'Enter a positive integer'
                        : null;
                  },
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (!_formKey.currentState!.validate()) return;
            Navigator.pop(
              context,
              _SpawnRequest(
                charter: _charter.text.trim(),
                title: _optional(_title.text),
                provider: _provider,
                model: _optional(_model.text),
                maxRuns: _optional(_maxRuns.text) == null
                    ? null
                    : int.parse(_maxRuns.text.trim()),
              ),
            );
          },
          child: const Text('Spawn'),
        ),
      ],
    );
  }
}

class _ActorRow extends StatefulWidget {
  const _ActorRow({
    required this.thread,
    required this.depth,
    required this.selected,
    required this.isPrimary,
    required this.dot,
    required this.touchTargets,
    required this.onSelect,
    required this.hasChildren,
    required this.isCollapsed,
    required this.onToggleCollapse,
    required this.store,
  });

  final ThreadDto thread;
  final int depth;
  final bool selected;
  final bool isPrimary;
  final DotState dot;
  final bool touchTargets;
  final VoidCallback onSelect;
  final bool hasChildren;
  final bool isCollapsed;
  final VoidCallback onToggleCollapse;
  final DashboardStore store;

  @override
  State<_ActorRow> createState() => _ActorRowState();
}

class _ActorRowState extends State<_ActorRow> {
  bool _dropBefore = true;

  Widget _buildChevron() {
    if (!widget.hasChildren) {
      return const SizedBox(width: 24);
    }
    return InkWell(
      onTap: widget.onToggleCollapse,
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        width: 24,
        height: 24,
        child: Icon(
          widget.isCollapsed ? Icons.arrow_right : Icons.arrow_drop_down,
          size: 20,
          color: MeshColors.textSecondary,
        ),
      ),
    );
  }

  Widget _buildContent(
    BuildContext context, {
    bool isHoveredTarget = false,
  }) {
    final thread = widget.thread;
    final dot = widget.dot;
    final isRunning = !thread.isRetired && dot == DotState.active;
    final isQueued = !thread.isRetired && dot == DotState.queued;

    return Container(
      decoration: BoxDecoration(
        color: isHoveredTarget
            ? MeshColors.accent.withValues(alpha: 0.08)
            : (widget.selected ? MeshColors.bgSelected : Colors.transparent),
        border: Border(
          top: isHoveredTarget && _dropBefore
              ? const BorderSide(color: MeshColors.accent, width: 2)
              : BorderSide.none,
          bottom: isHoveredTarget && !_dropBefore
              ? const BorderSide(color: MeshColors.accent, width: 2)
              : BorderSide.none,
        ),
      ),
      padding: EdgeInsets.fromLTRB(
        12.0 + widget.depth * 16,
        widget.touchTargets ? 12 : 6,
        12,
        widget.touchTargets ? 12 : 6,
      ),
      child: Row(
        children: [
          _buildChevron(),
          const SizedBox(width: 4),
          // Circular avatar with the live status dot as a corner badge, so
          // run-state stays visible even before the image resolves .
          SizedBox(
            width: 52,
            height: 52,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                ActorAvatar(
                  id: thread.id,
                  size: 52,
                  retired: thread.isRetired,
                  store: widget.store,
                ),
                Positioned(
                  right: -1,
                  bottom: -1,
                  child: Container(
                    padding: const EdgeInsets.all(1.5),
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      color: MeshColors.bgSecondary,
                    ),
                    child: StatusDot(state: dot, size: 7),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  thread.handle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: kMonoStyle.copyWith(
                    fontSize: 16,
                    color: thread.isRetired
                        ? MeshColors.textMuted
                        : MeshColors.textPrimary,
                    fontWeight: widget.selected
                        ? FontWeight.w700
                        : FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  thread.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    color: MeshColors.textMuted,
                  ),
                ),
                if (thread.model != null ||
                    thread.desiredModel != null ||
                    thread.effort != null ||
                    thread.effortChangePending ||
                    thread.commitmentKind != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      if (thread.model != null || thread.desiredModel != null)
                        Flexible(
                          child: Text(
                            thread.desiredModel != null &&
                                    thread.desiredModel != thread.model
                                ? '${thread.model ?? "default"} → ${thread.desiredModel}'
                                : (thread.model ?? ''),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: kMonoStyle.copyWith(
                              fontSize: 11,
                              color: MeshColors.textSecondary,
                            ),
                          ),
                        ),
                      if (thread.effort != null ||
                          thread.effortChangePending) ...[
                        if (thread.model != null || thread.desiredModel != null)
                          const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            thread.effortChangePending &&
                                    thread.desiredEffort != thread.effort
                                ? 'effort ${thread.effort ?? "default"} → ${thread.desiredEffort ?? "default"}'
                                : 'effort ${thread.effort ?? "default"}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: kMonoStyle.copyWith(
                              fontSize: 11,
                              color: MeshColors.textSecondary,
                            ),
                          ),
                        ),
                      ],
                      if (thread.commitmentKind != null) ...[
                        if (thread.model != null ||
                            thread.desiredModel != null ||
                            thread.effort != null ||
                            thread.effortChangePending)
                          const SizedBox(width: 6),
                        _WorkStateBadge(
                          kind: thread.commitmentKind!,
                          compact: true,
                        ),
                      ],
                    ],
                  ),
                ],
              ],
            ),
          ),
          if (isQueued) ...[
            IconButton(
              icon: const Icon(Icons.fast_forward_rounded, size: 18),
              color: MeshColors.textSecondary,
              hoverColor: MeshColors.accent.withValues(alpha: 0.15),
              splashRadius: 14,
              tooltip: 'Run now',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              onPressed: () => widget.store.runNowActor(thread.id),
            ),
            const SizedBox(width: 2),
            IconButton(
              icon: const Icon(Icons.stop_rounded, size: 20),
              color: MeshColors.textSecondary,
              hoverColor: MeshColors.statusHalted.withValues(alpha: 0.15),
              splashRadius: 14,
              tooltip: 'Cancel queued run',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              onPressed: () => widget.store.interruptActor(thread.id),
            ),
          ] else if (isRunning)
            IconButton(
              icon: const Icon(Icons.stop_rounded, size: 20),
              color: MeshColors.textSecondary,
              hoverColor: MeshColors.statusHalted.withValues(alpha: 0.15),
              splashRadius: 14,
              tooltip: 'Interrupt',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              onPressed: () => widget.store.interruptActor(thread.id),
            )
          else if (widget.touchTargets)
            const Padding(
              padding: EdgeInsets.only(left: 6),
              child: Icon(
                Icons.chevron_right,
                size: 18,
                color: MeshColors.textMuted,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildFeedback(BuildContext context) {
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
            StatusDot(state: widget.dot, size: 8),
            const SizedBox(width: 8),
            Text(
              widget.thread.handle,
              style: kMonoStyle.copyWith(
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

  @override
  Widget build(BuildContext context) {
    return DragTarget<ThreadDto>(
      onWillAcceptWithDetails: (details) {
        return details.data.parentId == widget.thread.parentId &&
            details.data.id != widget.thread.id;
      },
      onMove: (details) {
        final renderBox = context.findRenderObject() as RenderBox?;
        if (renderBox != null) {
          final local = renderBox.globalToLocal(details.offset);
          final dropBefore = local.dy < (renderBox.size.height / 2);
          if (dropBefore != _dropBefore) {
            setState(() => _dropBefore = dropBefore);
          }
        }
      },
      onAcceptWithDetails: (details) {
        widget.store.reorderActor(
          details.data.id,
          widget.thread.id,
          before: _dropBefore,
        );
      },
      builder: (context, candidateData, rejectedData) {
        final isHoveredTarget = candidateData.isNotEmpty;
        final childWhenDragging = Opacity(
          opacity: 0.35,
          child: _buildContent(context),
        );
        final child = InkWell(
          onTap: widget.onSelect,
          child: _buildContent(context, isHoveredTarget: isHoveredTarget),
        );

        if (widget.touchTargets) {
          return LongPressDraggable<ThreadDto>(
            data: widget.thread,
            hitTestBehavior: HitTestBehavior.opaque,
            feedback: _buildFeedback(context),
            childWhenDragging: childWhenDragging,
            child: child,
          );
        }

        return Draggable<ThreadDto>(
          data: widget.thread,
          hitTestBehavior: HitTestBehavior.opaque,
          feedback: _buildFeedback(context),
          childWhenDragging: childWhenDragging,
          child: child,
        );
      },
    );
  }
}

class _WorkStateBadge extends StatelessWidget {
  const _WorkStateBadge({required this.kind, this.compact = false});

  final String kind;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 5 : 7,
        vertical: compact ? 2 : 3,
      ),
      decoration: BoxDecoration(
        color: MeshColors.accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(
          color: MeshColors.accent.withValues(alpha: 0.65),
        ),
      ),
      child: Text(
        kind.toUpperCase(),
        style: TextStyle(
          color: MeshColors.accent,
          fontSize: compact ? 9 : 10,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}
