import 'package:flutter/material.dart';
import 'dart:async';
import 'package:rxdart/rxdart.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'avatar.dart';
import 'events_tab.dart';
import 'conversation_tab.dart';
import 'chat_tab.dart';
import 'live_output_tab.dart';
import 'inbox_tab.dart';
import 'header.dart';
import 'status_dot.dart';

/// Short id for the conversation sub-caption — truncates a UUID to 8 chars, but
/// leaves a short id (e.g. "root") intact so `substring` can't RangeError.
String _shortId(String id) => id.length <= 8 ? id : '${id.substring(0, 8)}...';

/// Right pane: the primary actor's header (handle, status, charter, parent, and
/// the full UUID) plus the Events / Live Output tabs.
class DetailPanel extends StatefulWidget {
  const DetailPanel({
    super.key,
    required this.store,
    this.narrow = false,
    this.onSelectView,
  });

  final DashboardStore store;
  final ValueChanged<DashboardView>? onSelectView;

  /// Compact mode for the mobile full-screen detail view: tighter padding, a
  /// smaller header avatar, and evenly-sized non-scrolling tabs so everything
  /// fits a phone width with no horizontal scroll.
  final bool narrow;

  @override
  State<DetailPanel> createState() => _DetailPanelState();
}

class _DetailPanelState extends State<DetailPanel>
    with TickerProviderStateMixin {
  TabController? _tabs;
  int _lastLength = 5;
  StreamSubscription<int>? _tabSub;

  @override
  void initState() {
    super.initState();
    // Eager init: when no actor is selected the TabBar/TabBarView (which read
    // `_tabs`) never build, so a `late` initializer would first run in dispose()
    // — creating a Ticker on a deactivated element and crashing.
    _tabs = TabController(length: 5, vsync: this);
    _tabSub = widget.store.detailPanelIndex.listen((index) {
      if (index >= 0 && index < (_tabs?.length ?? 0)) {
        _tabs?.animateTo(index);
      }
    });
  }

  @override
  void dispose() {
    _tabSub?.cancel();
    _tabs?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatestList<Object?>([
        widget.store.primary,
        widget.store.actorStates,
        widget.store.selection,
        widget.store.walkieActive,
        widget.store.actorStates,
      ]),
      builder: (_, _) {
        final walkieActive = widget.store.walkieActive.valueOrNull ?? false;
        final height = MediaQuery.of(context).size.height;
        final isFullScreenWalkie = walkieActive && height < 500;

        if (isFullScreenWalkie) {
          return ChatTab(
            key: GlobalObjectKey(widget.store),
            store: widget.store,
          );
        }

        final primary = widget.store.primary.value;
        final actorStates = widget.store.actorStates.value;
        final selection = widget.store.selection.value;

        final isConversationMode = selection.length == 2;
        final expectedLength = 5;

        if (_tabs == null || _lastLength != expectedLength) {
          final oldTabs = _tabs;
          if (oldTabs != null) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              oldTabs.dispose();
            });
          }
          _tabs = TabController(length: expectedLength, vsync: this);
          _lastLength = expectedLength;
        }

        ThreadDto? actor;
        ThreadDto? actorA;
        ThreadDto? actorB;
        if (isConversationMode) {
          final list = selection.toList();
          actorA = actorStates.actors[list[0]]?.thread;
          actorB = actorStates.actors[list[1]]?.thread;
          actor = (primary == list[1]) ? actorB : actorA;
        } else {
          actor = actorStates.actors[primary]?.thread;
        }

        if (actor == null &&
            (!isConversationMode || (actorA == null && actorB == null))) {
          return const Center(
            child: Text(
              'Select an actor from the tree.',
              style: TextStyle(color: MeshColors.textMuted, fontSize: 14),
            ),
          );
        }

        final parentId = actor?.parentId;
        final parentHandle = parentId == null
            ? '—'
            : actorStates.actors[parentId]?.thread.handle ?? parentId;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            isConversationMode
                ? _conversationHeader(actorA!, actorB!)
                : _header(actor!, parentHandle),
            _tabBar(isConversationMode),
            const Divider(height: 1, color: MeshColors.border),
            Expanded(
              child: TabBarView(
                controller: _tabs!,
                children: isConversationMode
                    ? [
                        ConversationTab(store: widget.store),
                        EventsTab(store: widget.store),
                        LiveOutputTab(store: widget.store),
                        _InfoView(
                          actor: actor!,
                          parentHandle: parentHandle,
                          store: widget.store,
                        ),
                        InboxTab(actorId: actor.id, store: widget.store, onSelectView: widget.onSelectView),
                      ]
                    : [
                        ChatTab(
                          key: GlobalObjectKey(widget.store),
                          store: widget.store,
                        ),
                        EventsTab(store: widget.store),
                        LiveOutputTab(store: widget.store),
                        _InfoView(
                          actor: actor!,
                          parentHandle: parentHandle,
                          store: widget.store,
                        ),
                        InboxTab(actorId: actor.id, store: widget.store, onSelectView: widget.onSelectView),
                      ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _conversationHeader(ThreadDto a, ThreadDto b) => Padding(
    padding: widget.narrow
        ? const EdgeInsets.fromLTRB(16, 16, 16, 10)
        : const EdgeInsets.fromLTRB(24, 20, 24, 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.only(top: 2, right: widget.narrow ? 12 : 16),
          child: SizedBox(
            width: widget.narrow ? 80 : 110,
            height: widget.narrow ? 50 : 68,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Positioned(
                  left: 0,
                  top: 0,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      ActorAvatar(
                        id: a.id,
                        size: widget.narrow ? 50 : 68,
                        retired: a.isRetired,
                        store: widget.store,
                      ),
                      Positioned(
                        right: 0,
                        bottom: 0,
                        child: Container(
                          padding: const EdgeInsets.all(2),
                          decoration: const BoxDecoration(
                            shape: BoxShape.circle,
                            color: MeshColors.bgPrimary,
                          ),
                          child: StatusDot(
                            state: widget.store.dotFor(a),
                            size: widget.narrow ? 8 : 10,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                Positioned(
                  left: widget.narrow ? 30 : 42,
                  top: 0,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      ActorAvatar(
                        id: b.id,
                        size: widget.narrow ? 50 : 68,
                        retired: b.isRetired,
                        store: widget.store,
                      ),
                      Positioned(
                        right: 0,
                        bottom: 0,
                        child: Container(
                          padding: const EdgeInsets.all(2),
                          decoration: const BoxDecoration(
                            shape: BoxShape.circle,
                            color: MeshColors.bgPrimary,
                          ),
                          child: StatusDot(
                            state: widget.store.dotFor(b),
                            size: widget.narrow ? 8 : 10,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      '${a.handle} ↔ ${b.handle}',
                      style: kMonoStyle.copyWith(
                        fontSize: widget.narrow ? 18 : 22,
                        fontWeight: FontWeight.w700,
                        color: MeshColors.textPrimary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              SelectableText(
                '${_shortId(a.id)} ↔ ${_shortId(b.id)}',
                style: kMonoStyle.copyWith(
                  fontSize: 12,
                  color: MeshColors.textMuted,
                ),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 18,
                runSpacing: 4,
                children: [
                  _meta('Conversation', '2 actors'),
                  if (a.provider != null || b.provider != null)
                    _meta(
                      'Providers',
                      '${a.provider ?? "—"} / ${b.provider ?? "—"}',
                    ),
                ],
              ),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _header(ThreadDto a, String parentHandle) => Padding(
    padding: widget.narrow
        ? const EdgeInsets.fromLTRB(16, 16, 16, 10)
        : const EdgeInsets.fromLTRB(24, 20, 24, 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Larger circular avatar in the detail header (ISSUE_NUM, enlarged ~75%
        // in ISSUE_NUM — 52px → 91px — so the AI portrait reads clearly) with status indicator.
        // Slightly smaller on phones to leave room for the handle/UUID column.
        Padding(
          padding: EdgeInsets.only(top: 2, right: widget.narrow ? 12 : 16),
          child: SizedBox(
            width: widget.narrow ? 64 : 91,
            height: widget.narrow ? 64 : 91,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                ActorAvatar(
                  id: a.id,
                  size: widget.narrow ? 64 : 91,
                  retired: a.isRetired,
                  store: widget.store,
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.all(2.5),
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      color: MeshColors.bgPrimary,
                    ),
                    child: StatusDot(
                      state: widget.store.dotFor(a),
                      size: widget.narrow ? 10 : 13,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 8,
                runSpacing: 6,
                children: [
                  Text(
                    a.handle,
                    style: kMonoStyle.copyWith(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: MeshColors.textPrimary,
                    ),
                  ),
                  _statusBadge(a),
                  if (!a.isRetired) ..._quickActions(a),
                ],
              ),
              const SizedBox(height: 4),
              // Full UUID in the detail header (the tree shows only the
              // handle). The charter lives in its own tab now — it can be
              // very long (esp. root), so the header stays compact.
              SelectableText(
                a.id,
                style: kMonoStyle.copyWith(
                  fontSize: 12,
                  color: MeshColors.textMuted,
                ),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ],
    ),
  );

  List<Widget> _quickActions(ThreadDto a) {
    final dot = widget.store.dotFor(a);
    final isRunning = dot == DotState.active;
    final isQueued = dot == DotState.queued;
    final isIdle = dot == DotState.idle;

    if (isQueued) {
      return [
        IconButton(
          icon: const Icon(Icons.fast_forward_rounded, size: 20),
          color: MeshColors.accent,
          hoverColor: MeshColors.accent.withValues(alpha: 0.15),
          splashRadius: 16,
          tooltip: 'Run now',
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          onPressed: () => widget.store.runNowActor(a.id),
        ),
        const SizedBox(width: 2),
        IconButton(
          icon: const Icon(Icons.stop_rounded, size: 20),
          color: MeshColors.statusHalted,
          hoverColor: MeshColors.statusHalted.withValues(alpha: 0.15),
          splashRadius: 16,
          tooltip: 'Cancel queued run',
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          onPressed: () => widget.store.interruptActor(a.id),
        ),
      ];
    } else if (isRunning) {
      return [
        IconButton(
          icon: const Icon(Icons.stop_rounded, size: 20),
          color: MeshColors.statusHalted,
          hoverColor: MeshColors.statusHalted.withValues(alpha: 0.15),
          splashRadius: 16,
          tooltip: 'Interrupt',
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          onPressed: () => widget.store.interruptActor(a.id),
        ),
      ];
    } else if (isIdle) {
      return [
        IconButton(
          icon: const Icon(Icons.fast_forward_rounded, size: 20),
          color: MeshColors.textSecondary,
          hoverColor: MeshColors.accent.withValues(alpha: 0.15),
          splashRadius: 16,
          tooltip: 'Run now',
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          onPressed: () => widget.store.runNowActor(a.id),
        ),
      ];
    }
    return const [];
  }

  Widget _meta(String label, String value) => RichText(
    text: TextSpan(
      children: [
        TextSpan(
          text: '$label: ',
          style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
        ),
        TextSpan(
          text: value,
          style: kMonoStyle.copyWith(
            color: MeshColors.textSecondary,
            fontSize: 12,
          ),
        ),
      ],
    ),
  );

  Widget _statusBadge(ThreadDto a) {
    final state = widget.store.actorStates.value.actors[a.id];
    final retired = a.isRetired;
    final runState = state?.runState ?? RunState.unknown;
    
    String text;
    Color color;

    if (retired) {
      text = 'RETIRED';
      color = MeshColors.statusRetired;
    } else if (runState == RunState.running || runState == RunState.windingDown) {
      text = 'RUNNING';
      color = MeshColors.statusActive;
    } else if (runState == RunState.queued) {
      text = 'QUEUED';
      color = MeshColors.statusIdle;
    } else {
      text = 'IDLE';
      color = MeshColors.statusRetired;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _tabBar(bool isConversationMode) => StreamBuilder<List<Object?>>(
    stream: Rx.combineLatestList<Object?>([
      widget.store.events,
      widget.store.conversation,
    ]),
    builder: (_, _) {
      final eventsCount = widget.store.events.value.events.length;
      final conversationCount = widget.store.conversation.value.chat.length;
      // On phones the tabs share the full width (no scroll); on wide
      // screens they keep their left-aligned, scrollable, content-sized form.
      return TabBar(
        controller: _tabs!,
        isScrollable: !widget.narrow,
        tabAlignment: widget.narrow ? null : TabAlignment.start,
        indicatorColor: MeshColors.accent,
        labelColor: MeshColors.accent,
        unselectedLabelColor: MeshColors.textSecondary,
        labelPadding: widget.narrow
            ? const EdgeInsets.symmetric(horizontal: 4)
            : null,
        tabs: isConversationMode
            ? [
                _tab(Icons.forum_outlined, 'Conversation', conversationCount),
                _tab(Icons.terminal, 'Events Log', eventsCount),
                _tab(Icons.bolt_outlined, 'Live Output', null),
                _tab(Icons.description_outlined, 'Info', null),
                _tab(Icons.inbox_outlined, 'Inbox', null),
              ]
            : [
                _tab(Icons.chat_bubble_outline, 'Chat', null),
                _tab(Icons.terminal, 'Events Log', eventsCount),
                _tab(Icons.bolt_outlined, 'Live Output', null),
                _tab(Icons.description_outlined, 'Info', null),
                _tab(Icons.inbox_outlined, 'Inbox', null),
              ],
      );
    },
  );

  Widget _tab(IconData icon, String label, int? badge) => Tab(
    // FittedBox: with 4 tabs sharing full width on narrow (no-scroll) layouts,
    // a fixed-size Row overflows at ~390px  — scale down instead.
    child: FittedBox(
      fit: BoxFit.scaleDown,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16),
          const SizedBox(width: 6),
          Text(label),
          if (badge != null && badge > 0) ...[
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: MeshColors.bgTertiary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                '$badge',
                style: const TextStyle(
                  fontSize: 11,
                  color: MeshColors.textSecondary,
                ),
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

/// The actor's Info tab: contains metadata like work-states and the full (possibly very long)
/// charter text in a scrollable, selectable view.
///
/// The thread list only carries a clipped preview of the charter, because it is
/// the same field for every actor on every poll. This is the one place the whole
/// text is shown, so this is the one place that asks for it — the preview renders
/// immediately and is replaced in place when the fetch lands.
class _InfoView extends StatefulWidget {
  const _InfoView({
    required this.actor,
    required this.parentHandle,
    required this.store,
  });

  final ThreadDto actor;
  final String parentHandle;
  final DashboardStore store;

  @override
  State<_InfoView> createState() => _InfoViewState();
}

class _InfoViewState extends State<_InfoView> {
  /// The full charter once it arrives. Null means "still the preview".
  String? _charter;

  /// The actor and preview the charter on screen was fetched for. Set while a
  /// fetch is in flight and kept if it succeeds; a failure clears it.
  String? _loadedFor;

  /// A charter is editable, so the actor's id alone does not identify one. The
  /// preview travels with the list on every poll and changes when the charter
  /// does, which is what lets an edit reach an open panel.
  String get _fetchKey => '${widget.actor.id}\u0000${widget.actor.charterPreview}';

  @override
  void initState() {
    super.initState();
    _loadCharter();
  }

  @override
  void didUpdateWidget(_InfoView old) {
    super.didUpdateWidget(old);
    // Ask on every rebuild and let the key decide, so all three reasons to
    // re-fetch are one condition: a new actor (the tab is reused across
    // selections, so otherwise the panel shows the previous actor's charter
    // under a new handle), an edited charter, and a fetch that failed.
    _loadCharter();
  }

  Future<void> _loadCharter() async {
    final key = _fetchKey;
    if (_loadedFor == key) return;
    _loadedFor = key;
    final id = widget.actor.id;
    setState(() => _charter = null);
    try {
      final charter = await widget.store.fetchCharter(id);
      // The operator can select another actor while this is in flight.
      if (!mounted || _loadedFor != key) return;
      setState(() => _charter = charter);
    } catch (_) {
      // The preview stays on screen and the store has already surfaced the
      // error — but release the key, so the next poll retries rather than
      // pinning the panel to the preview for as long as this actor is selected.
      if (_loadedFor == key) _loadedFor = null;
    }
  }

  ThreadDto get actor => widget.actor;
  String get parentHandle => widget.parentHandle;

  /// The preview until the full charter lands, and after that the full charter.
  /// Falling back to the preview rather than to empty means a failed or slow
  /// fetch degrades to less text, not to "No charter."
  String get charter => _charter ?? widget.actor.charterPreview;

  Widget _meta(String label, String value) => RichText(
    text: TextSpan(
      children: [
        TextSpan(
          text: '$label: ',
          style: const TextStyle(color: MeshColors.textMuted, fontSize: 13, fontWeight: FontWeight.w600),
        ),
        TextSpan(
          text: value,
          style: kMonoStyle.copyWith(
            color: MeshColors.textSecondary,
            fontSize: 13,
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 24,
            runSpacing: 12,
            children: [
              _meta('Parent', parentHandle),
              if (actor.provider != null) _meta('Provider', actor.provider!),
              if (actor.model != null) _meta('Model', actor.model!),
              if (actor.commitmentKind != null)
                _meta('Work state', actor.commitmentKind!),
              if (actor.waitingOn != null)
                _meta('Waiting on', actor.waitingOn!),
              if (actor.ownerExpectsRetirement != null)
                _meta('Retire expected', actor.ownerExpectsRetirement!.toString()),
            ],
          ),
          const SizedBox(height: 24),
          const Text(
            'Charter',
            style: TextStyle(
              color: MeshColors.textPrimary,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          charter.isEmpty
              ? const Text(
                  'No charter.',
                  style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
                )
              : SelectableText(
                  charter,
                  style: const TextStyle(
                    color: MeshColors.textSecondary,
                    fontSize: 13,
                    height: 1.5,
                  ),
                ),
        ],
      ),
    );
  }
}
