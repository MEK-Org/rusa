import 'dart:async';
import 'dart:convert';

import 'package:rxdart/rxdart.dart';

import 'api.dart';
import 'avatar_platform.dart';
import 'mesh_stream.dart';
import 'models.dart';
import 'quota_cache.dart';
import 'tree_preferences_cache.dart';
import 'voice_platform.dart';

export 'models.dart' show DotState;

enum _RuntimePhase { uninitialized, syncing, live }

const int _kRuntimeDeltaBufferCap = 100;
const Duration _kRuntimeRetryInitial = Duration(milliseconds: 250);
const Duration _kRuntimeRetryMax = Duration(seconds: 5);

/// One line in the merged live-output console.
class LiveLine {
  const LiveLine({
    required this.actorId,
    required this.text,
    this.isGap = false,
  });
  final String actorId;
  final String text;

  /// A drop-oldest gap (the server's named `elided` frame).
  final bool isGap;
}

/// The Events tab view-state: a newest-first page plus its cursor/loading flags.
class EventsView {
  const EventsView({
    this.events = const [],
    this.cursor,
    this.loading = false,
    this.hasMore = false,
  });
  final List<MeshEvent> events;
  final int? cursor;
  final bool loading;
  final bool hasMore;

  EventsView copyWith({
    List<MeshEvent>? events,
    int? cursor,
    bool? loading,
    bool? hasMore,
    bool clearCursor = false,
  }) => EventsView(
    events: events ?? this.events,
    cursor: clearCursor ? null : (cursor ?? this.cursor),
    loading: loading ?? this.loading,
    hasMore: hasMore ?? this.hasMore,
  );
}

class ChatView {
  const ChatView({
    this.chat = const [],
    this.cursor,
    this.loading = false,
    this.hasMore = false,
  });
  final List<MeshChat> chat;
  final int? cursor;
  final bool loading;
  final bool hasMore;

  ChatView copyWith({
    List<MeshChat>? chat,
    int? cursor,
    bool? loading,
    bool? hasMore,
    bool clearCursor = false,
  }) => ChatView(
    chat: chat ?? this.chat,
    cursor: clearCursor ? null : (cursor ?? this.cursor),
    loading: loading ?? this.loading,
    hasMore: hasMore ?? this.hasMore,
  );
}

const int _kLiveBufferCap = 2000;
const int _kEventsPageSize = 50;

/// Retired actors whose most recent mesh event is older than this are hidden
/// from the dashboard tree even when "Show retired" is enabled .
///
/// Because `actor_retired` is itself an attributed mesh event, `lastActiveAt`
/// for a retired actor is effectively its retirement timestamp. This threshold
/// therefore hides actors that were *retired* more than a week ago, not actors
/// that were merely idle for a week before retiring.
const Duration _kRetiredInactivityThreshold = Duration(days: 7);

/// How often the client re-checks `/api/quota` in the background (ISSUE_NUM ask
/// 4 — stale-while-revalidate). This is independent of, and much more
/// frequent than, the server's own per-provider probe TTL (5-30min): the
/// server-side `QuotaService` cache absorbs the actual probe cost, so a
/// short client poll just controls how soon a fresh server-cached reading
/// (or a fresh `scrapedAt`) reaches the tooltip, not how often the
/// underlying CLI is actually invoked.
const Duration _kQuotaPollInterval = Duration(seconds: 60);

/// The dashboard's reactive brain. Holds all UI state as RxDart subjects and owns
/// the selection state machine, the live/history seam de-dupe, pagination, and
/// the global run-state map fed by the SSE mesh_event channel. Injected with the
/// REST [DashboardApi] and the [MeshStreamSource] so it is fully testable headless
/// (no Flutter, no package:web).
class DashboardStore {
  DashboardStore({
    required DashboardApi api,
    required MeshStreamSource stream,
    QuotaCache? quotaCache,
    TreePreferencesCache? treePreferencesCache,
    this.walkie,
    this.avatarFilePicker,
  }) : _api = api,
       _stream = stream,
       _quotaCache = quotaCache ?? const NoopQuotaCache(),
       _treePreferencesCache =
           treePreferencesCache ?? const NoopTreePreferencesCache() {
    // Seed the quota subject from the persisted snapshot BEFORE the first frame
    // (ISSUE_NUM ask 4): the header reads `store.quota.valueOrNull` as its
    // StreamBuilder initialData, so a value present here paints the last-known
    // rings at 0ms instead of a blank strip, then `init()`'s revalidation swaps
    // in fresh values behind it. The persisted `scrapedAt` rides through
    // verbatim (ISSUE_NUM ask 5) so the tooltip honestly shows how old this is.
    final cached = _quotaCache.load();
    if (cached != null) {
      _quota.add(cached);
      _quotaStale.add(true);
    }
    final savedCollapsed = _treePreferencesCache.loadCollapsed();
    if (savedCollapsed != null) {
      _collapsed.add(savedCollapsed);
    }
    final savedShowRetired = _treePreferencesCache.loadShowRetired();
    if (savedShowRetired != null) {
      _showRetired.add(savedShowRetired);
    }
    final savedActorOrder = _treePreferencesCache.loadActorOrder();
    if (savedActorOrder != null) {
      _customActorOrder.add(savedActorOrder);
    }
  }

  final DashboardApi _api;
  final MeshStreamSource _stream;
  final QuotaCache _quotaCache;
  final TreePreferencesCache _treePreferencesCache;

