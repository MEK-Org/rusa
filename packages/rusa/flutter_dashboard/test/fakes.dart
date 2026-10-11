import 'dart:async';
import 'dart:typed_data';

import 'package:rusa_dashboard/actor_hierarchy_cache.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/dashboard_timing.dart';
import 'package:rusa_dashboard/avatar_platform.dart';
import 'package:rusa_dashboard/mesh_stream.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/obligations_cache.dart';
import 'package:rusa_dashboard/quota_cache.dart';
import 'package:rusa_dashboard/tree_preferences_cache.dart';
import 'package:rusa_dashboard/voice_platform.dart';

const testUserPrincipalId = '00000000-0000-4000-8000-000000000001';

ThreadDto makeThread(
  String id, {
  String? parent,
  String status = 'active',
  String created = '2026-01-01T00:00:00Z',
  String? lastActiveAt,
  RunState runState = RunState.unknown,
  String? title,
  String? provider,
  String? model,
  String? effort,
  String? desiredModel,
  String? desiredEffort,
  bool? effortChangePending,
  String? desiredProvider,
  List<ProviderModelConfig> modelConfig = const [],
  String? modelClass,
  List<ProviderModelConfig>? desiredModelConfig,
  String? desiredModelClass,
  String? commitmentKind,
  String? charterPreview,
  int? queuePosition,
  String? estimatedStartAt,
  ObligationDto? selectedObligation,
  InboxEntryDto? selectedInboxItem,
  int? moreInboxItemsCount,
  String? voiceName,
  int? pacingIntervalMs,
  bool admissionClaimed = false,
  List<String> compatibleLanes = const [],
  String? claimedLane,
  String? selectedProvider,
  String? selectedModel,
  String? selectedEffort,
  bool needsAttention = false,
  String? needsAttentionReason,
}) => ThreadDto(
  id: id,
  handle: '$id-handle',
  parentId: parent,
  status: status,
  provider: provider,
  model: model,
  effort: effort,
  desiredModel: desiredModel,
  desiredEffort: desiredEffort,
  effortChangePending: effortChangePending ?? desiredEffort != null,
  desiredProvider: desiredProvider,
  modelConfig: modelConfig,
  modelClass: modelClass,
  desiredModelConfig: desiredModelConfig,
  desiredModelClass: desiredModelClass,
  commitmentKind: commitmentKind,
  charterPreview: charterPreview ?? 'charter $id',
  title: title ?? 'charter $id',
  createdAt: created,
  lastActiveAt: lastActiveAt,
  runState: runState,
  queuePosition: queuePosition,
  estimatedStartAt: estimatedStartAt,
  selectedObligation: selectedObligation,
  selectedInboxItem: selectedInboxItem,
  moreInboxItemsCount: moreInboxItemsCount,
  voiceConfig: voiceName == null
      ? null
      : VoiceConfigDto(provider: 'google', config: {'voiceName': voiceName}),
  pacingIntervalMs: pacingIntervalMs,
  admissionClaimed: admissionClaimed,
  compatibleLanes: compatibleLanes,
  claimedLane: claimedLane,
  selectedProvider: selectedProvider,
  selectedModel: selectedModel,
  selectedEffort: selectedEffort,
  needsAttention: needsAttention,
  needsAttentionReason: needsAttentionReason,
);

InboxEntryDto makeInboxEntry(
  String id, {
  String actorId = 'actor-1',
  String source = 'chat',
  String deliveredAt = '2026-09-01T10:00:00.000Z',
  String type = 'message',
  String? content,
  String? priority,
  ReferenceDto? reference,
}) => InboxEntryDto(
  id: id,
  actorId: actorId,
  source: source,
  deliveredAt: deliveredAt,
  payload: {'type': type, 'priority': ?priority, 'content': ?content},
  reference: reference,
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
  payload:
      payload ??
      (peer != null
          ? "{\"parentId\": \"$peer\", \"to\": \"$peer\", \"from\": \"$peer\"}"
          : null),
  success: null,
);

