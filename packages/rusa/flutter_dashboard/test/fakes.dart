import 'dart:async';
import 'dart:typed_data';

import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/avatar_platform.dart';
import 'package:rusa_dashboard/mesh_stream.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/quota_cache.dart';
import 'package:rusa_dashboard/tree_preferences_cache.dart';
import 'package:rusa_dashboard/voice_platform.dart';

ThreadDto makeThread(
  String id, {
  String? parent,
  String status = 'active',
  String created = '2026-01-01T00:00:00Z',
  String? lastActiveAt,
  RunState runState = RunState.unknown,
  String? title,
  String? model,
}) => ThreadDto(
  id: id,
  handle: '$id-handle',
  parentId: parent,
  status: status,
  provider: null,
  model: model,
  charter: 'charter $id',
  title: title ?? 'charter $id',
  createdAt: created,
  lastActiveAt: lastActiveAt,
  runState: runState,
);

MeshEvent makeEvent(
  String id,
  String kind, {
  String? actor,
  String? peer,
  String? detail,
  String? body,
  String? payload,
}) => MeshEvent(
  id: id,
  ts: '2026-01-01T00:00:00Z',
  kind: kind,
  actorId: actor,
  detail: detail,
  body: body,
  payload: payload ?? (peer != null ? "{\"parentId\": \"$peer\", \"to\": \"$peer\", \"from\": \"$peer\"}" : null),
  success: null,
);

MeshChat makeChat(
  String id, {
  String sender = 'a',
  String recipient = 'human:operator',
  String body = '',
}) => MeshChat(
  id: id,
  ts: DateTime.utc(2026),
  senderId: sender,
  recipientId: recipient,
  body: body,
  sessionId: null,
);

ObligationDto makeObligation(
  String id, {
  String? parentId,
  String ownerKind = 'actor',
  String ownerId = 'root',
  String? intent,
  String? externalRef,
  String status = 'ready',
  double? priority,
  double effectivePriority = 100.0,
  String? prioritySourceId,
}) =>
    ObligationDto(
      id: id,
      parentId: parentId,
      owner: ObligationOwner(kind: ownerKind, id: ownerId),
      intent: intent ?? 'intent $id',
      externalRef: externalRef,
      status: status,
      priority: priority,
      effectivePriority: effectivePriority,
      prioritySourceId: prioritySourceId,
    );

/// Fake REST API with canned responses; records the actor lists it was queried
/// with so tests can assert what the store requested.
class FakeApi extends DashboardApi {
  FakeApi() : super();
  List<ThreadDto> threadsResult = [];
  QuotaSnapshotDto? quotaResult;
  QuotaHistoryDto? quotaHistoryResult;
  Object? quotaError;
  Object? quotaHistoryError;
  DashboardConfigDto? dashboardConfigResult;
  bool halted = false;
  List<EventPage> eventPages = [];
  List<ChatPage> chatPages = [];
  int chatCall = 0;
  int eventCall = 0;
  int quotaCallCount = 0;
  int quotaHistoryCallCount = 0;
  final eventActorCalls = <List<String>>[];
  final chatActorCalls = <List<String>>[];
  final eventSinceCalls = <String?>[];
  final eventOrderCalls = <String?>[];
  List<String> rootControlProviders = ['agy', 'codex'];
  final rootSpawnCalls =
      <
        ({
          String charter,
          String? title,
          String? provider,
          String? model,
          int? maxRuns,
        })
      >[];
  String spawnedRootChildId = 'spawned-child';

  /// When set, the NEXT fetchQuota awaits this instead of returning
  /// [quotaResult] immediately — lets a test observe the SWR "refreshing"
  /// window (ISSUE_NUM ask 4) before letting the background revalidation resolve.
  Completer<QuotaSnapshotDto>? quotaGate;

  /// When set, the NEXT fetchEvents awaits this instead of returning a canned
  /// page — lets a test inject a live SSE frame mid-fetch (the seam window).
  Completer<EventPage>? eventsGate;

  @override
  Future<ThreadsSnapshot> fetchThreads() async =>
      ThreadsSnapshot(halted: halted, threads: threadsResult);