  DashboardApi get api => _api;

  /// Walkie-talkie platform deps , wired by the web entrypoint. Null
  /// means the feature is absent (headless harnesses/tests that don't care) —
  /// the chat UI then simply renders no walkie toggle.
  final WalkieDeps? walkie;

  /// Avatar file-picker platform dep , wired by the web entrypoint.
  /// Null means unsupported (headless harnesses/tests) — `pickAndUploadAvatar`
  /// then reports a clear error instead of picking a file.
  final AvatarFilePicker? avatarFilePicker;
  final _subs = <StreamSubscription<dynamic>>[];

  final _actorStates = BehaviorSubject<ActorStateSnapshot>.seeded(
    const ActorStateSnapshot(),
  );
  final _halted = BehaviorSubject<bool>.seeded(false);
  final _showRetired = BehaviorSubject<bool>.seeded(false);
  final _selection = BehaviorSubject<Set<String>>.seeded(const {});
  final _collapsed = BehaviorSubject<Set<String>>.seeded(const {});
  final _customActorOrder = BehaviorSubject<Map<String, List<String>>>.seeded(
    const {},
  );
  final _primary = BehaviorSubject<String?>.seeded(null);
  final _kindFilter = BehaviorSubject<String?>.seeded(null);
  final _events = BehaviorSubject<EventsView>.seeded(const EventsView());
  final _conversation = BehaviorSubject<ChatView>.seeded(const ChatView());
  final _operatorChat = BehaviorSubject<ChatView>.seeded(const ChatView());
  final _live = BehaviorSubject<List<LiveLine>>.seeded(const []);
  final _quota = BehaviorSubject<QuotaSnapshotDto?>.seeded(null);
  final _quotaHistory = BehaviorSubject<QuotaHistoryDto?>.seeded(null);
  final _yieldEvents = BehaviorSubject<List<MeshEvent>>.seeded(const []);

  /// True while a background quota revalidation is in flight (ISSUE_NUM ask 4).
  /// Purely in-memory for this process's lifetime — deliberately NOT
  /// persisted (no localStorage), so it always starts false on a fresh load.
  final _quotaRefreshing = BehaviorSubject<bool>.seeded(false);
  final _quotaStale = BehaviorSubject<bool>.seeded(false);
  final _quotaHistoryStale = BehaviorSubject<bool>.seeded(false);
  final _dashboardConfig = BehaviorSubject<DashboardConfigDto?>.seeded(null);
  final _error = BehaviorSubject<String?>.seeded(null);
  final _walkieActive = BehaviorSubject<bool>.seeded(false);

  /// Bumped on every successful avatar upload/generate  so
  /// `ActorAvatar`/`AvatarLightbox` can cache-bust their image URL — both
  /// Flutter's `ImageCache` and the browser's HTTP cache key on the exact
  /// URL, and the avatar route otherwise serves the same
  /// `/api/mesh/avatar/<id>.png` path forever.
  final _avatarEpoch = BehaviorSubject<int>.seeded(0);
  final _focusedObligationId = BehaviorSubject<String?>.seeded(null);
  final _detailPanelIndex = BehaviorSubject<int>.seeded(0);

  /// Anchor for shift-range selection (set by plain/ctrl clicks).
  String? _anchor;

  /// Event ids already shown (history + live) — the live/history seam de-dupe.
  final _seenEventIds = <String>{};
  final _seenConversationMessageIds = <String>{};
  final _seenOperatorChatMessageIds = <String>{};
  final _seenYieldEventIds = <String>{};

  Timer? _topologyDebounce;
  Timer? _quotaPoll;
  Timer? _runtimeRetry;
  _RuntimePhase _runtimePhase = _RuntimePhase.uninitialized;
  RuntimeCursor? _runtimeCursor;
  final List<ActorRuntimeStateDelta> _runtimeBuffer = [];
  Future<void>? _runtimeSyncTask;
  bool _runtimeSyncAgain = false;
  Duration _runtimeRetryDelay = _kRuntimeRetryInitial;

  // ── Exposed streams ──
  ValueStream<ActorStateSnapshot> get actorStates => _actorStates.stream;
  ValueStream<bool> get halted => _halted.stream;
  ValueStream<bool> get showRetired => _showRetired.stream;
  ValueStream<Set<String>> get selection => _selection.stream;
  ValueStream<Set<String>> get collapsed => _collapsed.stream;
  ValueStream<Map<String, List<String>>> get customActorOrder =>
      _customActorOrder.stream;
  ValueStream<String?> get primary => _primary.stream;
  ValueStream<String?> get kindFilter => _kindFilter.stream;
  ValueStream<EventsView> get events => _events.stream;
  ValueStream<ChatView> get conversation => _conversation.stream;
  ValueStream<ChatView> get operatorChat => _operatorChat.stream;
  ValueStream<List<LiveLine>> get live => _live.stream;
  ValueStream<QuotaSnapshotDto?> get quota => _quota.stream;
  ValueStream<QuotaHistoryDto?> get quotaHistory => _quotaHistory.stream;
  ValueStream<List<MeshEvent>> get yieldEvents => _yieldEvents.stream;
  ValueStream<bool> get quotaRefreshing => _quotaRefreshing.stream;
  ValueStream<bool> get quotaStale => _quotaStale.stream;
  ValueStream<bool> get quotaHistoryStale => _quotaHistoryStale.stream;
  ValueStream<DashboardConfigDto?> get dashboardConfig =>
      _dashboardConfig.stream;
  ValueStream<String?> get error => _error.stream;
  ValueStream<bool> get walkieActive => _walkieActive.stream;
  ValueStream<int> get avatarEpoch => _avatarEpoch.stream;
  ValueStream<String?> get focusedObligationId => _focusedObligationId.stream;
  ValueStream<int> get detailPanelIndex => _detailPanelIndex.stream;