MeshChat makeChat(
  String id, {
  String sender = 'a',
  String recipient = '00000000-0000-4000-8000-000000000001',
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
  String ownerId = 'root',
  String? creatorId,
  String? intent,
  String? externalRef,
  String status = 'ready',
  double? priority,
  double effectivePriority = 100.0,
  String? prioritySourceId,
  String? terminalNote,
  String? title,
  String? resolutionRef,
  String? recurrencePolicy,
  String? recurrenceCron,
  int? recurrenceIntervalSeconds,
  String? nextReadyAt,
  String? snoozedUntil,
  String? checkpoint,
  String? checkpointAt,
  String? checkpointBy,
  bool hasCompletionHistory = false,
}) => ObligationDto(
  id: id,
  parentId: parentId,
  ownerId: ownerId,
  creatorId: creatorId,
  intent: intent ?? 'intent $id',
  externalRef: externalRef,
  status: status,
  priority: priority,
  effectivePriority: effectivePriority,
  prioritySourceId: prioritySourceId,
  terminalNote: terminalNote,
  // Defaults to the intent's heading so existing fixtures keep rendering
  // the label their assertions look for.
  title: title ?? intent ?? 'intent $id',
  resolutionRef: resolutionRef,
  recurrencePolicy: recurrencePolicy,
  recurrenceCron: recurrenceCron,
  recurrenceIntervalSeconds: recurrenceIntervalSeconds,
  nextReadyAt: nextReadyAt,
  snoozedUntil: snoozedUntil,
  checkpoint: checkpoint,
  // A checkpoint's stamp is set with it server-side, so a fixture that names a
  // standing without one would exercise a state the store cannot produce.
  checkpointAt: checkpoint == null
      ? null
      : (checkpointAt ?? '2026-09-07T11:00:00.000Z'),
  checkpointBy: checkpoint == null ? null : (checkpointBy ?? ownerId),
  hasCompletionHistory: hasCompletionHistory,
);

/// Fake REST API with canned responses; records the actor lists it was queried
/// with so tests can assert what the store requested.
class FakeApi extends DashboardApi {
  FakeApi({super.base}) : super();
  List<ThreadDto> threadsResult = [];
  List<SupportedVoiceDto> supportedVoices = const [];
  QuotaSnapshotDto? quotaResult;
  QuotaHistoryDto? quotaHistoryResult;
  Object? quotaError;
  Object? quotaHistoryError;
  DashboardConfigDto? dashboardConfigResult;
  Completer<DashboardConfigDto>? dashboardConfigGate;
  bool halted = false;
  HaltStatusDto? halt;
  List<String>? schedulerWarning;
  RuntimeCursor? runtimeCursor;
  int threadsCallCount = 0;
  final threadSnapshotGates = <Completer<ThreadsSnapshot>>[];
  Object? threadsError;
  final timingInteractions =
      <({DashboardInteraction interaction, String outcome})>[];
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
      <({String charter, String? title, String? provider, String? model})>[];
  String spawnedRootChildId = 'spawned-child';
  final actorReparentCalls = <({String id, String parentId})>[];
  Object? actorReparentError;

  /// When set, the NEXT fetchQuota awaits this instead of returning
  /// [quotaResult] immediately — lets a test observe the SWR "refreshing"
  /// window (ISSUE_NUM ask 4) before letting the background revalidation resolve.
  Completer<QuotaSnapshotDto>? quotaGate;

  /// When set, the NEXT fetchEvents awaits this instead of returning a canned
  /// page — lets a test inject a live SSE frame mid-fetch (the seam window).
  Completer<EventPage>? eventsGate;

  @override
  Future<T> trackInteraction<T>(
    DashboardInteraction interaction,
    Future<T> Function() action,
  ) async {
    try {
      final result = await action();
      timingInteractions.add((interaction: interaction, outcome: 'success'));
      return result;
    } catch (_) {
      timingInteractions.add((interaction: interaction, outcome: 'failure'));
      rethrow;
    }
  }

  @override
  Future<ThreadsSnapshot> fetchThreads() async {
    threadsCallCount++;
    final error = threadsError;
    if (error != null) throw error;
    if (threadSnapshotGates.isNotEmpty) {
      return threadSnapshotGates.removeAt(0).future;
    }
    return ThreadsSnapshot(
      halted: halted,
      halt: halt,
      schedulerWarning: schedulerWarning,
      threads: threadsResult,
      runtimeCursor: runtimeCursor,
      supportedVoices: supportedVoices,
    );
  }

  /// The server Chat Room roster (#663), root first.
  List<String> chatRoomParticipants = const ['root'];
  int chatRoomCallCount = 0;

  @override
  Future<List<String>> fetchChatRoom() async {
    chatRoomCallCount++;
    return chatRoomParticipants;
  }

  /// What `/api/mesh/references` answers (#940); a ref missing here comes
  /// back unavailable, as the server answers a ref it cannot resolve.
  Map<String, ReferenceDto> referencesResult = {};

  /// Each batch asked for, in order.
  final referenceRequests = <List<String>>[];

  /// Optional observer for assertions about when enrichment starts.
  void Function()? onFetchReferences;

  /// When set, each references answer waits on this, so a test can see the
  /// pane painted before its references arrive.
  Completer<void>? referencesGate;
  Object? referencesError;

