import 'dart:async';
import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'avatar.dart';
import 'header.dart';
import 'obligation_card.dart';
import 'obligation_dialogs.dart';
import 'reference_preview.dart';

class WorkTab extends StatefulWidget {
  const WorkTab({
    super.key,
    required this.store,
    required this.onSelectView,
  });

  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;

  @override
  State<WorkTab> createState() => _WorkTabState();
}

class _WorkTabState extends State<WorkTab> {
  bool _loading = true;
  String? _error;
  List<ObligationTreeDto> _rootTrees = [];
  final Set<String> _expandedIds = {};
  String? _selectedObligationId;
  StreamSubscription<String?>? _focusSub;
  bool _showDone = false;

  Future<void> _loadRoots() async {
    try {
      setState(() {
        if (_rootTrees.isEmpty) _loading = true;
        _error = null;
      });
      final page = await widget.store.api.fetchObligations(rootsOnly: true);
      final trees = await Future.wait(
        page.obligations.map((o) => widget.store.api.fetchObligationTree(o.id)),
      );
      setState(() {
        _rootTrees = trees;
        _loading = false;
      });
      _checkFocusLink();
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _checkFocusLink() {
    final focusedId = widget.store.focusedObligationId.valueOrNull;
    if (focusedId != null) {
      _expandAncestors(focusedId);
    }
  }

  bool _expandAncestors(String targetId) {
    for (final rootTree in _rootTrees) {
      final path = _findPath(rootTree, targetId);
      if (path != null) {
        setState(() {
          _expandedIds.addAll(path.sublist(0, path.length - 1));
          _selectedObligationId = targetId;
        });
        return true;
      }
    }
    return false;
  }

  List<String>? _findPath(ObligationTreeDto node, String targetId) {
    if (node.obligation.id == targetId) {
      return [targetId];
    }
    for (final child in node.children) {
      final path = _findPath(child, targetId);
      if (path != null) {
        return [node.obligation.id, ...path];
      }
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _loadRoots();
    _focusSub = widget.store.focusedObligationId.listen((focusedId) {
      if (focusedId != null && !_loading) {
        _expandAncestors(focusedId);
      }
    });
  }

  @override
  void dispose() {
    _focusSub?.cancel();
    super.dispose();
  }

  List<_FlatNode> _flattenTree(List<ObligationTreeDto> nodes, int depth) {
    final result = <_FlatNode>[];
    for (final node in nodes) {
      if (!_showDone && node.obligation.isTerminal) continue;
      final id = node.obligation.id;
      final hasVisibleChildren = _showDone
          ? node.children.isNotEmpty
          : node.children.any((c) => !c.obligation.isTerminal);
      final isCollapsed = !_expandedIds.contains(id);
      result.add(_FlatNode(node.obligation, depth, hasVisibleChildren, isCollapsed));
      if (hasVisibleChildren && !isCollapsed) {
        result.addAll(_flattenTree(node.children, depth + 1));
      }
    }
    return result;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (_error != null) {
      return Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                'Failed to load work queue: $_error',
                style: const TextStyle(color: MeshColors.textSecondary),
              ),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed: _loadRoots,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    final flattened = _flattenTree(_rootTrees, 0);

    return Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final isNarrow = constraints.maxWidth < 700;

          if (isNarrow) {
            if (_selectedObligationId != null) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _narrowBackBar(),
                  const Divider(height: 1, color: MeshColors.border),
                  Expanded(
                    child: _DetailView(
                      obligationId: _selectedObligationId!,
                      store: widget.store,
                      onSelectView: widget.onSelectView,
                      onMutated: _loadRoots,
                    ),
                  ),
                ],
              );
            }
            return _sidebar(flattened);
          }

          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(width: 320, child: _sidebar(flattened)),
              const VerticalDivider(width: 1, color: MeshColors.border),
              Expanded(
                child: _selectedObligationId != null
                    ? _DetailView(
                        obligationId: _selectedObligationId!,
                        store: widget.store,
                        onSelectView: widget.onSelectView,
                        onMutated: _loadRoots,
                      )
                    : const Center(
                        child: Text(
                          'Select an obligation from the tree.',
                          style: TextStyle(color: MeshColors.textMuted, fontSize: 14),
                        ),
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _narrowBackBar() => Container(
        height: 48,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        color: MeshColors.bgSecondary,
        child: Row(
          children: [
            IconButton(
              icon: const Icon(Icons.arrow_back, color: MeshColors.textSecondary, size: 20),
              onPressed: () => setState(() => _selectedObligationId = null),
            ),
            const SizedBox(width: 8),
            const Text(
              'Back to List',
              style: TextStyle(
                color: MeshColors.textPrimary,
                fontWeight: FontWeight.w600,
                fontSize: 14,
              ),
            ),
          ],
        ),
      );

  Widget _sidebar(List<_FlatNode> nodes) => Container(
        decoration: const BoxDecoration(
          color: MeshColors.bgSecondary,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 12, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    'WORK QUEUE',
                    style: TextStyle(
                      color: MeshColors.textSecondary,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.8,
                    ),
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        icon: Icon(_showDone ? Icons.visibility : Icons.visibility_off, size: 18),
                        onPressed: () => setState(() => _showDone = !_showDone),
                        tooltip: _showDone ? 'Hide Done' : 'Show Done',
                      ),
                      IconButton(
                        icon: const Icon(Icons.add, size: 18),
                        onPressed: () => showCreateObligationDialog(
                          context,
                          widget.store,
                          onCreated: _loadRoots,
                        ),
                        tooltip: 'New Root Obligation',
                      ),
                      IconButton(
                        icon: const Icon(Icons.refresh, size: 18),
                        onPressed: _loadRoots,
                        tooltip: 'Refresh Queue',
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: MeshColors.border),
            Expanded(
              child: nodes.isEmpty
                  ? const Center(
                      child: Text(
                        'No obligations found',
                        style: TextStyle(color: MeshColors.textMuted),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: nodes.length,
                      itemBuilder: (context, index) {
                        final node = nodes[index];
                        final isSelected = node.obligation.id == _selectedObligationId;

                        return InkWell(
                          onTap: () => widget.store.setFocusedObligationId(node.obligation.id),
                          child: Container(
                            color: isSelected ? MeshColors.bgSelected : null,
                            padding: EdgeInsets.only(
                              left: 12.0 + (node.depth * 16.0),
                              right: 12.0,
                              top: 8.0,
                              bottom: 8.0,
                            ),
                            child: Row(
                              children: [
                                SizedBox(
                                  width: 24,
                                  height: 24,
                                  child: node.hasChildren
                                      ? IconButton(
                                          padding: EdgeInsets.zero,
                                          icon: Icon(
                                            node.isCollapsed
                                                ? Icons.chevron_right
                                                : Icons.keyboard_arrow_down,
                                            size: 18,
                                            color: MeshColors.textMuted,
                                          ),
                                          onPressed: () {
                                            setState(() {
                                              if (node.isCollapsed) {
                                                _expandedIds.add(node.obligation.id);
                                              } else {
                                                _expandedIds.remove(node.obligation.id);
                                              }
                                            });
                                          },
                                        )
                                      : null,
                                ),
                                const SizedBox(width: 4),
                                _statusDot(node.obligation.status),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        node.obligation.heading,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                          color: isSelected
                                              ? MeshColors.textPrimary
                                              : MeshColors.textSecondary,
                                          fontSize: 13,
                                          fontWeight:
                                              isSelected ? FontWeight.bold : FontWeight.normal,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      );

  Widget _statusDot(String status) {
    Color color = MeshColors.statusIdle;
    switch (status.toLowerCase()) {
      case 'ready':
        color = MeshColors.statusActive;
        break;
      case 'waiting':
        color = MeshColors.statusIdle;
        break;
      case 'done':
        color = MeshColors.statusRetired;
        break;
      case 'cancelled':
        color = MeshColors.statusHalted;
        break;
      case 'scheduled':
        color = MeshColors.accent;
        break;
    }
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
      ),
    );
  }
}

class _FlatNode {
  _FlatNode(this.obligation, this.depth, this.hasChildren, this.isCollapsed);
  final ObligationDto obligation;
  final int depth;
  final bool hasChildren;
  final bool isCollapsed;
}

class _DetailView extends StatelessWidget {
  const _DetailView({
    required this.obligationId,
    required this.store,
    required this.onSelectView,
    this.onMutated,
  });

  final String obligationId;
  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;
  final VoidCallback? onMutated;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<ObligationDetailSnapshot>(
      future: store.api.fetchObligationDetail(obligationId),
      builder: (context, snapshot) {
        if (snapshot.hasError && !snapshot.hasData) {
          return Center(
            child: Text(
              'Detail unavailable: ${snapshot.error}',
              style: const TextStyle(color: MeshColors.textSecondary),
            ),
          );
        }
        if (!snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }

        final data = snapshot.data!;
        final o = data.obligation;

        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Row(
              children: [
                _Chip(o.status),
                const SizedBox(width: 10),
                Expanded(
                  child: SelectableText(
                    o.id,
                    style: const TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 12,
                      fontFamily: kMonoFontFamily,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            SelectableText(
              o.heading,
              style: const TextStyle(
                color: MeshColors.textPrimary,
                fontSize: 22,
                fontWeight: FontWeight.bold,
              ),
            ),
            if (o.body != null) ...[
              const SizedBox(height: 10),
              SelectableText(
                o.body!,
                style: const TextStyle(
                  color: MeshColors.textSecondary,
                  fontSize: 13.5,
                  height: 1.5,
                ),
              ),
            ],
            const SizedBox(height: 24),
            if (data.artifacts.isNotEmpty) ...[
              _SectionHeader('CITED ARTIFACTS'),
              for (final artifact in data.artifacts)
                ReferencePreview(
                  reference: artifact.reference ??
                      // Unresolvable in v1 (anything but mesh chat). Still shown:
                      // the citation exists and is worth seeing even when we
                      // cannot expand it.
                      ReferenceDto(
                        ref: artifact.ref,
                        scheme: artifact.ref.split(':').first,
                        title: artifact.ref,
                        unavailable: 'Not resolvable yet — only mesh chat is read back so far.',
                      ),
                  label: artifact.label,
                  attachedBy: artifact.attachedBy,
                ),
              const SizedBox(height: 16),
            ],
            _SectionHeader('OWNER'),
            _ownerPanel(o.ownerId),
            // Shown even when absent: linking an obligation to the issue it
            // turned into is a normal later step, and a section that only
            // appears once a ref exists gives no way to add the first one.
            const SizedBox(height: 24),
            _SectionHeader('EXTERNAL LINK'),
            _externalRefPanel(context, o),
            const SizedBox(height: 24),
            _SectionHeader('CHILDREN'),
            _childrenPanel(context, data),
            const SizedBox(height: 28),
            _SectionHeader('OBLIGATION ACTIONS'),
            _actionsPanel(context, data),
          ],
        );
      },
    );
  }

  Widget _ownerPanel(String ownerId) {
    // One id space: the category is read off the id's prefix, the same way
    // `isHumanOperator` does server-side. A known actor renders as its handle;
    // anything else renders as the id itself.
    final isHuman = ownerId.startsWith('human:');
    final isSystem = ownerId.startsWith('system:');
    final isActor = !isHuman && !isSystem;
    final displayId = store.actor(ownerId)?.handle ?? ownerId;
    // The second line exists to disambiguate the first. When the first line
    // already IS the raw id — the operator, a system component, or an actor
    // this dashboard has no record of — repeating it says nothing, so fall back
    // to the category the prefix encodes. That is the cue the old `Kind: ACTOR`
    // line carried before owner_kind was dropped.
    final ownerSubtitle = displayId != ownerId
        ? ownerId
        : isHuman
            ? 'Operator'
            : isSystem
                ? 'System component'
                : 'Actor — not in this mesh view';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          if (isActor)
            ActorAvatar(id: ownerId, size: 28)
          else
            const CircleAvatar(
              radius: 14,
              backgroundColor: Color(0xFF1E293B),
              child: Icon(Icons.person, size: 16, color: MeshColors.textSecondary),
            ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  displayId,
                  style: const TextStyle(
                    color: MeshColors.textPrimary,
                    fontWeight: FontWeight.w600,
                    fontFamily: kMonoFontFamily,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  ownerSubtitle,
                  style: const TextStyle(color: MeshColors.textMuted, fontSize: 11),
                ),
              ],
            ),
          ),
          if (isActor)
            TextButton(
              onPressed: () {
                store.clickActor(ownerId);
                store.setDetailPanelIndex(4); // Select Inbox tab
                onSelectView(DashboardView.actors);
              },
              child: const Text('View Owner Inbox →', style: TextStyle(color: MeshColors.accent)),
            )
          else if (isHuman)
            TextButton(
              onPressed: () {
                onSelectView(DashboardView.overview);
              },
              child: const Text('View Owner Queue →', style: TextStyle(color: MeshColors.accent)),
            ),
        ],
      ),
    );
  }

  Widget _externalRefPanel(BuildContext context, ObligationDto o) {
    final ref = o.externalRef?.trim() ?? '';
    final edit = o.isTerminal
        ? null
        : IconButton(
            icon: const Icon(Icons.edit_outlined, size: 16, color: MeshColors.textSecondary),
            tooltip: ref.isEmpty ? 'Link an issue, PR or repo' : 'Change or unlink',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => showEditExternalRefDialog(context, store, o, onUpdated: onMutated),
          );
    if (ref.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            const Icon(Icons.link_off, color: MeshColors.textMuted, size: 20),
            const SizedBox(width: 12),
            const Expanded(
              child: Text(
                'Not linked to an issue, PR or repository.',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 12.5),
              ),
            ),
            ?edit,
          ],
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.link, color: MeshColors.accent, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: SelectableText(
              ref,
              style: const TextStyle(
                color: MeshColors.accent,
                fontFamily: kMonoFontFamily,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          ?edit,
        ],
      ),
    );
  }

  Widget _childrenPanel(BuildContext context, ObligationDetailSnapshot data) {
    final list = data.children;

    if (list.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: MeshColors.bgSecondary,
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Expanded(
              child: Text(
                'This obligation is a leaf node (no decomposition children).',
                style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
              ),
            ),
            if (!data.obligation.isTerminal)
              TextButton.icon(
                onPressed: () => showCreateObligationDialog(
                  context,
                  store,
                  defaultParentId: data.obligation.id,
                  defaultOwnerId: data.obligation.ownerId,
                  onCreated: onMutated,
                ),
                icon: const Icon(Icons.add, size: 14),
                label: const Text('Add Child', style: TextStyle(fontSize: 11)),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  foregroundColor: MeshColors.accent,
                ),
              ),
          ],
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [

          for (var i = 0; i < list.length; i++) ...[
            Builder(
              builder: (innerContext) {
                final c = list[i];
                return ObligationRow(
                  obligation: c,
                  store: store,
                  showOwner: true,
                  showActions: false, // In the original, the work_tab children row didn't have actions menu.
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  showReorder: list.length > 1,
                  onMoveUp: i > 0 ? () async {
                    final previousId = i - 2 >= 0 ? list[i - 2].id : null;
                    final nextId = list[i - 1].id;
                    try {
                      await store.api.reorderObligation(
                        c.id,
                        previousId: previousId,
                        nextId: nextId,
                      );
                      onMutated?.call();
                    } catch (err) {
                      if (innerContext.mounted) {
                        ScaffoldMessenger.of(innerContext).showSnackBar(
                          SnackBar(content: Text('Failed to reorder: $err'), backgroundColor: MeshColors.statusHalted),
                        );
                      }
                    }
                  } : null,
                  onMoveDown: i < list.length - 1 ? () async {
                    final previousId = list[i + 1].id;
                    final nextId = i + 2 < list.length ? list[i + 2].id : null;
                    try {
                      await store.api.reorderObligation(
                        c.id,
                        previousId: previousId,
                        nextId: nextId,
                      );
                      onMutated?.call();
                    } catch (err) {
                      if (innerContext.mounted) {
                        ScaffoldMessenger.of(innerContext).showSnackBar(
                          SnackBar(content: Text('Failed to reorder: $err'), backgroundColor: MeshColors.statusHalted),
                        );
                      }
                    }
                  } : null,
                );
              },
            ),
            const Divider(height: 1, color: MeshColors.border),
          ],
        ],
      ),
    );
  }