  // ── Normalized actor selectors ──
  ActorViewState? actor(String id) => _actorStates.value.actor(id);
  List<ActorViewState> get runningActors => _actorStates.value.runningActors;
  List<ActorViewState> get queuedActors => _actorStates.value.queuedActors;

  void setWalkieActive(bool active) {
    if (!_walkieActive.isClosed) {
      _walkieActive.add(active);
    }
  }

  void setFocusedObligationId(String? id) {
    if (!_focusedObligationId.isClosed) {
      _focusedObligationId.add(id);
    }
  }

  void setDetailPanelIndex(int index) {
    if (!_detailPanelIndex.isClosed) {
      _detailPanelIndex.add(index);
    }
  }

  /// Open the SSE stream FIRST (so events during the initial fetch are captured
  /// and de-duped), then load the thread list.
  Future<void> init() async {
    _subs.add(_stream.meshEvents.listen(_onMeshEvent));
    _subs.add(_stream.liveOutput.listen(_onLiveOutput));
    _subs.add(_stream.elided.listen((_) => _onElided()));
    _subs.add(_stream.runtimeHello.listen(_onRuntimeHello));
    _subs.add(_stream.runtimeStates.listen(_onRuntimeState));
    _stream.connect(const []); // mesh_event flows for all actors regardless
    await refreshThreads();
    unawaited(refreshDashboardConfig());
    unawaited(refreshQuota());
    // Background SWR revalidation (ISSUE_NUM ask 4) — the ring/tooltip keep
    // showing the last-known reading immediately; this just periodically
    // kicks off a fresh fetch behind it.
    _quotaPoll = Timer.periodic(
      _kQuotaPollInterval,
      (_) => unawaited(refreshQuota()),
    );
  }

  Future<void> refreshDashboardConfig() async {
    try {
      _dashboardConfig.add(await _api.fetchDashboardConfig());
    } on DashboardApiException catch (e) {
      // Older/static dashboard hosts may not expose this endpoint; the header
      // keeps its weekly per-provider defaults.
      if (e.status == 404 || e.status == 503) return;
      _error.add('$e');
    } catch (e) {
      _error.add('$e');
    }
  }

  Future<void> refreshThreads() async {
    await _requestRuntimeSync();
  }

  Future<void> refreshYieldEvents() async {
    try {
      final window = DateTime.now()
          .subtract(const Duration(days: 7))
          .toUtc()
          .toIso8601String();
      final page = await _api.fetchEvents(
        since: window,
        kinds: const ['run_yielded'],
        limit: 50,
        order: 'desc',
      );
      final list = List<MeshEvent>.of(_yieldEvents.value);
      for (final e in page.events) {
        if (_seenYieldEventIds.add(e.id)) list.add(e);
      }
      list.sort((a, b) => b.ts.compareTo(a.ts));
      _yieldEvents.add(list);
    } catch (_) {}
  }

  Future<List<String>> fetchRootControlProviders() =>
      _api.fetchRootControlProviders();

  Future<void> spawnRootChild({
    required String charter,
    String? title,
    String? provider,
    String? model,
    int? maxRuns,
  }) async {
    final id = await _api.spawnRootChild(
      charter: charter,
      title: title,
      provider: provider,
      model: model,
      maxRuns: maxRuns,
    );
    await refreshThreads();
    clickActor(id);
  }

  Future<void> refreshQuota() async {
    _quotaRefreshing.add(true);
    try {
      final snap = await _api.fetchQuota();
      _quota.add(snap);
      _quotaStale.add(false);
      // Persist the fresh reading so the next cold load paints it instantly
      // (ISSUE_NUM ask 4). scrapedAt is carried through verbatim by toJson.
      _quotaCache.save(snap);
    } on DashboardApiException catch (e) {
      // Some dashboard deployments intentionally have no live QuotaService
      // bound. The endpoint reports that as 503; leave the quota UI absent
      // instead of turning the whole dashboard error bar red.
      if (e.status == 503) {
        _quota.add(null);
        _quotaStale.add(false);
        // Drop the persisted snapshot too — a no-quota deployment shouldn't
        // resurrect stale rings from a previous session's cache.
        _quotaCache.clear();
        return;
      }
      if (_quota.valueOrNull != null) {
        _quotaStale.add(true);
      }
    } catch (e) {
      if (_quota.valueOrNull != null) {
        _quotaStale.add(true);
      }
    } finally {
      _quotaRefreshing.add(false);
    }
  }

  Future<void> refreshQuotaHistory() async {
    try {
      final history = await _api.fetchQuotaHistory();
      _quotaHistory.add(history);
      _quotaHistoryStale.add(false);
    } on DashboardApiException catch (e) {
      if (e.status == 503) {
        _quotaHistory.add(null);
        _quotaHistoryStale.add(false);
        return;
      }
      if (_quotaHistory.valueOrNull != null) {
        _quotaHistoryStale.add(true);
      }
    } catch (e) {
      if (_quotaHistory.valueOrNull != null) {
        _quotaHistoryStale.add(true);
      }
    }
  }