  /// Per-call answers for tests that need independent concurrent responses.
  /// Each callback receives its request's immutable batch before any wait.
  final scriptedReferenceResponses =
      <FutureOr<Map<String, ReferenceDto>> Function(List<String>)>[];

  /// When set, answers each ref ahead of [referencesResult]; null defers.
  ReferenceDto? Function(String ref)? referenceFor;

  @override
  Future<Map<String, ReferenceDto>> fetchReferences(
    Iterable<String> refs,
  ) async {
    final batch = refs.toSet().toList();
    referenceRequests.add(batch);
    onFetchReferences?.call();
    if (scriptedReferenceResponses.isNotEmpty) {
      return scriptedReferenceResponses.removeAt(0)(batch);
    }
    await referencesGate?.future;
    final error = referencesError;
    if (error != null) throw error;
    return {
      for (final ref in batch)
        ref:
            referenceFor?.call(ref) ??
            referencesResult[ref] ??
            ReferenceDto(
              ref: ref,
              scheme: ref.split(':').first,
              title: ref,
              unavailable: 'could not load context',
              cacheState: 'unavailable',
            ),
    };
  }

  List<RecentActivityItem> recentActivityResult = [];
  int recentActivityCallCount = 0;

  /// Per-call feed answers, taken ahead of [recentActivityResult].
  final scriptedRecentActivity =
      <Future<List<RecentActivityItem>> Function()>[];

  @override
  Future<List<RecentActivityItem>> fetchRecentActivity({int limit = 50}) async {
    recentActivityCallCount++;
    if (scriptedRecentActivity.isNotEmpty) {
      return scriptedRecentActivity.removeAt(0)();
    }
    return recentActivityResult;
  }

  final actorVoiceUpdates = <({String actorId, VoiceConfigDto? voiceConfig})>[];

  @override
  Future<VoiceConfigDto?> updateActorVoice(
    String actorId,
    VoiceConfigDto? voiceConfig,
  ) async {
    actorVoiceUpdates.add((actorId: actorId, voiceConfig: voiceConfig));
    threadsResult = [
      for (final thread in threadsResult)
        thread.id == actorId
            ? thread.copyWith(voiceConfig: voiceConfig)
            : thread,
    ];
    return voiceConfig;
  }

  @override
  Future<List<String>> fetchRootControlProviders() async =>
      rootControlProviders;

  /// Full charters the detail panel can pull, keyed by thread id. Absent means
  /// the server had nothing to add beyond the preview — which is what the real
  /// route answers for a short charter, and is why the fallback below is the
  /// preview rather than empty: the route reads the same field the list clipped,
  /// so it cannot answer with less than the list already carried.
  final charters = <String, String>{};
  final charterCalls = <String>[];
  Object? charterError;

  /// When non-empty, each fetchCharter takes the next of these instead of
  /// answering at once — lets a test hold two fetches open and resolve them in
  /// whichever order it likes.
  final charterGates = <Completer<String>>[];

  @override
  Future<String> fetchCharter(String threadId) async {
    charterCalls.add(threadId);
    final err = charterError;
    if (err != null) throw err;
    if (charterGates.isNotEmpty) return charterGates.removeAt(0).future;
    return charters[threadId] ?? _previewOf(threadId);
  }

  String _previewOf(String threadId) {
    for (final thread in threadsResult) {
      if (thread.id == threadId) return thread.charterPreview;
    }
    return '';
  }

  @override
  Future<String> spawnRootChild({
    required String charter,
    String? title,
    String? provider,
    String? model,
  }) async {
    rootSpawnCalls.add((
      charter: charter,
      title: title,
      provider: provider,
      model: model,
    ));
    threadsResult = [
      ...threadsResult,
      makeThread(spawnedRootChildId, parent: 'root', title: title),
    ];
    return spawnedRootChildId;
  }

