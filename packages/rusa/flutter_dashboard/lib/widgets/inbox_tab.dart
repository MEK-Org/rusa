import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'reference_preview.dart';
import '../util.dart';
import 'header.dart';
import 'obligation_card.dart';
import 'obligation_dialogs.dart';

class InboxTab extends StatefulWidget {
  const InboxTab({
    super.key,
    required this.actorId,
    required this.store,
    this.onSelectView,
  });

  final String actorId;
  final DashboardStore store;
  final ValueChanged<DashboardView>? onSelectView;

  @override
  State<InboxTab> createState() => _InboxTabState();
}

class _InboxTabState extends State<InboxTab> {
  late Future<Map<String, dynamic>> _page;

  Future<Map<String, dynamic>> _loadInbox() async {
    final api = widget.store.api;
    final results = await Future.wait([
      api.fetchInbox(widget.actorId, status: 'unhandled'),
      api.fetchInbox(widget.actorId, status: 'handled', limit: 10),
      api.fetchObligations(ownerId: widget.actorId),
      // Fetched as its own filtered page rather than carved out of the
      // unfiltered page above: with enough ready/waiting rows, that page's
      // limit could be exhausted before a single scheduled row appears in
      // it, silently dropping every scheduled row from this section.
      api.fetchObligations(ownerId: widget.actorId, status: 'scheduled'),
    ]);

    final inboxPending = results[0] as Map<String, dynamic>;
    final inboxHandled = results[1] as Map<String, dynamic>;
    final obligationPage = results[2] as ObligationPage;
    final scheduledPage = results[3] as ObligationPage;

    final pending = inboxPending['entries'] ?? const [];
    final resolved = inboxHandled['entries'] ?? const [];

    final readyObligations = obligationPage.obligations
        .where((o) => o.isReady)
        .toList();
    final waitingObligations = obligationPage.obligations
        .where((o) => o.isWaiting)
        .toList();
    final scheduledObligations = scheduledPage.obligations.toList()
      ..sort((a, b) => (a.nextReadyAt ?? '').compareTo(b.nextReadyAt ?? ''));

    // Fetch blockers for waiting obligations
    final blockers = await Future.wait(
      waitingObligations.map((o) => api.fetchObligationDetail(o.id)),
    );

    final blockerMap = {
      for (var i = 0; i < waitingObligations.length; i++)
        waitingObligations[i].id: blockers[i].blockingChildren,
    };

    return {
      'pending': pending,
      'resolved': resolved,
      'readyObligations': readyObligations,
      'waitingObligations': waitingObligations,
      'scheduledObligations': scheduledObligations,
      'blockerMap': blockerMap,
    };
  }

  void _refresh() {
    setState(() {
      _page = _loadInbox();
    });
  }

  @override
  void initState() {
    super.initState();
    _page = _loadInbox();
  }