  Widget _actionsPanel(BuildContext context, ObligationDetailSnapshot data) {
    final o = data.obligation;
    final isTerminal = o.isTerminal;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border.all(color: MeshColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (isTerminal) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: o.isDone ? const Color(0xFF064E3B) : const Color(0xFF450A0A),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    o.isDone ? Icons.check_circle : Icons.cancel,
                    size: 16,
                    color: o.isDone ? const Color(0xFF34D399) : const Color(0xFFF87171),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'This obligation is in terminal status (${o.status.toUpperCase()}).',
                    style: TextStyle(
                      color: o.isDone ? const Color(0xFF34D399) : const Color(0xFFF87171),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ] else ...[
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                ElevatedButton.icon(
                  onPressed: () => confirmAndSetObligationStatus(
                    context,
                    store,
                    o,
                    'done',
                    onUpdated: onMutated,
                  ),
                  icon: const Icon(Icons.check_circle_outline, size: 16),
                  label: const Text('Mark Done'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF064E3B),
                    foregroundColor: const Color(0xFF34D399),
                  ),
                ),
                ElevatedButton.icon(
                  onPressed: () => confirmAndSetObligationStatus(
                    context,
                    store,
                    o,
                    'cancelled',
                    onUpdated: onMutated,
                  ),
                  icon: const Icon(Icons.cancel_outlined, size: 16),
                  label: const Text('Cancel Obligation'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF450A0A),
                    foregroundColor: const Color(0xFFF87171),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => showReassignObligationDialog(
                    context,
                    store,
                    o,
                    onReassigned: onMutated,
                  ),
                  icon: const Icon(Icons.person_outline, size: 16),
                  label: const Text('Reassign...'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: MeshColors.accent,
                    side: const BorderSide(color: MeshColors.border),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => showReparentObligationDialog(
                    context,
                    store,
                    o,
                    onReparented: onMutated,
                  ),
                  icon: const Icon(Icons.drive_file_move_outlined, size: 16),
                  label: const Text('Reparent...'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: MeshColors.accent,
                    side: const BorderSide(color: MeshColors.border),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => showCreateObligationDialog(
                    context,
                    store,
                    defaultParentId: o.id,
                    defaultOwnerId: o.ownerId,
                    onCreated: onMutated,
                  ),
                  icon: const Icon(Icons.add_task, size: 16),
                  label: const Text('Add Child...'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: MeshColors.accent,
                    side: const BorderSide(color: MeshColors.border),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: const TextStyle(
          color: MeshColors.textSecondary,
          fontSize: 11,
          fontWeight: FontWeight.bold,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    Color bg = const Color(0xFF1E293B);
    Color fg = const Color(0xFF94A3B8);
    Color border = const Color(0xFF334155);

    switch (label.toLowerCase()) {
      case 'ready':
        bg = const Color(0xFF064E3B);
        fg = const Color(0xFF34D399);
        border = const Color(0xFF047857);
        break;
      case 'waiting':
        bg = const Color(0xFF78350F);
        fg = const Color(0xFFFBBF24);
        border = const Color(0xFFB45309);
        break;
      case 'done':
        bg = const Color(0xFF14532D);
        fg = const Color(0xFF4ADE80);
        border = const Color(0xFF15803D);
        break;
      case 'cancelled':
        bg = const Color(0xFF450A0A);
        fg = const Color(0xFFF87171);
        border = const Color(0xFFB91C1C);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 10,
          color: fg,
          fontFamily: kMonoFontFamily,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