  @override
  Future<void> reparentActor(String id, {required String parentId}) async {
    actorReparentCalls.add((id: id, parentId: parentId));
    final error = actorReparentError;
    if (error != null) throw error;
    threadsResult = [
      for (final thread in threadsResult)
        thread.id == id ? thread.copyWith(parentId: parentId) : thread,
    ];
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
    final gate = dashboardConfigGate;
    if (gate != null) {
      dashboardConfigGate = null;
      return gate.future;
    }
    return dashboardConfigResult ??
        const DashboardConfigDto(
          quotaProviders: {},
          userPrincipalId: testUserPrincipalId,
          users: [
            UserPrincipalDto(
              id: testUserPrincipalId,
              email: 'viewer@example.test',
            ),
          ],
        );
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

  /// Newest `run_start` per actor for [fetchLatestRunStart]; kept apart from
  /// [eventPages] so run-model lookups never consume a test's event pages.
  final latestRunStarts = <String, MeshEvent>{};
  final runStartLookups = <String>[];

  @override
  Future<MeshEvent?> fetchLatestRunStart(String actorId) async {
    runStartLookups.add(actorId);
    return latestRunStarts[actorId];
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

  /// Optional per-request gates for testing the ordering of concurrent fetches.
  final backlogGates = <Completer<List<VoiceAnnouncement>>>[];
  int backlogCalls = 0;
  final backlogActorIds = <String>[];
  DashboardApiException? backlogError;

  final ackedIds = <String>[];
  DashboardApiException? ackError;

  VoiceMemoResult memoResult = const VoiceMemoResult(
    transcript: 'hello',
    delivered: true,
  );
  DashboardApiException? memoError;

  /// Holds [sendVoiceMemo] open while set, so a test can observe sending.
  Completer<void>? memoGate;
  final memoSends =
      <
        ({String actorId, int byteLength, String mimeType, String? sessionId})
      >[];
  final disabledVoiceSessions = <String>[];

  @override
  Future<List<VoiceAnnouncement>> fetchVoiceBacklog(String actorId) async {
    backlogCalls++;
    backlogActorIds.add(actorId);
    final err = backlogError;
    if (err != null) throw err;
    if (backlogGates.isNotEmpty) return backlogGates.removeAt(0).future;
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
      sessionId: sessionId,
    ));
    final gate = memoGate;
    if (gate != null) await gate.future;
    final err = memoError;
    if (err != null) throw err;
    return memoResult;
  }