  /// Replace the normalized actor-state snapshot from one authoritative server
  /// capture. Buffered deltas are applied only after its runtime cursor.
  void _updateActorStatesFromThreads(List<ThreadDto> threads) {
    final cur = _actorStates.value;
    final updatedActors = <String, ActorViewState>{};
    final orderedIds = <String>[];

    for (final t in threads) {
      orderedIds.add(t.id);
      updatedActors[t.id] = ActorViewState(thread: t, runState: t.runState);
    }

    _actorStates.add(
      ActorStateSnapshot(
        revision: cur.revision + 1,
        actors: updatedActors,
        orderedIds: orderedIds,
      ),
    );
  }

  // ── Tree flattening (visible order = the basis for shift-range) ──

  /// Depth-first, parent→child ordered list of the *visible* threads. Retired
  /// actors are hidden by default; when [showRetired] is enabled, retired actors
  /// whose last activity is older than [_kRetiredInactivityThreshold] (or who
  /// have no recorded activity at all) are still hidden . A hidden retired
  /// subtree is skipped whole. This is exactly the render order, so shift-range
  /// over it matches the UI.
  List<ThreadDto> flattenedVisible() {
    final all = _actorStates.value.orderedIds
        .map((id) => _actorStates.value.actors[id]!.thread)
        .toList();
    final show = _showRetired.value;
    final collapsedSet = _collapsed.value;
    final customOrder = _customActorOrder.value;
    final byParent = <String?, List<ThreadDto>>{};
    for (final t in all) {
      (byParent[t.parentId] ??= []).add(t);
    }
    for (final entry in byParent.entries) {
      final parentKey = entry.key ?? '';
      _sortSiblings(entry.value, customOrder[parentKey]);
    }
    final now = DateTime.timestamp();
    final out = <ThreadDto>[];
    void walk(String? parentId) {
      for (final node in byParent[parentId] ?? const <ThreadDto>[]) {
        if (node.isRetired && !_isRetiredVisible(node, show, now)) {
          continue; // skip subtree
        }
        out.add(node);
        if (!collapsedSet.contains(node.id)) {
          walk(node.id);
        }
      }
    }

    walk(null);
    return out;
  }

  /// Whether a retired actor should appear in the tree. Active actors are
  /// handled separately in [flattenedVisible]; this is only called for retired
  /// nodes. When [showRetired] is false, every retired actor is hidden. When
  /// true, only retired actors with activity within the last week are shown —
  /// absent or stale activity hides them.
  bool _isRetiredVisible(ThreadDto node, bool showRetired, DateTime now) {
    if (!showRetired) return false;
    final ts = node.lastActiveAt;
    if (ts == null) return false;
    final then = DateTime.tryParse(ts);
    if (then == null) return false;
    return now.difference(then.toUtc()) <= _kRetiredInactivityThreshold;
  }

  /// Public visibility check for a single thread, used by tree rows to decide
  /// whether a child chevron is needed. Mirrors [flattenedVisible]'s rules.
  bool isThreadVisible(ThreadDto t) {
    if (!t.isRetired) return true;
    return _isRetiredVisible(t, _showRetired.value, DateTime.timestamp());
  }

  /// The dot to render for an actor: retired (muted) wins; otherwise green only
  /// when the actor is genuinely running. Idle, unknown, and not-yet-seeded all
  /// render neutral/idle — never default to active (the cold-load bug where
  /// every actor showed green until an SSE event arrived).
  DotState dotFor(Object? target) {
    if (target is ThreadDto) {
      return _actorStates.value.dotForThread(target);
    } else if (target is ActorViewState) {
      return target.dotState;
    } else if (target is String) {
      return _actorStates.value.dotFor(target);
    }
    return DotState.idle;
  }

  // ── Selection state machine (over the flattened visible list) ──

  void setShowRetired(bool value) {
    _showRetired.add(value);
    _treePreferencesCache.saveShowRetired(value);
    // Drop selections that are no longer visible to keep state coherent.
    if (!value) {
      final visible = flattenedVisible().map((t) => t.id).toSet();
      final pruned = _selection.value.where(visible.contains).toSet();
      if (pruned.length != _selection.value.length) {
        _applySelection(
          pruned,
          primary: pruned.contains(_primary.value)
              ? _primary.value
              : pruned.lastOrNull,
        );
      }
    }
  }

  void toggleCollapsed(String id) {
    final cur = _collapsed.value;
    final updated = cur.contains(id)
        ? (Set<String>.of(cur)..remove(id))
        : (Set<String>.of(cur)..add(id));
    _collapsed.add(updated);
    _treePreferencesCache.saveCollapsed(updated);
  }

  void setCollapsed(String id, bool isCollapsed) {
    final cur = _collapsed.value;
    if (cur.contains(id) == isCollapsed) return;
    final updated = isCollapsed
        ? (Set<String>.of(cur)..add(id))
        : (Set<String>.of(cur)..remove(id));
    _collapsed.add(updated);
    _treePreferencesCache.saveCollapsed(updated);
  }