  @override
  Future<List<String>> fetchRootControlProviders() async =>
      rootControlProviders;

  @override
  Future<String> spawnRootChild({
    required String charter,
    String? title,
    String? provider,
    String? model,
    int? maxRuns,
  }) async {
    rootSpawnCalls.add((
      charter: charter,
      title: title,
      provider: provider,
      model: model,
      maxRuns: maxRuns,
    ));
    threadsResult = [
      ...threadsResult,
      makeThread(spawnedRootChildId, parent: 'root', title: title),
    ];
    return spawnedRootChildId;
  }

  @override
  Future<QuotaSnapshotDto> fetchQuota() async {
    quotaCallCount++;
    final gate = quotaGate;
    if (gate != null) {
      quotaGate = null;
      return gate.future;
    }
    final err = quotaError;
    if (err != null) throw err;
    return quotaResult ??
        const QuotaSnapshotDto(generatedAt: '', providers: []);
  }

  @override
  Future<QuotaHistoryDto> fetchQuotaHistory() async {
    quotaHistoryCallCount++;
    final err = quotaHistoryError;
    if (err != null) throw err;
    return quotaHistoryResult ??
        const QuotaHistoryDto(generatedAt: '', historySince: '', history: []);
  }

  @override
  Future<DashboardConfigDto> fetchDashboardConfig() async {
    return dashboardConfigResult ??
        const DashboardConfigDto(quotaProviders: {});
  }

  @override
  Future<EventPage> fetchEvents({
    List<String>? actors,
    String? since,
    List<String>? kinds,
    int? before,
    int limit = 50,
    bool conversation = false,
    String? order,
  }) async {
    if (actors != null) {
      eventActorCalls.add(actors);
    }
    eventSinceCalls.add(since);
    eventOrderCalls.add(order);
    if ((actors == null || actors.isEmpty) && since == null) {
      return const EventPage(events: [], nextCursor: null);
    }
    final gate = eventsGate;
    if (gate != null) {
      eventsGate = null;
      return gate.future;
    }
    final p = eventCall < eventPages.length
        ? eventPages[eventCall]
        : const EventPage(events: [], nextCursor: null);
    eventCall++;
    return p;
  }

  @override
  Future<ChatPage> fetchChat({
    required List<String> actors,
    int? before,
    int limit = 50,
  }) async {
    chatActorCalls.add(actors);
    if (actors.isEmpty) return const ChatPage(chat: [], nextCursor: null);
    final p = chatCall < chatPages.length
        ? chatPages[chatCall]
        : const ChatPage(chat: [], nextCursor: null);
    chatCall++;
    return p;
  }

  // ── Walkie-talkie voice routes  ──

  /// Backlog pages consumed in order; the last one repeats once exhausted.
  List<List<VoiceAnnouncement>> backlogPages = [const []];
  int backlogCalls = 0;
  DashboardApiException? backlogError;

  final ackedIds = <String>[];
  DashboardApiException? ackError;

  VoiceMemoResult memoResult = const VoiceMemoResult(
    transcript: 'hello',
    delivered: true,
  );
  DashboardApiException? memoError;
  final memoSends = <({String actorId, int byteLength, String mimeType})>[];

  @override
  Future<List<VoiceAnnouncement>> fetchVoiceBacklog(String actorId) async {
    backlogCalls++;
    final err = backlogError;
    if (err != null) throw err;
    if (backlogPages.isEmpty) return const [];
    final i = backlogCalls - 1;
    return backlogPages[i < backlogPages.length ? i : backlogPages.length - 1];
  }

  @override
  Future<void> ackVoiceAnnouncement(String id) async {
    final err = ackError;
    if (err != null) throw err;
    ackedIds.add(id);
  }

  @override
  Future<VoiceMemoResult> sendVoiceMemo(
    String actorId,
    Uint8List audio, {
    required String mimeType,
    String? sessionId,
  }) async {
    memoSends.add((
      actorId: actorId,
      byteLength: audio.length,
      mimeType: mimeType,
    ));
    final err = memoError;
    if (err != null) throw err;
    return memoResult;
  }