  @override
  void didUpdateWidget(covariant InboxTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.actorId != widget.actorId) {
      _page = _loadInbox();
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<Map<String, dynamic>>(
    future: _page,
    builder: (_, snapshot) {
      if (snapshot.hasError && !snapshot.hasData) {
        return Center(
          child: Text(
            'Inbox unavailable: ${snapshot.error}',
            style: const TextStyle(color: MeshColors.textMuted),
          ),
        );
      }
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }

      final pending = snapshot.data?['pending'] as List<dynamic>? ?? const [];
      final resolved = snapshot.data?['resolved'] as List<dynamic>? ?? const [];
      final readyObligations =
          snapshot.data?['readyObligations'] as List<ObligationDto>? ??
          const [];
      final waitingObligations =
          snapshot.data?['waitingObligations'] as List<ObligationDto>? ??
          const [];
      final scheduledObligations =
          snapshot.data?['scheduledObligations'] as List<ObligationDto>? ??
          const [];
      final blockerMap =
          snapshot.data?['blockerMap'] as Map<String, List<ObligationDto>>? ??
          const {};

      final hasInbox = pending.isNotEmpty || resolved.isNotEmpty;
      final hasObligations =
          readyObligations.isNotEmpty ||
          waitingObligations.isNotEmpty ||
          scheduledObligations.isNotEmpty;

      if (!hasInbox && !hasObligations) {
        return Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text(
                'No inbox items or obligations.',
                style: TextStyle(color: MeshColors.textMuted),
              ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: () => showCreateObligationDialog(
                  context,
                  widget.store,
                  defaultOwnerId: widget.actorId,
                  onCreated: _refresh,
                ),
                icon: const Icon(Icons.add, size: 16),
                label: const Text('Create Obligation'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: MeshColors.accent,
                  foregroundColor: MeshColors.bgPrimary,
                ),
              ),
            ],
          ),
        );
      }

      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (readyObligations.isNotEmpty) ...[
            _SectionTitle(
              'Ready Obligations',
              '${readyObligations.length} ready',
              action: TextButton.icon(
                onPressed: () => showCreateObligationDialog(
                  context,
                  widget.store,
                  defaultOwnerId: widget.actorId,
                  onCreated: _refresh,
                ),
                icon: const Icon(Icons.add, size: 14),
                label: const Text(
                  'New Obligation',
                  style: TextStyle(fontSize: 11),
                ),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  foregroundColor: MeshColors.accent,
                ),
              ),
            ),
            _obligationsPanel(readyObligations, blockerMap, isReadyList: true),
            const SizedBox(height: 24),
          ],
          if (waitingObligations.isNotEmpty) ...[
            _SectionTitle(
              'Waiting Obligations',
              '${waitingObligations.length} waiting',
            ),
            _obligationsPanel(waitingObligations, blockerMap),
            const SizedBox(height: 24),
          ],
          if (scheduledObligations.isNotEmpty) ...[
            _SectionTitle(
              'Scheduled',
              '${scheduledObligations.length} scheduled',
            ),
            _obligationsPanel(scheduledObligations, blockerMap),
            const SizedBox(height: 24),
          ],
          if (pending.isNotEmpty) ...[
            _SectionTitle(
              'Outstanding inbox signals',
              '${pending.length} pending',
            ),
            _sectionPanel(pending),
            const SizedBox(height: 24),
          ],
          if (resolved.isNotEmpty) ...[
            _SectionTitle(
              'Recently resolved signals',
              'last ${resolved.length}',
            ),
            _sectionPanel(resolved),
          ],
        ],
      );
    },
  );

  Widget _obligationsPanel(
    List<ObligationDto> items,
    Map<String, List<ObligationDto>> blockerMap, {
    bool isReadyList = false,
  }) => DecoratedBox(
    decoration: BoxDecoration(
      color: MeshColors.bgSecondary,
      border: Border.all(color: MeshColors.border),
      borderRadius: BorderRadius.circular(9),
    ),
    child: Column(
      children: [
        for (var index = 0; index < items.length; index++) ...[
          _obligationCard(
            items[index],
            blockerMap[items[index].id],
            items: items,
            index: index,
            isReadyList: isReadyList,
          ),
          if (index < items.length - 1)
            const Divider(height: 1, thickness: 1, color: MeshColors.border),
        ],
      ],
    ),
  );

  Widget _obligationCard(
    ObligationDto o,
    List<ObligationDto>? blockers, {
    required List<ObligationDto> items,
    required int index,
    bool isReadyList = false,
  }) {
    return ObligationRow(
      obligation: o,
      store: widget.store,
      blockers: blockers,
      onSelectView: widget.onSelectView,
      onMutated: _refresh,
      showReorder: isReadyList && items.length > 1,
      onMoveUp: index > 0
          ? () async {
              final previousId = index - 2 >= 0 ? items[index - 2].id : null;
              final nextId = items[index - 1].id;
              try {
                await widget.store.api.reorderObligation(
                  o.id,
                  previousId: previousId,
                  nextId: nextId,
                );
                _refresh();
              } catch (err) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Failed to reorder: $err'),
                      backgroundColor: MeshColors.statusHalted,
                    ),
                  );
                }
              }
            }
          : null,
      onMoveDown: index < items.length - 1
          ? () async {
              final previousId = items[index + 1].id;
              final nextId = index + 2 < items.length
                  ? items[index + 2].id
                  : null;
              try {
                await widget.store.api.reorderObligation(
                  o.id,
                  previousId: previousId,
                  nextId: nextId,
                );
                _refresh();
              } catch (err) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Failed to reorder: $err'),
                      backgroundColor: MeshColors.statusHalted,
                    ),
                  );
                }
              }
            }
          : null,
    );
  }

  /// Clear an entry the actor should not have to answer. The reason is
  /// optional — the ask in #66 is to remove friction, not add a form — but the
  /// server records the operator as the party who cleared it either way.
  Future<void> _dismiss(Map<String, dynamic> entry) async {
    final entryId = entry['id']?.toString() ?? '';
    if (entryId.isEmpty) return;
    final reason = await _askDismissReason(entry);
    if (reason == null) return;
    try {
      await widget.store.api.markInboxHandled(
        widget.actorId,
        entryId,
        reason: reason.isEmpty ? null : reason,
      );
      _refresh();
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to dismiss: $err'),
          backgroundColor: MeshColors.statusHalted,
        ),
      );
    }
  }

  /// Returns the operator's reason, `''` for none, or `null` if they backed out.
  Future<String?> _askDismissReason(Map<String, dynamic> entry) {
    final reasonCtrl = TextEditingController();
    final source = entry['source']?.toString() ?? '';
    return showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: MeshColors.bgSecondary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: const BorderSide(color: MeshColors.border),
        ),
        title: const Text(
          'Dismiss inbox signal',
          style: TextStyle(
            color: MeshColors.textPrimary,
            fontSize: 16,
            fontWeight: FontWeight.bold,
          ),
        ),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                source.isEmpty ? entry['id']?.toString() ?? '' : source,
                style: const TextStyle(
                  color: MeshColors.accent,
                  fontSize: 12,
                  fontFamily: kMonoFontFamily,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'The actor will no longer be queued for this signal. It is '
                'recorded as cleared by the operator.',
                style: TextStyle(
                  color: MeshColors.textMuted,
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: reasonCtrl,
                autofocus: true,
                maxLines: 2,
                style: const TextStyle(
                  color: MeshColors.textPrimary,
                  fontSize: 13,
                ),
                decoration: const InputDecoration(
                  labelText: 'Reason (optional)',
                  labelStyle: TextStyle(
                    color: MeshColors.textSecondary,
                    fontSize: 12,
                  ),
                  hintText:
                      'e.g. run cancelled by hand; nothing left to answer',
                  hintStyle: TextStyle(
                    color: MeshColors.textMuted,
                    fontSize: 12,
                  ),
                  filled: true,
                  fillColor: MeshColors.bgPrimary,
                  border: OutlineInputBorder(
                    borderSide: BorderSide(color: MeshColors.border),
                  ),
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                ),
                onSubmitted: (value) =>
                    Navigator.of(dialogContext).pop(value.trim()),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            style: TextButton.styleFrom(
              foregroundColor: MeshColors.textSecondary,
            ),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () =>
                Navigator.of(dialogContext).pop(reasonCtrl.text.trim()),
            style: ElevatedButton.styleFrom(
              backgroundColor: MeshColors.accent,
              foregroundColor: MeshColors.bgPrimary,
            ),
            child: const Text('Dismiss'),
          ),
        ],
      ),
    );
  }

  Widget _sectionPanel(List<dynamic> entries) => DecoratedBox(
    decoration: BoxDecoration(
      color: MeshColors.bgSecondary,
      border: Border.all(color: MeshColors.border),
      borderRadius: BorderRadius.circular(9),
    ),
    child: Column(
      children: [
        for (var index = 0; index < entries.length; index++) ...[
          _entryCard(entries[index] as Map<String, dynamic>),
          if (index < entries.length - 1)
            const Divider(height: 1, thickness: 1, color: MeshColors.border),
        ],
      ],
    ),
  );

  Widget _entryCard(Map<String, dynamic> e) {
    final payload = e['payload'] as Map<String, dynamic>? ?? const {};
    final rawReference = e['reference'];
    final reference = rawReference is Map<String, dynamic>
        ? ReferenceDto.fromJson(rawReference)
        : null;
    final handled = e['handledAt'] != null;
    final arrivedAt = e['deliveredAt'] ?? e['seenAt'] ?? e['createdAt'];
    final handledAt = e['handledAt'];
    final content =
        payload['content']?.toString() ??
        payload.entries
            .where(
              (x) =>
                  x.key != 'type' &&
                  x.key != 'priority' &&
                  x.key != 'messageId' &&
                  x.key != 'fromId',
            )
            .map((x) => '${x.key}: ${x.value}')
            .join('\n');
    return Opacity(
      opacity: handled ? .86 : 1,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _InboxChip(payload['type']?.toString() ?? 'INBOX ITEM'),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    e['source']?.toString() ?? '',
                    style: const TextStyle(
                      color: MeshColors.accent,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (arrivedAt != null) ...[
                  const SizedBox(width: 8),
                  Text(
                    'Arrived: ${formatTs(arrivedAt.toString())}',
                    style: const TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 11,
                      fontFamily: kMonoFontFamily,
                    ),
                  ),
                ],
                // Only an outstanding entry is dismissible. A resolved one already
                // carries someone's account of it, and the server will not let a
                // second clear overwrite that note.
                if (!handled) ...[
                  const SizedBox(width: 8),
                  TextButton.icon(
                    onPressed: () => _dismiss(e),
                    icon: const Icon(Icons.check_circle_outline, size: 14),
                    label: const Text(
                      'Dismiss',
                      style: TextStyle(fontSize: 11),
                    ),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      foregroundColor: MeshColors.textSecondary,
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 9),
            // A reference the server could resolve renders through the same
            // widget as an obligation's cited artifacts. Everything else keeps
            // the raw payload dump, which is honest for v1: no resolver exists
            // for those sources yet, and inventing a prettier rendering would
            // hide that.
            if (reference != null)
              ReferencePreview(
                reference: reference,
                resolveActorHandle: (id) =>
                    widget.store.actor(id)?.handle ?? id,
              )
            else
              Text(
                content.isEmpty ? 'No attached contents.' : content,
                style: const TextStyle(
                  color: Color(0xFFCBD5E1),
                  height: 1.5,
                  fontFamily: kMonoFontFamily,
                  fontSize: 12.5,
                ),
              ),
            if (handled) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: 10,
                ),
                decoration: const BoxDecoration(
                  color: Color(0xFF0D201D),
                  border: Border(
                    left: BorderSide(color: MeshColors.statusActive, width: 2),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (handledAt != null) ...[
                      Text(
                        'Handled: ${formatTs(handledAt.toString())}',
                        style: const TextStyle(
                          color: Color(0xFF6EE7B7),
                          fontSize: 11,
                          fontFamily: kMonoFontFamily,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (e['handledNote']?.toString().trim().isNotEmpty ==
                          true)
                        const SizedBox(height: 4),
                    ],
                    if (e['handledNote']?.toString().trim().isNotEmpty == true)
                      RichText(
                        text: TextSpan(
                          style: const TextStyle(
                            color: Color(0xFFC8DED7),
                            fontSize: 12.5,
                            height: 1.45,
                          ),
                          children: [
                            const TextSpan(
                              text: 'Addressed: ',
                              style: TextStyle(fontWeight: FontWeight.w700),
                            ),
                            TextSpan(text: e['handledNote'].toString()),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.label, this.detail, {this.action});
  final String label;
  final String detail;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 11, top: 4),
    child: Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: const TextStyle(
              color: MeshColors.textPrimary,
              fontWeight: FontWeight.w700,
              fontSize: 16,
            ),
          ),
        ),
        Text(
          detail,
          style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
        ),
        if (action != null) ...[const SizedBox(width: 8), action!],
      ],
    ),
  );
}

class _InboxChip extends StatelessWidget {
  const _InboxChip(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
    decoration: BoxDecoration(
      color: const Color(0xFF173654),
      border: Border.all(color: const Color(0xFF24527D)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      label.toUpperCase(),
      style: const TextStyle(
        fontSize: 10,
        color: Color(0xFFB8DFFC),
        fontFamily: kMonoFontFamily,
      ),
    ),
  );
}