  /// Reorders a child actor among its siblings under the same parent.
  /// [draggedId] is moved relative to [targetId] (before it if [before] is true, else after).
  /// Reordering is strictly scoped to siblings with the exact same [parentId] (v1 constraint).
  void reorderActor(String draggedId, String targetId, {bool before = true}) {
    if (draggedId == targetId) return;
    final actors = _actorStates.value.actors;
    final dragged = actors[draggedId]?.thread;
    final target = actors[targetId]?.thread;
    if (dragged == null || target == null) return;
    if (dragged.parentId != target.parentId) {
      // v1 constraint: only drag within the same parent
      return;
    }

    final parentKey = dragged.parentId ?? '';
    final siblings = _actorStates.value.orderedIds
        .map((id) => _actorStates.value.actors[id]?.thread)
        .whereType<ThreadDto>()
        .where((t) => t.parentId == dragged.parentId)
        .toList();

    _sortSiblings(siblings, _customActorOrder.value[parentKey]);

    final ids = siblings.map((t) => t.id).toList();
    ids.remove(draggedId);
    final targetIdx = ids.indexOf(targetId);
    if (targetIdx == -1) return;
    final insertIdx = before ? targetIdx : targetIdx + 1;
    ids.insert(insertIdx.clamp(0, ids.length), draggedId);

    final nextMap = Map<String, List<String>>.from(_customActorOrder.value);
    nextMap[parentKey] = ids;
    _customActorOrder.add(nextMap);
    _treePreferencesCache.saveActorOrder(nextMap);
  }

  /// Sorts siblings respecting an optional custom ordering. Actors present in
  /// [customOrder] are sorted by their index; unindexed actors follow, sorted
  /// by [ThreadDto.createdAt] ascending with [ThreadDto.id] tiebreak.
  static void _sortSiblings(
    List<ThreadDto> siblings,
    List<String>? customOrder,
  ) {
    if (customOrder != null && customOrder.isNotEmpty) {
      final indexMap = {
        for (var i = 0; i < customOrder.length; i++) customOrder[i]: i,
      };
      siblings.sort((a, b) {
        final aIdx = indexMap[a.id];
        final bIdx = indexMap[b.id];
        if (aIdx != null && bIdx != null) return aIdx.compareTo(bIdx);
        if (aIdx != null) return -1;
        if (bIdx != null) return 1;
        final c = a.createdAt.compareTo(b.createdAt);
        return c != 0 ? c : a.id.compareTo(b.id);
      });
    } else {
      siblings.sort((a, b) {
        final c = a.createdAt.compareTo(b.createdAt);
        return c != 0 ? c : a.id.compareTo(b.id);
      });
    }
  }

  /// Plain click: select only [id].
  void clickActor(String id) {
    _anchor = id;
    _applySelection({id}, primary: id);
  }

  /// Clears the selection entirely. Used by the narrow (mobile) master-detail
  /// layout's back affordance to return from an actor's detail view to the
  /// full-width actor list.
  void clearSelection() {
    _anchor = null;
    _applySelection(const {}, primary: null);
  }

  /// Ctrl/Cmd click: toggle [id] in the selection.
  void toggleActor(String id) {
    final next = Set<String>.of(_selection.value);
    String? primary;
    if (next.contains(id)) {
      next.remove(id);
      primary = next.contains(_primary.value)
          ? _primary.value
          : next.lastOrNull;
    } else {
      if (next.length >= 2) {
        return; // Explicitly 2-actor only, ignore/reject a 3rd selection.
      }
      next.add(id);
      primary = id;
    }
    _anchor = id;
    _applySelection(next, primary: primary);
  }

  /// Shift click: select the contiguous range [anchor..id] over the visible list
  /// (replacing the selection; the anchor is unchanged). Falls back to a plain
  /// click if there is no anchor.
  void rangeSelectTo(String id) {
    if (_anchor == null) {
      clickActor(id);
      return;
    }
    final order = flattenedVisible().map((t) => t.id).toList();
    final a = order.indexOf(_anchor!);
    final b = order.indexOf(id);
    if (a < 0 || b < 0) {
      clickActor(id);
      return;
    }
    final lo = a < b ? a : b;
    final hi = a < b ? b : a;
    final range = order.sublist(lo, hi + 1).toSet();
    if (range.length > 2) return; // Ignore if range is more than 2 actors.
    _applySelection(range, primary: id);
  }

  void _applySelection(Set<String> next, {required String? primary}) {
    _selection.add(next);
    _primary.add(primary);
    // Live_output is server-filtered, so re-open the stream for the new actors.
    _stream.connect(next.toList());
    // Reset the merged events view + seam de-dupe for the new selection.
    _seenEventIds.clear();
    _events.add(const EventsView());
    _live.add(const []);
    unawaited(_loadEvents(reset: true));

    // Reset the conversation view for the new selection.
    _seenConversationMessageIds.clear();
    _conversation.add(const ChatView());
    if (next.length == 2) {
      unawaited(_loadConversationEvents(reset: true));
    }

    // Reset the operator chat view for the new selection.
    _seenOperatorChatMessageIds.clear();
    _operatorChat.add(const ChatView());
    if (next.length == 1) {
      unawaited(_loadOperatorChatEvents(reset: true));
    }
  }

  // ── Events tab ──

  void setKindFilter(String? kind) {
    _kindFilter.add(kind);
    _seenEventIds.clear();
    unawaited(_loadEvents(reset: true));
  }

  Future<void> loadMoreEvents() => _loadEvents(reset: false);