  final chatSends = <Map<String, String>>[];
  Future<void> Function(String, String, String?)? onSendChatMessage;

  @override
  Future<void> sendChatMessage(
    String actorId,
    String body, {
    String? sessionId,
  }) async {
    chatSends.add({'actorId': actorId, 'body': body, 'sessionId': ?sessionId});
    if (onSendChatMessage != null) {
      await onSendChatMessage!(actorId, body, sessionId);
    }
  }

  final interruptCalls = <({String actorId, String by})>[];
  DashboardApiException? interruptError;

  @override
  Future<void> interruptActor(
    String actorId, {
    String by = 'human:operator',
  }) async {
    interruptCalls.add((actorId: actorId, by: by));
    final err = interruptError;
    if (err != null) throw err;
  }

  final runNowCalls = <String>[];
  DashboardApiException? runNowError;

  @override
  Future<void> runNowActor(String actorId) async {
    runNowCalls.add(actorId);
    final err = runNowError;
    if (err != null) throw err;
  }

  // ── Avatar upload  ──

  final uploadCalls = <({String id, String imageBase64, String contentType})>[];
  DashboardApiException? uploadError;

  @override
  Future<void> uploadAvatar(
    String id,
    String imageBase64,
    String contentType,
  ) async {
    uploadCalls.add((id: id, imageBase64: imageBase64, contentType: contentType));
    final err = uploadError;
    if (err != null) throw err;
  }

  final generateCalls = <String>[];
  DashboardApiException? generateError;

  @override
  Future<void> generateAvatar(String id) async {
    generateCalls.add(id);
    final err = generateError;
    if (err != null) throw err;
  }

  // ── Inbox routes ──
  Map<String, dynamic> inboxResult = {'entries': []};

  /// Per-status pages, so a test can hold an outstanding entry and a resolved
  /// one apart. Falls back to [inboxResult] for any status not set here.
  final Map<String, Map<String, dynamic>> inboxResultsByStatus = {};

  final markInboxHandledCalls =
      <({String actorId, String entryId, String? reason})>[];
  Object? markInboxHandledError;

  @override
  Future<Map<String, dynamic>> fetchInbox(
    String actorId, {
    String status = 'all',
    int limit = 20,
  }) async {
    return inboxResultsByStatus[status] ?? inboxResult;
  }

  @override
  Future<void> markInboxHandled(
    String actorId,
    String entryId, {
    String? reason,
  }) async {
    markInboxHandledCalls
        .add((actorId: actorId, entryId: entryId, reason: reason));
    final err = markInboxHandledError;
    if (err != null) throw err;
  }

  // ── Obligations routes ──
  List<ObligationDto> obligationsResult = [];
  Map<String, ObligationDetailSnapshot> obligationDetails = {};
  Map<String, ObligationTreeDto> obligationTrees = {};
  final createObligationCalls = <({String ownerKind, String ownerId, String? parentId, String? intent, String? externalRef, double? priority})>[];
  final statusCalls = <({String id, String status})>[];
  final reorderCalls = <({String id, String? previousId, String? nextId, String scope})>[];
  final reparentCalls = <({String id, String? parentId})>[];
  final reassignCalls = <({String id, String ownerKind, String ownerId})>[];

  @override
  Future<ObligationPage> fetchObligations({
    String? ownerKind,
    String? ownerId,
    String? status,
    bool? rootsOnly,
    int? limit,
    int? offset,
  }) async {
    var list = obligationsResult;
    if (ownerKind != null) {
      list = list.where((o) => o.owner.kind == ownerKind).toList();
    }
    if (ownerId != null) {
      list = list.where((o) => o.owner.id == ownerId).toList();
    }
    if (status != null) {
      list = list.where((o) => o.status == status).toList();
    }
    if (rootsOnly == true) {
      list = list.where((o) => o.parentId == null).toList();
    }
    return ObligationPage(obligations: list, total: list.length, hasMore: false);
  }