  @override
  Future<void> disableVoiceSession(String sessionId) async {
    disabledVoiceSessions.add(sessionId);
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

  final interruptCalls = <String>[];
  DashboardApiException? interruptError;

  @override
  Future<void> interruptActor(String actorId) async {
    interruptCalls.add(actorId);
    final err = interruptError;
    if (err != null) throw err;
  }

  final admissionReorderCalls =
      <
        ({String threadId, String? beforeThreadId, List<String> observedOrder})
      >[];
  DashboardApiException? admissionReorderError;

  @override
  Future<void> reorderAdmissionQueue({
    required String threadId,
    required String? beforeThreadId,
    required List<String> observedOrder,
  }) async {
    admissionReorderCalls.add((
      threadId: threadId,
      beforeThreadId: beforeThreadId,
      observedOrder: observedOrder,
    ));
    final err = admissionReorderError;
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
    uploadCalls.add((
      id: id,
      imageBase64: imageBase64,
      contentType: contentType,
    ));
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
    markInboxHandledCalls.add((
      actorId: actorId,
      entryId: entryId,
      reason: reason,
    ));
    final err = markInboxHandledError;
    if (err != null) throw err;
  }

  // ── Obligations routes ──
  List<ObligationDto> obligationsResult = [];
  Map<String, ObligationDetailSnapshot> obligationDetails = {};
  Map<String, List<ObligationDto>> obBlockedBy = {};
  Map<String, int> obBlockedByTotal = {};
  Map<String, bool> obBlockedByHasMore = {};
  Map<String, List<ObligationDto>> obBlocks = {};
  Map<String, int> obBlocksTotal = {};
  Map<String, bool> obBlocksHasMore = {};

  /// When set, computes the detail snapshot per call instead of the static
  /// [obligationDetails] map — needed to fake a paginated completions field
  /// that actually varies with `completionsOffset`.
  ObligationDetailSnapshot Function(String id, int? completionsOffset)?
  obligationDetailByOffset;
  Map<String, ObligationTreeDto> obligationTrees = {};
  final createObligationCalls =
      <
        ({
          String ownerId,
          String title,
          String? parentId,
          String? intent,
          String? externalRef,
          double? priority,
        })
      >[];
  final statusCalls =
      <({String id, String status, String? note, String? resolutionRef})>[];
  final reorderCalls =
      <({String id, String? previousId, String? nextId, String scope})>[];
  final reparentCalls = <({String id, String? parentId})>[];
  final reassignCalls = <({String id, String ownerId, String? message})>[];
  final fetchObligationsCalls =
      <({String? ownerId, String? status, String? queue, bool? rootsOnly})>[];

  /// When set, pages are cut to this many rows, or fewer if the request asked
  /// for fewer, in [obligationsResult] order, like the server's page limit.
  int? obligationPageLimit;

  /// Holds every queue-page request (`queue` set, as Overview's My Queue
  /// sends) until completed. The page is computed when the call is made, so
  /// a held request returns the data as it stood then, like a slow response.
  Completer<void>? obligationQueuePagesGate;

  /// Thrown by queue-page requests (after any gate) while set.
  Object? obligationQueuePagesError;

  @override
  Future<ObligationPage> fetchObligations({
    String? ownerId,
    String? status,
    String? queue,
    bool? rootsOnly,
    int? limit,
    int? offset,
  }) async {
    fetchObligationsCalls.add((
      ownerId: ownerId,
      status: status,
      queue: queue,
      rootsOnly: rootsOnly,
    ));
    var list = obligationsResult;
    if (ownerId != null) {
      list = list.where((o) => o.ownerId == ownerId).toList();
    }
    if (status != null) {
      list = list.where((o) => o.status == status).toList();
    }
    // Mirrors the server's queue predicates, which the DTO getters match.
    switch (queue) {
      case 'ready':
        list = list.where((o) => o.isReady).toList();
      case 'waiting':
        list = list.where((o) => o.isWaiting).toList();
      case 'scheduled':
        list = list.where((o) => o.isScheduled).toList();
    }
    if (rootsOnly == true) {
      list = list.where((o) => o.parentId == null).toList();
    }
    final total = list.length;
    final pageLimit = switch ((limit, obligationPageLimit)) {
      (final asked?, final max?) => asked < max ? asked : max,
      (final asked, final max) => asked ?? max,
    };
    if (pageLimit != null && list.length > pageLimit) {
      list = list.take(pageLimit).toList();
    }
    if (queue != null) {
      final gate = obligationQueuePagesGate;
      if (gate != null) await gate.future;
      final error = obligationQueuePagesError;
      if (error != null) throw error;
    }
    return ObligationPage(
      obligations: list,
      total: total,
      hasMore: list.length < total,
    );
  }

  /// Holds every obligation detail request until completed.
  Completer<void>? obligationDetailGate;

  /// Ids whose detail answers 404 "obligation not found", as the server does
  /// for an obligation that no longer exists.
  Set<String> deletedObligationIds = {};

  /// Thrown by the detail request for each id (after any gate).
  Map<String, Object> obligationDetailErrors = {};

  ObligationDetailSnapshot Function(String id, String? historyBefore)?
  obligationDetailByHistory;
  int obligationDetailCallCount = 0;

  @override
  Future<ObligationDetailSnapshot> fetchObligationDetail(
    String id, {
    String? historyBefore,
    int? historyLimit,
    int? childrenOffset,
    int? blockingOffset,
    int? completionsOffset,
    int? limit,
  }) async {
    obligationDetailCallCount++;
    final detailGate = obligationDetailGate;
    if (detailGate != null) await detailGate.future;
    if (deletedObligationIds.contains(id)) {
      throw DashboardApiException(
        base.resolve('/api/mesh/obligations/$id'),
        404,
        '{"error":"obligation not found"}',
      );
    }
    if (obligationDetailErrors[id] case final error?) throw error;
    if (obligationDetailByHistory != null) {
      return obligationDetailByHistory!(id, historyBefore);
    }
    final byOffset = obligationDetailByOffset;
    if (byOffset != null) {
      return byOffset(id, completionsOffset);
    }
    if (obligationDetails.containsKey(id)) {
      return obligationDetails[id]!;
    }
    final ob = obligationsResult.firstWhere(
      (o) => o.id == id,
      orElse: () => makeObligation(id),
    );
    final blockedBy = obBlockedBy[id] ?? const <ObligationDto>[];
    final blocks = obBlocks[id] ?? const <ObligationDto>[];
    return ObligationDetailSnapshot(
      obligation: ob,
      parent: ob.parentId == null
          ? null
          : obligationsResult.firstWhere(
              (o) => o.id == ob.parentId!,
              orElse: () => makeObligation(ob.parentId!),
            ),
      children: obligationsResult.where((o) => o.parentId == id).toList(),
      blockingChildren: obligationsResult
          .where(
            (o) =>
                o.parentId == id &&
                o.status != 'done' &&
                o.status != 'cancelled',
          )
          .toList(),
      blockedBy: blockedBy,
      blockedByTotal: obBlockedByTotal[id] ?? blockedBy.length,
      blockedByHasMore: obBlockedByHasMore[id] ?? false,
      blocks: blocks,
      blocksTotal: obBlocksTotal[id] ?? blocks.length,
      blocksHasMore: obBlocksHasMore[id] ?? false,
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
    final children = obligationsResult
        .where((o) => o.parentId == id)
        .map(
          (c) => ObligationTreeDto(
            obligation: c,
            children: obligationsResult
                .where((gc) => gc.parentId == c.id)
                .map(
                  (gc) => ObligationTreeDto(
                    obligation: gc,
                    children: [],
                    blockingChildren: [],
                  ),
                )
                .toList(),
            blockingChildren: [],
          ),
        )
        .toList();
    return ObligationTreeDto(
      obligation: ob,
      children: children,
      blockingChildren: [],
    );
  }

  final fetchObligationForestCalls = <({bool includeTerminalRoots})>[];

  /// When non-empty, each fetchObligationForest call takes the next of these
  /// instead of resolving immediately — lets a test hold multiple calls open
  /// and complete them in whichever order it wants, to prove a stale response
  /// can't overwrite a newer one. The result is computed from [obligationsResult]
  /// as it stood when the call was made (matching a real request that read a
  /// snapshot of the data and is merely slow to arrive), then held until the
  /// gate completes — so mutating [obligationsResult] afterward does not change
  /// what an already in-flight call returns.
  final forestGates = <Completer<void>>[];
  Object? forestError;

  @override
  Future<ObligationForest> fetchObligationForest({
    int? limit,
    int? offset,
    bool includeTerminalRoots = false,
  }) async {
    if (forestError != null) {
      throw forestError!;
    }
    fetchObligationForestCalls.add((
      includeTerminalRoots: includeTerminalRoots,
    ));
    final page = await fetchObligations(
      rootsOnly: true,
      limit: limit,
      offset: offset,
    );
    // Mirrors the server default (#241): quiet terminal roots (done/
    // cancelled, not recurring, no completion history) are excluded unless
    // explicitly requested.
    final roots = includeTerminalRoots
        ? page.obligations
        : page.obligations
              .where(
                (o) => !o.isTerminal || o.isRecurring || o.hasCompletionHistory,
              )
              .toList();
    final trees = await Future.wait(
      roots.map((o) => fetchObligationTree(o.id)),
    );
    final forest = ObligationForest(
      trees: trees,
      total: includeTerminalRoots ? page.total : roots.length,
      hasMore: includeTerminalRoots ? page.hasMore : false,
    );
    if (forestGates.isNotEmpty) await forestGates.removeAt(0).future;
    return forest;
  }

  @override
  Future<ObligationDto> createObligation({
    required String ownerId,
    required String title,
    String? parentId,
    String? intent,
    String? externalRef,
    double? priority,
  }) async {
    createObligationCalls.add((
      ownerId: ownerId,
      title: title,
      parentId: parentId,
      intent: intent,
      externalRef: externalRef,
      priority: priority,
    ));
    final created = makeObligation(
      'ob-${obligationsResult.length + 1}',
      parentId: parentId,
      ownerId: ownerId,
      title: title,
      intent: intent,
      externalRef: externalRef,
      priority: priority,
    );
    obligationsResult = [...obligationsResult, created];
    return created;
  }

  @override
  Future<ObligationDto> setObligationStatus(
    String id,
    String status, {
    String? note,
    String? resolutionRef,
  }) async {
    statusCalls.add((
      id: id,
      status: status,
      note: note,
      resolutionRef: resolutionRef,
    ));
    final index = obligationsResult.indexWhere((o) => o.id == id);
    if (index >= 0) {
      final old = obligationsResult[index];
      final updated = makeObligation(
        old.id,
        parentId: old.parentId,
        ownerId: old.ownerId,
        intent: old.intent,
        externalRef: old.externalRef,
        status: status,
        priority: old.priority,
        effectivePriority: old.effectivePriority,
        prioritySourceId: old.prioritySourceId,
        terminalNote: note,
        title: old.title,
        resolutionRef: resolutionRef,
      );
      obligationsResult[index] = updated;
      return updated;
    }
    return makeObligation(id, status: status);
  }

  /// Each snooze write as the API was asked for it; null [until] clears.
  final snoozeCalls = <({String id, DateTime? until})>[];
  Object? snoozeError;
  String? snoozeWarning;

  @override
  Future<ObligationSnoozeResult> setObligationSnooze(
    String id,
    DateTime? until,
  ) async {
    snoozeCalls.add((id: id, until: until));
    if (snoozeError case final error?) throw error;
    final index = obligationsResult.indexWhere((o) => o.id == id);
    final old = index >= 0 ? obligationsResult[index] : makeObligation(id);
    // Round-trips like the server: millisecond precision, UTC with `Z`.
    final persisted = until == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(
            until.millisecondsSinceEpoch,
            isUtc: true,
          ).toIso8601String();
    final updated = ObligationDto.fromJson({
      ...old.toJson(),
      'snoozedUntil': persisted,
    });
    if (index >= 0) obligationsResult[index] = updated;
    return ObligationSnoozeResult(obligation: updated, warning: snoozeWarning);
  }

  final externalRefCalls = <({String id, String? ref})>[];
  Object? externalRefError;

  @override
  Future<ObligationDto> setObligationExternalRef(String id, String? ref) async {
    externalRefCalls.add((id: id, ref: ref));
    if (externalRefError case final error?) throw error;
    final index = obligationsResult.indexWhere((o) => o.id == id);
    final trimmed = ref?.trim();
    final next = (trimmed == null || trimmed.isEmpty) ? null : trimmed;
    if (index >= 0) {
      final old = obligationsResult[index];
      final updated = makeObligation(
        old.id,
        parentId: old.parentId,
        ownerId: old.ownerId,
        title: old.title,
        intent: old.intent,
        externalRef: next,
        status: old.status,
        priority: old.priority,
        effectivePriority: old.effectivePriority,
        prioritySourceId: old.prioritySourceId,
      );
      obligationsResult[index] = updated;
      return updated;
    }
    return makeObligation(id, externalRef: next);
  }

  @override
  Future<ObligationDto> reorderObligation(
    String id, {
    String? previousId,
    String? nextId,
    String scope = 'subtree',
  }) async {
    reorderCalls.add((
      id: id,
      previousId: previousId,
      nextId: nextId,
      scope: scope,
    ));
    final ob = obligationsResult.firstWhere(
      (o) => o.id == id,
      orElse: () => makeObligation(id),
    );
    return ob;
  }

  @override
  Future<ObligationDto> reparentObligation(
    String id, {
    String? parentId,
  }) async {
    reparentCalls.add((id: id, parentId: parentId));
    final index = obligationsResult.indexWhere((o) => o.id == id);
    if (index >= 0) {
      final old = obligationsResult[index];
      final updated = makeObligation(
        old.id,
        parentId: parentId,
        ownerId: old.ownerId,
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
    required String ownerId,
    String? message,
  }) async {
    reassignCalls.add((id: id, ownerId: ownerId, message: message));
    final old = obligationsResult.firstWhere(
      (o) => o.id == id,
      orElse: () => makeObligation(id),
    );
    return makeObligation(
      old.id,
      parentId: old.parentId,
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

/// In-memory [ActorHierarchyCache] for headless store tests — stands in for
/// the browser localStorage-backed `WebActorHierarchyCache`. Seed [stored] to
/// simulate a prior session's persisted hierarchy; `saveCount`/`clearCount`
/// record write-backs and invalidations.
class FakeActorHierarchyCache implements ActorHierarchyCache {
  FakeActorHierarchyCache([this.stored]);

  PersistedActorHierarchy? stored;
  int saveCount = 0;
  int clearCount = 0;
  int loadCount = 0;

  @override
  PersistedActorHierarchy? load() {
    loadCount++;
    return stored;
  }

  @override
  void save(PersistedActorHierarchy hierarchy) {
    stored = hierarchy;
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
    this.storedWorkExpanded,
  });

  Set<String>? storedCollapsed;
  bool? storedShowRetired;
  Map<String, List<String>>? storedActorOrder;
  Set<String>? storedWorkExpanded;
  int saveCollapsedCount = 0;
  int saveShowRetiredCount = 0;
  int saveActorOrderCount = 0;
  int saveWorkExpandedCount = 0;
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
  Map<String, List<String>>? loadActorOrder() => storedActorOrder == null
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
  Set<String>? loadWorkExpanded() => storedWorkExpanded;

  @override
  void saveWorkExpanded(Set<String> expanded) {
    storedWorkExpanded = Set.of(expanded);
    saveWorkExpandedCount++;
  }

  @override
  void clear() {
    storedCollapsed = null;
    storedShowRetired = null;
    storedActorOrder = null;
    storedWorkExpanded = null;
    clearCount++;
  }
}

/// In-memory [ObligationsCache] for headless store tests — stands in for the browser
/// localStorage-backed `WebObligationsCache`. Seed [stored] to simulate a prior
/// session's persisted snapshot; `saveCount`/`invalidateCount`/`clearCount` record write-backs and invalidations.
class FakeObligationsCache implements ObligationsCache {
  FakeObligationsCache([this.stored]) {
    if (stored != null) {
      _entries['${stored!.scope}.${stored!.principalId}'] = stored!;
    }
  }

  PersistedObligationsSnapshot? stored;
  final Map<String, PersistedObligationsSnapshot> _entries = {};
  int saveCount = 0;
  int invalidateCount = 0;
  int clearCount = 0;
  int loadCount = 0;

  @override
  PersistedObligationsSnapshot? load({
    required String scope,
    required String principalId,
  }) {
    loadCount++;
    return _entries['$scope.$principalId'];
  }

  @override
  void save(PersistedObligationsSnapshot snapshot) {
    stored = snapshot;
    final key = '${snapshot.scope}.${snapshot.principalId}';
    _entries[key] = snapshot;
    saveCount++;
  }

  @override
  void invalidate({required String scope, required String principalId}) {
    _entries.remove('$scope.$principalId');
    if (stored?.scope == scope && stored?.principalId == principalId) {
      stored = null;
    }
    invalidateCount++;
  }

  /// Shared obligation store captures (#992), keyed like [_entries].
  final Map<String, PersistedObligationEntitiesSnapshot> entityEntries = {};
  int entitySaveCount = 0;
  int entityInvalidateCount = 0;

  @override
  PersistedObligationEntitiesSnapshot? loadEntities({
    required String scope,
    required String principalId,
  }) => entityEntries['$scope.$principalId'];

  @override
  void saveEntities(PersistedObligationEntitiesSnapshot snapshot) {
    entityEntries['${snapshot.scope}.${snapshot.principalId}'] = snapshot;
    entitySaveCount++;
  }

  @override
  void invalidateEntities({
    required String scope,
    required String principalId,
  }) {
    entityEntries.remove('$scope.$principalId');
    entityInvalidateCount++;
  }

  @override
  void clear() {
    stored = null;
    _entries.clear();
    entityEntries.clear();
    clearCount++;
  }
}

// ── Walkie-talkie platform fakes  ──

VoiceAnnouncement makeAnnouncement(
  String id, {
  String actor = 'a',
  String? text,
  String createdAt = '2026-07-17T00:00:00Z',
}) => VoiceAnnouncement(
  id: id,
  actorId: actor,
  text: text ?? 'reply $id',
  audioUrl: '/api/mesh/voice/audio/$id',
  mime: 'audio/wav',
  createdAt: createdAt,
);

class FakeVoiceRecorder implements VoiceRecorder {
  int startCalls = 0;
  int stopCalls = 0;
  int cancelCalls = 0;
  Object? startError;
  Completer<void>? startCompleter;

  /// Per-call acquisition gates for multi-start races: the Nth [start] call
  /// awaits index N-1 when present, letting tests resolve overlapping
  /// acquisitions in either completion order.
  final List<Completer<void>> startGates = [];
  RecordedAudio result = RecordedAudio(
    bytes: Uint8List.fromList([1, 2, 3]),
    mimeType: 'audio/webm;codecs=opus',
  );

  /// Mirrors `WebVoiceRecorder`'s ownership token: [cancel] and [stop] bump
  /// it, so a [start] still awaiting a gate when either runs is superseded
  /// and throws instead of returning normally.
  int _generation = 0;

  @override
  Future<void> start() async {
    startCalls++;
    final generation = _generation;
    final err = startError;
    if (err != null) throw err;
    final gate = startCalls <= startGates.length
        ? startGates[startCalls - 1]
        : null;
    if (gate != null) await gate.future;
    final c = startCompleter;
    if (c != null) await c.future;
    if (generation != _generation) {
      throw StateError(
        'mic acquisition superseded by a newer recording session',
      );
    }
  }

  @override
  Future<RecordedAudio> stop() async {
    stopCalls++;
    _generation++;
    return result;
  }

  @override
  Future<void> cancel() async {
    cancelCalls++;
    _generation++;
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
  final controlsCtrl = StreamController<VoiceSessionControl>.broadcast();
  final connectCalls = <({List<String> actors, String? sessionId})>[];
  bool disposed = false;

  @override
  Stream<VoiceAnnouncement> get frames => framesCtrl.stream;
  @override
  Stream<VoiceStreamStatus> get status => statusCtrl.stream;
  @override
  Stream<VoiceSessionControl> get controls => controlsCtrl.stream;

  @override
  void connect(List<String> actors, String? sessionId) =>
      connectCalls.add((actors: actors, sessionId: sessionId));

  @override
  void dispose() {
    disposed = true;
    framesCtrl.close();
    statusCtrl.close();
    controlsCtrl.close();
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
  final runtimeHelloCtrl = StreamController<RuntimeHello>.broadcast();
  final runtimeStatesCtrl =
      StreamController<ActorRuntimeStateDelta>.broadcast();
  final avatarCtrl = StreamController<AvatarGenerationUpdate>.broadcast();
  final connectCalls = <List<String>>[];

  @override
  Stream<MeshEvent> get meshEvents => meshCtrl.stream;
  @override
  Stream<LiveOutputChunk> get liveOutput => liveCtrl.stream;
  @override
  Stream<void> get elided => elidedCtrl.stream;
  @override
  Stream<RuntimeHello> get runtimeHello => runtimeHelloCtrl.stream;
  @override
  Stream<ActorRuntimeStateDelta> get runtimeStates => runtimeStatesCtrl.stream;
  @override
  Stream<AvatarGenerationUpdate> get avatarUpdates => avatarCtrl.stream;
  @override
  void connect(List<String> actors) => connectCalls.add(actors);
  @override
  void dispose() {}
}