  Future<void> _loadEvents({required bool reset}) async {
    final actors = _selection.value.toList();
    if (actors.isEmpty) {
      _events.add(const EventsView());
      return;
    }
    final cur = _events.value;
    if (cur.loading) return;
    _events.add(cur.copyWith(loading: true));
    try {
      final kinds = _kindFilter.value == null ? null : [_kindFilter.value!];
      final page = await _api.fetchEvents(
        actors: actors,
        kinds: kinds,
        before: reset ? null : cur.cursor,
        limit: _kEventsPageSize,
      );
      // Seed from the CURRENT list even on reset: the reset callers
      // (_applySelection / setKindFilter) already cleared _seenEventIds and the
      // list synchronously *before* this await, so anything present now is a
      // live mesh_event that arrived during the fetch — keep it (newest-first at
      // the front) and de-dupe the history page beneath it. (Do NOT re-clear
      // _seenEventIds here: that would erase the seam-window event's id and let
      // it reappear / be lost.)
      final base = List<MeshEvent>.of(_events.value.events);
      for (final e in page.events) {
        if (_seenEventIds.add(e.id)) base.add(e);
      }
      _events.add(
        EventsView(
          events: base,
          cursor: page.nextCursor,
          loading: false,
          hasMore: page.nextCursor != null,
        ),
      );
      _error.add(null);
    } catch (e) {
      _events.add(_events.value.copyWith(loading: false));
      _error.add('$e');
    }
  }

  // ── Conversation Tab ──

  Future<void> loadMoreConversationEvents() =>
      _loadConversationEvents(reset: false);

  Future<void> _loadConversationEvents({required bool reset}) async {
    final actors = _selection.value.toList();
    if (actors.length != 2) {
      _conversation.add(const ChatView());
      return;
    }
    final cur = _conversation.value;
    if (cur.loading) return;
    _conversation.add(cur.copyWith(loading: true));
    try {
      final page = await _api.fetchChat(
        actors: actors,
        before: reset ? null : cur.cursor,
        limit: _kEventsPageSize,
      );
      final base = List<MeshChat>.of(_conversation.value.chat);
      for (final c in page.chat) {
        if (_seenConversationMessageIds.add(c.id)) base.add(c);
      }
      _conversation.add(
        ChatView(
          chat: base,
          cursor: page.nextCursor,
          loading: false,
          hasMore: page.nextCursor != null,
        ),
      );
      _error.add(null);
    } catch (e) {
      _conversation.add(_conversation.value.copyWith(loading: false));
      _error.add('$e');
    }
  }

  // ── Operator Chat Tab ──

  Future<void> loadMoreOperatorChatEvents() =>
      _loadOperatorChatEvents(reset: false);

  Future<void> _loadOperatorChatEvents({required bool reset}) async {
    final actors = _selection.value.toList();
    if (actors.length != 1) {
      _operatorChat.add(const ChatView());
      return;
    }
    final cur = _operatorChat.value;
    if (cur.loading) return;
    _operatorChat.add(cur.copyWith(loading: true));
    try {
      final selectedId = actors.first;
      final page = await _api.fetchChat(
        actors: [selectedId, 'human:operator'],
        before: reset ? null : cur.cursor,
        limit: _kEventsPageSize,
      );
      final base = List<MeshChat>.of(_operatorChat.value.chat);
      for (final c in page.chat) {
        if (_seenOperatorChatMessageIds.add(c.id)) base.add(c);
      }
      _operatorChat.add(
        ChatView(
          chat: base,
          cursor: page.nextCursor,
          loading: false,
          hasMore: page.nextCursor != null,
        ),
      );
      _error.add(null);
    } catch (e) {
      _operatorChat.add(_operatorChat.value.copyWith(loading: false));
      _error.add('$e');
    }
  }

  Future<void> sendOperatorChatMessage(String body) async {
    final actors = _selection.value.toList();
    if (actors.length != 1) {
      throw StateError(
        'Cannot send chat message unless exactly one actor is selected',
      );
    }
    final actorId = actors.first;
    try {
      await _api.sendChatMessage(actorId, body);
      _error.add(null);
    } catch (e) {
      _error.add('$e');
      rethrow;
    }
  }

  /// Opens the platform file picker and uploads the chosen image as the
  /// avatar for [id] . Returns silently if the user cancels the
  /// picker. Errors — an unsupported file type, a missing platform picker, or
  /// a failed upload — route through the shared [error] stream and rethrow,
  /// matching [sendOperatorChatMessage]'s convention.
  Future<void> pickAndUploadAvatar(String id) async {
    final picker = avatarFilePicker;
    if (picker == null) {
      const message = 'Avatar upload is not supported in this environment.';
      _error.add(message);
      throw StateError(message);
    }
    final picked = await picker.pickImage();
    if (picked == null) return; // user cancelled
    if (picked.contentType != 'image/png') {
      const message = 'Please choose a PNG image.';
      _error.add(message);
      throw StateError(message);
    }
    try {
      await _api.uploadAvatar(
        id,
        base64Encode(picked.bytes),
        picked.contentType,
      );
      _avatarEpoch.add(_avatarEpoch.value + 1);
      _error.add(null);
    } catch (e) {
      _error.add('$e');
      rethrow;
    }
  }

  /// Requests on-demand AI generation of the avatar for [id] . Errors
  /// (root, no `geminiApiKey` configured, or a failed Gemini call) route
  /// through the shared [error] stream and rethrow, matching
  /// [pickAndUploadAvatar]'s convention.
  Future<void> generateAvatar(String id) async {
    try {
      await _api.generateAvatar(id);
      _avatarEpoch.add(_avatarEpoch.value + 1);
      _error.add(null);
    } catch (e) {
      _error.add('$e');
      rethrow;
    }
  }