  @override
  Future<ObligationDetailSnapshot> fetchObligationDetail(
    String id, {
    int? childrenOffset,
    int? blockingOffset,
    int? limit,
  }) async {
    if (obligationDetails.containsKey(id)) {
      return obligationDetails[id]!;
    }
    final ob = obligationsResult.firstWhere(
      (o) => o.id == id,
      orElse: () => makeObligation(id),
    );
    return ObligationDetailSnapshot(
      obligation: ob,
      parent: ob.parentId == null ? null : makeObligation(ob.parentId!),
      children: obligationsResult.where((o) => o.parentId == id).toList(),
      blockingChildren: obligationsResult.where((o) => o.parentId == id && o.status != 'done' && o.status != 'cancelled').toList(),
    );
  }

  @override
  Future<ObligationTreeDto> fetchObligationTree(String id) async {
    if (obligationTrees.containsKey(id)) {
      return obligationTrees[id]!;
    }
    final ob = obligationsResult.firstWhere(
      (o) => o.id == id,
      orElse: () => makeObligation(id),
    );
    final children = obligationsResult.where((o) => o.parentId == id).map((c) => ObligationTreeDto(
      obligation: c,
      children: obligationsResult.where((gc) => gc.parentId == c.id).map((gc) => ObligationTreeDto(obligation: gc, children: [], blockingChildren: [])).toList(),
      blockingChildren: [],
    )).toList();
    return ObligationTreeDto(
      obligation: ob,
      children: children,
      blockingChildren: [],
    );
  }

  @override
  Future<ObligationDto> createObligation({
    required String ownerKind,
    required String ownerId,
    String? parentId,
    String? intent,
    String? externalRef,
    double? priority,
  }) async {
    createObligationCalls.add((
      ownerKind: ownerKind,
      ownerId: ownerId,
      parentId: parentId,
      intent: intent,
      externalRef: externalRef,
      priority: priority,
    ));
    final created = makeObligation(
      'ob-${obligationsResult.length + 1}',
      parentId: parentId,
      ownerKind: ownerKind,
      ownerId: ownerId,
      intent: intent,
      externalRef: externalRef,
      priority: priority,
    );
    obligationsResult = [...obligationsResult, created];
    return created;
  }

  @override
  Future<ObligationDto> setObligationStatus(String id, String status) async {
    statusCalls.add((id: id, status: status));
    final index = obligationsResult.indexWhere((o) => o.id == id);
    if (index >= 0) {
      final old = obligationsResult[index];
      final updated = makeObligation(
        old.id,
        parentId: old.parentId,
        ownerKind: old.owner.kind,
        ownerId: old.owner.id,
        intent: old.intent,
        externalRef: old.externalRef,
        status: status,
        priority: old.priority,
        effectivePriority: old.effectivePriority,
        prioritySourceId: old.prioritySourceId,
      );
      obligationsResult[index] = updated;
      return updated;
    }
    return makeObligation(id, status: status);
  }

  @override
  Future<ObligationDto> reorderObligation(
    String id, {
    String? previousId,
    String? nextId,
    String scope = 'subtree',
  }) async {
    reorderCalls.add((id: id, previousId: previousId, nextId: nextId, scope: scope));
    final ob = obligationsResult.firstWhere((o) => o.id == id, orElse: () => makeObligation(id));
    return ob;
  }

  @override
  Future<ObligationDto> reparentObligation(String id, {String? parentId}) async {
    reparentCalls.add((id: id, parentId: parentId));
    final index = obligationsResult.indexWhere((o) => o.id == id);
    if (index >= 0) {
      final old = obligationsResult[index];
      final updated = makeObligation(
        old.id,
        parentId: parentId,
        ownerKind: old.owner.kind,
        ownerId: old.owner.id,
        intent: old.intent,
        externalRef: old.externalRef,
        status: old.status,
        priority: old.priority,
        effectivePriority: old.effectivePriority,
        prioritySourceId: old.prioritySourceId,
      );
      obligationsResult[index] = updated;
      return updated;
    }
    return makeObligation(id, parentId: parentId);
  }