  Future<Map<String, dynamic>> fetchIuReports() async {
    try {
      final res = await _api.fetchIuReports();
      _error.add(null);
      return res;
    } catch (e) {
      _error.add('$e');
      rethrow;
    }
  }

  Future<Map<String, dynamic>> fetchIuReportContent(String runId) async {
    try {
      final res = await _api.fetchIuReportContent(runId);
      _error.add(null);
      return res;
    } catch (e) {
      _error.add('$e');
      rethrow;
    }
  }

  /// The full charter for one actor, fetched on demand.
  ///
  /// The thread list only carries a preview, so the detail panel asks for the
  /// rest when the operator opens an actor. Not cached here: the panel holds
  /// the result for as long as it shows it, and a charter can be edited, so a
  /// store-level cache would go stale with nothing to invalidate it.
  Future<String> fetchCharter(String threadId) async {
    try {
      final charter = await _api.fetchCharter(threadId);
      _error.add(null);
      return charter;
    } catch (e) {
      _error.add('$e');
      rethrow;
    }
  }

  /// Interrupt a running or queued actor .
  Future<void> interruptActor(String actorId) async {
    try {
      await _api.interruptActor(actorId);
      _error.add(null);
    } catch (e) {
      _error.add('$e');
    }
  }

  /// Bypass queue and quota throttle to run an actor immediately.
  Future<void> runNowActor(String actorId) async {
    try {
      await _api.runNowActor(actorId);
      _error.add(null);
    } catch (e) {
      _error.add('$e');
    }
  }

  // ── Live SSE handlers ──

  void _onMeshEvent(MeshEvent e) {
    if (e.kind == 'actor_spawned' ||
        e.kind == 'actor_retired' ||
        e.kind == 'actor_model_set') {
      _scheduleTopologyRefresh();
    }
    if (e.kind == 'run_yielded') {
      if (_seenYieldEventIds.add(e.id)) {
        final cur = _yieldEvents.value;
        _yieldEvents.add([e, ...cur]);
      }
    }

    // Prepend to the Events list only if it matches the *current* view filter.
    final actorId = e.actorId;
    if (actorId == null) return;

    if (_selection.value.contains(actorId)) {
      final kf = _kindFilter.value;
      if (kf != null && e.kind != kf) return;
      if (_seenEventIds.add(e.id)) {
        final cur = _events.value;
        _events.add(cur.copyWith(events: [e, ...cur.events]));
      }
    }

    final sel = _selection.value;
    if (e.kind == 'message_sent' || e.kind == 'message_received') {
      final messageId = e.messageId;
      if (messageId != null) {
        final senderId = e.messageSender ?? e.actorId ?? '';
        final recipientId = e.messageRecipient ?? '';
        final c = MeshChat(
          id: messageId,
          ts: DateTime.tryParse(e.ts)?.toLocal() ?? DateTime.now(),
          senderId: senderId,
          recipientId: recipientId,
          body: e.body ?? e.detail ?? '',
          sessionId: null,
        );

        if (sel.length == 2 && e.kind == 'message_sent') {
          if (sel.contains(actorId) && sel.contains(recipientId)) {
            if (_seenConversationMessageIds.add(c.id)) {
              final cur = _conversation.value;
              _conversation.add(cur.copyWith(chat: [c, ...cur.chat]));
            }
          }
        }

        if (sel.length == 1) {
          final selectedId = sel.first;
          if ((actorId == selectedId && recipientId == 'human:operator') ||
              (actorId == 'human:operator' && recipientId == selectedId)) {
            if (_seenOperatorChatMessageIds.add(c.id)) {
              final cur = _operatorChat.value;
              _operatorChat.add(cur.copyWith(chat: [c, ...cur.chat]));
            }
          }
        }
      }
    }
  }

  void _onRuntimeHello(RuntimeHello hello) {
    final cursor = _runtimeCursor;
    final changed = cursor != null && cursor.streamId != hello.streamId;
    unawaited(_requestRuntimeSync(clearBuffer: changed));
  }

  void _onRuntimeState(ActorRuntimeStateDelta delta) {
    if (delta.runState == RunState.unknown) {
      unawaited(_requestRuntimeSync(clearBuffer: true));
      return;
    }
    final cursor = _runtimeCursor;
    if (_runtimePhase == _RuntimePhase.syncing) {
      _bufferRuntimeState(delta);
      return;
    }
    if (_runtimePhase == _RuntimePhase.uninitialized || cursor == null) {
      _bufferRuntimeState(delta);
      unawaited(
        _requestRuntimeSync(
          clearBuffer: cursor != null && cursor.streamId != delta.streamId,
        ),
      );
      return;
    }
    if (delta.streamId != cursor.streamId) {
      _runtimeBuffer.clear();
      _bufferRuntimeState(delta);
      unawaited(_requestRuntimeSync());
      return;
    }
    if (delta.revision <= cursor.revision) return;
    if (delta.revision == cursor.revision + 1 && _applyRuntimeState(delta)) {
      _runtimeCursor = RuntimeCursor(
        streamId: cursor.streamId,
        revision: delta.revision,
      );
      return;
    }
    _bufferRuntimeState(delta);
    unawaited(_requestRuntimeSync());
  }

  void _bufferRuntimeState(ActorRuntimeStateDelta delta) {
    _runtimeBuffer.removeWhere(
      (existing) =>
          existing.streamId == delta.streamId &&
          existing.revision == delta.revision,
    );
    _runtimeBuffer.add(delta);
    _runtimeBuffer.sort((a, b) => a.revision.compareTo(b.revision));
    if (_runtimeBuffer.length > _kRuntimeDeltaBufferCap) {
      _runtimeBuffer.clear();
      _runtimeSyncAgain = true;
    }
  }

  bool _applyRuntimeState(ActorRuntimeStateDelta delta) {
    final cur = _actorStates.value;
    final existing = cur.actors[delta.actorId];
    if (existing == null) return false;
    final updatedActors = Map<String, ActorViewState>.of(cur.actors);
    updatedActors[delta.actorId] = existing.copyWith(
      thread: existing.thread.copyWith(runState: delta.runState),
      runState: delta.runState,
    );
    _actorStates.add(
      cur.copyWith(revision: cur.revision + 1, actors: updatedActors),
    );
    return true;
  }

  Future<void> _requestRuntimeSync({bool clearBuffer = false}) {
    if (clearBuffer) _runtimeBuffer.clear();
    _runtimePhase = _RuntimePhase.syncing;
    _runtimeSyncAgain = true;
    final active = _runtimeSyncTask;
    if (active != null) return active;
    late final Future<void> task;
    task = _runRuntimeSync().whenComplete(() {
      if (identical(_runtimeSyncTask, task)) _runtimeSyncTask = null;
    });
    _runtimeSyncTask = task;
    return task;
  }

  Future<void> _runRuntimeSync() async {
    while (_runtimeSyncAgain) {
      _runtimeSyncAgain = false;
      ThreadsSnapshot snap;
      try {
        snap = await _api.fetchThreads();
      } catch (e) {
        _error.add('$e');
        _scheduleRuntimeRetry();
        return;
      }
      _runtimeRetry?.cancel();
      _runtimeRetry = null;
      _runtimeRetryDelay = _kRuntimeRetryInitial;
      _halted.add(snap.halted);
      _updateActorStatesFromThreads(snap.threads);
      _runtimeCursor = snap.runtimeCursor;
      _error.add(null);
      if (!_drainRuntimeBuffer()) _runtimeSyncAgain = true;
    }
    _runtimePhase = _RuntimePhase.live;
  }

  bool _drainRuntimeBuffer() {
    final cursor = _runtimeCursor;
    if (cursor == null) {
      _runtimeBuffer.clear();
      return true;
    }
    final pending =
        _runtimeBuffer
            .where(
              (delta) =>
                  delta.streamId == cursor.streamId &&
                  delta.revision > cursor.revision,
            )
            .toList()
          ..sort((a, b) => a.revision.compareTo(b.revision));
    _runtimeBuffer.clear();
    var revision = cursor.revision;
    for (final delta in pending) {
      if (delta.revision <= revision) continue;
      if (delta.revision != revision + 1 || !_applyRuntimeState(delta)) {
        return false;
      }
      revision = delta.revision;
    }
    _runtimeCursor = RuntimeCursor(
      streamId: cursor.streamId,
      revision: revision,
    );
    return true;
  }

  void _scheduleRuntimeRetry() {
    if (_runtimeRetry?.isActive ?? false) return;
    final delay = _runtimeRetryDelay;
    final doubled = delay * 2;
    _runtimeRetryDelay = doubled > _kRuntimeRetryMax
        ? _kRuntimeRetryMax
        : doubled;
    _runtimeRetry = Timer(delay, () {
      _runtimeRetry = null;
      unawaited(_requestRuntimeSync());
    });
  }

  void _onLiveOutput(LiveOutputChunk chunk) {
    // Only the selected actors' output is shown (the server already filters, but
    // guard in case a stale frame arrives across a reconnect).
    if (!_selection.value.contains(chunk.actorId)) return;
    _appendLive(LiveLine(actorId: chunk.actorId, text: chunk.text));
  }

  void _onElided() {
    _appendLive(
      const LiveLine(actorId: '', text: '… output elided …', isGap: true),
    );
    unawaited(_requestRuntimeSync());
  }

  void _appendLive(LiveLine line) {
    final next = List<LiveLine>.of(_live.value)..add(line);
    if (next.length > _kLiveBufferCap) {
      next.removeRange(0, next.length - _kLiveBufferCap);
    }
    _live.add(next);
  }

  void _scheduleTopologyRefresh() {
    _topologyDebounce?.cancel();
    _topologyDebounce = Timer(
      const Duration(milliseconds: 400),
      refreshThreads,
    );
  }

  Future<void> dispose() async {
    _topologyDebounce?.cancel();
    _quotaPoll?.cancel();
    _runtimeRetry?.cancel();
    for (final s in _subs) {
      await s.cancel();
    }
    _stream.dispose();
    _api.close();
    await Future.wait([
      _actorStates.close(),
      _halted.close(),
      _showRetired.close(),
      _selection.close(),
      _primary.close(),
      _kindFilter.close(),
      _events.close(),
      _conversation.close(),
      _operatorChat.close(),
      _live.close(),
      _quota.close(),
      _quotaHistory.close(),
      _yieldEvents.close(),
      _quotaRefreshing.close(),
      _quotaStale.close(),
      _quotaHistoryStale.close(),
      _avatarEpoch.close(),
      _dashboardConfig.close(),
      _error.close(),
      _collapsed.close(),
      _walkieActive.close(),
    ]);
  }
}