  @override
  Future<ObligationDto> reassignObligation(
    String id, {
    required String ownerKind,
    required String ownerId,
  }) async {
    reassignCalls.add((id: id, ownerKind: ownerKind, ownerId: ownerId));
    final old = obligationsResult.firstWhere(
      (o) => o.id == id,
      orElse: () => makeObligation(id),
    );
    return makeObligation(
      old.id,
      parentId: old.parentId,
      ownerKind: ownerKind,
      ownerId: ownerId,
      intent: old.intent,
      externalRef: old.externalRef,
      status: old.status,
      priority: old.priority,
      effectivePriority: old.effectivePriority,
      prioritySourceId: old.prioritySourceId,
    );
  }

  @override
  void close() {}
}

/// Fake avatar file picker : returns [next] once per [pickImage] call,
/// recording how many times it was invoked so a test can assert the picker
/// was (or wasn't) opened.
class FakeAvatarFilePicker implements AvatarFilePicker {
  PickedAvatarImage? next = PickedAvatarImage(
    bytes: Uint8List.fromList([1, 2, 3]),
    contentType: 'image/png',
  );
  int pickCalls = 0;

  @override
  Future<PickedAvatarImage?> pickImage() async {
    pickCalls++;
    return next;
  }
}

/// In-memory [QuotaCache] for headless store tests — stands in for the browser
/// localStorage-backed `WebQuotaCache`. Seed [stored] to simulate a prior
/// session's persisted snapshot; `saveCount`/`clearCount` record write-backs.
class FakeQuotaCache implements QuotaCache {
  FakeQuotaCache([this.stored]);

  QuotaSnapshotDto? stored;
  int saveCount = 0;
  int clearCount = 0;

  @override
  QuotaSnapshotDto? load() => stored;

  @override
  void save(QuotaSnapshotDto snapshot) {
    stored = snapshot;
    saveCount++;
  }

  @override
  void clear() {
    stored = null;
    clearCount++;
  }
}

/// In-memory [TreePreferencesCache] for headless store tests.
class FakeTreePreferencesCache implements TreePreferencesCache {
  FakeTreePreferencesCache({
    this.storedCollapsed,
    this.storedShowRetired,
    this.storedActorOrder,
  });

  Set<String>? storedCollapsed;
  bool? storedShowRetired;
  Map<String, List<String>>? storedActorOrder;
  int saveCollapsedCount = 0;
  int saveShowRetiredCount = 0;
  int saveActorOrderCount = 0;
  int clearCount = 0;

  @override
  Set<String>? loadCollapsed() => storedCollapsed;

  @override
  void saveCollapsed(Set<String> collapsed) {
    storedCollapsed = Set.of(collapsed);
    saveCollapsedCount++;
  }

  @override
  bool? loadShowRetired() => storedShowRetired;

  @override
  void saveShowRetired(bool showRetired) {
    storedShowRetired = showRetired;
    saveShowRetiredCount++;
  }

  @override
  Map<String, List<String>>? loadActorOrder() =>
      storedActorOrder == null
          ? null
          : {
            for (final entry in storedActorOrder!.entries)
              entry.key: List<String>.from(entry.value),
          };

  @override
  void saveActorOrder(Map<String, List<String>> order) {
    storedActorOrder = {
      for (final entry in order.entries)
        entry.key: List<String>.from(entry.value),
    };
    saveActorOrderCount++;
  }

  @override
  void clear() {
    storedCollapsed = null;
    storedShowRetired = null;
    storedActorOrder = null;
    clearCount++;
  }
}

// ── Walkie-talkie platform fakes  ──

VoiceAnnouncement makeAnnouncement(
  String id, {
  String actor = 'a',
  String? text,
}) => VoiceAnnouncement(
  id: id,
  actorId: actor,
  text: text ?? 'reply $id',
  audioUrl: '/api/mesh/voice/audio/$id',
  mime: 'audio/wav',
  createdAt: '2026-07-17T00:00:00Z',
);

class FakeVoiceRecorder implements VoiceRecorder {
  int startCalls = 0;
  int stopCalls = 0;
  int cancelCalls = 0;
  Object? startError;
  RecordedAudio result = RecordedAudio(
    bytes: Uint8List.fromList([1, 2, 3]),
    mimeType: 'audio/webm;codecs=opus',
  );

  @override
  Future<void> start() async {
    startCalls++;
    final err = startError;
    if (err != null) throw err;
  }

  @override
  Future<RecordedAudio> stop() async {
    stopCalls++;
    return result;
  }

  @override
  Future<void> cancel() async {
    cancelCalls++;
  }
}

/// Fake player: each [play] blocks on a completer the test finishes via
/// [finishCurrent] (natural end) — [stop] mirrors the real skip semantics
/// (pending future completes normally).
class FakeVoicePlayer implements VoicePlayer {
  int primeCalls = 0;
  final playedUrls = <String>[];
  Completer<void>? _current;

  bool get isPlaying => _current != null && !_current!.isCompleted;

  @override
  Future<void> prime() async {
    primeCalls++;
  }

  @override
  Future<void> play(String url) {
    playedUrls.add(url);
    final c = Completer<void>();
    _current = c;
    return c.future;
  }

  @override
  void stop() {
    final c = _current;
    if (c != null && !c.isCompleted) c.complete();
  }

  void finishCurrent() {
    final c = _current;
    if (c != null && !c.isCompleted) c.complete();
  }

  void failCurrent([Object? error]) {
    final c = _current;
    if (c != null && !c.isCompleted) {
      c.completeError(error ?? StateError('audio failed'));
    }
  }
}

class FakeWakeLock implements ScreenWakeLock {
  int acquireCalls = 0;
  int releaseCalls = 0;

  @override
  Future<void> acquire() async {
    acquireCalls++;
  }

  @override
  Future<void> release() async {
    releaseCalls++;
  }
}

/// Fake `voice` SSE source driven by exposed controllers.
class FakeVoiceStream implements VoiceStreamSource {
  final framesCtrl = StreamController<VoiceAnnouncement>.broadcast();
  final statusCtrl = StreamController<VoiceStreamStatus>.broadcast();
  final connectCalls = <List<String>>[];
  bool disposed = false;

  @override
  Stream<VoiceAnnouncement> get frames => framesCtrl.stream;
  @override
  Stream<VoiceStreamStatus> get status => statusCtrl.stream;

  @override
  void connect(List<String> actors) => connectCalls.add(actors);

  @override
  void dispose() {
    disposed = true;
    framesCtrl.close();
    statusCtrl.close();
  }
}

/// Bundle of all walkie fakes plus the [WalkieDeps] handed to the controller.
/// [streams] records every stream the factory produced (one per mode entry).
class FakeWalkie {
  FakeWalkie(FakeApi api)
    : recorder = FakeVoiceRecorder(),
      player = FakeVoicePlayer(),
      wakeLock = FakeWakeLock() {
    deps = WalkieDeps(
      api: api,
      recorder: recorder,
      player: player,
      wakeLock: wakeLock,
      createStream: () {
        final s = FakeVoiceStream();
        streams.add(s);
        return s;
      },
    );
  }

  final FakeVoiceRecorder recorder;
  final FakeVoicePlayer player;
  final FakeWakeLock wakeLock;
  final streams = <FakeVoiceStream>[];
  late final WalkieDeps deps;

  FakeVoiceStream get stream => streams.last;
}

/// Fake SSE source driven by exposed controllers.
class FakeStream implements MeshStreamSource {
  final meshCtrl = StreamController<MeshEvent>.broadcast();
  final liveCtrl = StreamController<LiveOutputChunk>.broadcast();
  final elidedCtrl = StreamController<void>.broadcast();
  final connectCalls = <List<String>>[];

  @override
  Stream<MeshEvent> get meshEvents => meshCtrl.stream;
  @override
  Stream<LiveOutputChunk> get liveOutput => liveCtrl.stream;
  @override
  Stream<void> get elided => elidedCtrl.stream;
  @override
  void connect(List<String> actors) => connectCalls.add(actors);
  @override
  void dispose() {}
}
