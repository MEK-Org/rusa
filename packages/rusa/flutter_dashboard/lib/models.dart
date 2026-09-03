import 'dart:convert';

const _keepThreadField = Object();

// Dart mirrors of the PR2 dashboard Data API JSON shapes
// (`packages/rusa/src/dashboard/api.ts` +
// `db/repositories/mesh-event-repository.ts`). Field names and nullability
// match the server exactly.

/// Per-actor run state. The server reports `running`/`winding_down`/`queued`/`idle` directly on the
/// thread payload (the cold-load seed); `unknown` is only the pre-load default
/// before any payload or SSE event has arrived.
enum RunState { running, windingDown, queued, idle, unknown }

/// What the tree dot shows for an actor (status + run state combined).
enum DotState { active, queued, idle, retired }

/// Parse the server's `runState` string; anything unexpected/absent is unknown.
RunState runStateFromJson(Object? raw) => switch (raw) {
  'running' => RunState.running,
  'winding_down' => RunState.windingDown,
  'queued' => RunState.queued,
  'idle' => RunState.idle,
  _ => RunState.unknown,
};

/// A mesh thread/actor, as returned by `GET /api/mesh/threads`.
class ThreadDto {
  const ThreadDto({
    required this.id,
    required this.handle,
    required this.parentId,
    required this.status,
    required this.provider,
    required this.model,
    this.effort,
    this.desiredModel,
    this.desiredEffort,
    this.effortChangePending = false,
    this.desiredProvider,
    required this.charterPreview,
    this.title = '',
    required this.createdAt,
    this.lastActiveAt,
    this.runState = RunState.unknown,
    this.chatDisabled = false,
    this.commitmentKind,
    this.waitingOn,
    this.nextProviderAvailableAt,
    this.ownerExpectsRetirement,
  });

  final String id;
  final String handle;
  final String? parentId;
  final String status; // "active" | "retired"
  final String? provider;

  /// The single authoritative model for this actor, as the server reports it.
  final String? model;

  /// Explicit provider-native reasoning level, or null for provider default.
  final String? effort;

  /// Pending desired model staged for next run boundary, or null if none.
  final String? desiredModel;

  /// Target effort for a pending change; null means restore provider default.
  final String? desiredEffort;

  /// Whether [desiredEffort] is present in the API response. This preserves the
  /// distinction between no staged change and an explicit null target.
  final bool effortChangePending;

  /// Pending desired provider staged for next run boundary, or null if none.
  final String? desiredProvider;

  /// The leading slice of the charter the server sends with the list — enough
  /// for the two-line excerpt in the overview, never the whole text. The full
  /// charter is fetched per actor when the detail panel opens one.
  final String charterPreview;
  final String title;
  final String createdAt;

  /// ISO-8601 timestamp of the actor's most recent mesh event, or null if the
  /// actor has never emitted one. Derived server-side from mesh_events .
  final String? lastActiveAt;

  /// Server-side run-state truth at fetch time — used to seed the dot/cursor on
  /// a cold load before any live `mesh_event` arrives.
  final RunState runState;

  final bool chatDisabled;

  final String? commitmentKind;
  final String? waitingOn;
  final String? nextProviderAvailableAt;
  final bool? ownerExpectsRetirement;

  bool get isRetired => status == 'retired';

  ThreadDto copyWith({
    String? id,
    String? handle,
    String? parentId,
    String? status,
    String? provider,
    String? model,
    Object? effort = _keepThreadField,
    Object? desiredModel = _keepThreadField,
    Object? desiredEffort = _keepThreadField,
    bool? effortChangePending,
    Object? desiredProvider = _keepThreadField,
    String? charterPreview,
    String? title,
    String? createdAt,
    String? lastActiveAt,
    RunState? runState,
    bool? chatDisabled,
    String? commitmentKind,
    String? waitingOn,
    String? nextProviderAvailableAt,
    bool? ownerExpectsRetirement,
  }) => ThreadDto(
    id: id ?? this.id,
    handle: handle ?? this.handle,
    parentId: parentId ?? this.parentId,
    status: status ?? this.status,
    provider: provider ?? this.provider,
    model: model ?? this.model,
    effort: identical(effort, _keepThreadField)
        ? this.effort
        : effort as String?,
    desiredModel: identical(desiredModel, _keepThreadField)
        ? this.desiredModel
        : desiredModel as String?,
    desiredEffort: identical(desiredEffort, _keepThreadField)
        ? this.desiredEffort
        : desiredEffort as String?,
    effortChangePending: effortChangePending ?? this.effortChangePending,
    desiredProvider: identical(desiredProvider, _keepThreadField)
        ? this.desiredProvider
        : desiredProvider as String?,
    charterPreview: charterPreview ?? this.charterPreview,
    title: title ?? this.title,
    createdAt: createdAt ?? this.createdAt,
    lastActiveAt: lastActiveAt ?? this.lastActiveAt,
    runState: runState ?? this.runState,
    chatDisabled: chatDisabled ?? this.chatDisabled,
    commitmentKind: commitmentKind ?? this.commitmentKind,
    waitingOn: waitingOn ?? this.waitingOn,
    nextProviderAvailableAt:
        nextProviderAvailableAt ?? this.nextProviderAvailableAt,
    ownerExpectsRetirement:
        ownerExpectsRetirement ?? this.ownerExpectsRetirement,
  );

  factory ThreadDto.fromJson(Map<String, dynamic> j) => ThreadDto(
    id: j['id'] as String,
    handle: j['handle'] as String,
    parentId: j['parentId'] as String?,
    status: j['status'] as String,
    provider: j['provider'] as String?,
    model: j['model'] as String?,
    effort: j['effort'] as String?,
    desiredModel: j['desiredModel'] as String?,
    desiredEffort: j['desiredEffort'] as String?,
    effortChangePending: j.containsKey('desiredEffort'),
    desiredProvider: j['desiredProvider'] as String?,
    charterPreview: j['charterPreview'] as String? ?? '',
    title: j['title'] as String? ?? '',
    createdAt: j['createdAt'] as String? ?? '',
    lastActiveAt: j['lastActiveAt'] as String?,
    runState: runStateFromJson(j['runState']),
    chatDisabled: j['chatDisabled'] as bool? ?? false,
    commitmentKind: j['commitmentKind'] as String?,
    waitingOn: j['waitingOn'] as String?,
    nextProviderAvailableAt: j['nextProviderAvailableAt'] as String?,
    ownerExpectsRetirement: j['ownerExpectsRetirement'] as bool?,
  );
}

/// The `GET /api/mesh/threads` response: the thread list plus the top-level
/// mesh halt state (the emergency brake), so the header can reflect a HALTED
/// system without a second fetch.
class ThreadsSnapshot {
  const ThreadsSnapshot({
    required this.halted,
    required this.threads,
    this.runtimeCursor,
    this.schedulerWarning,
  });

  final bool halted;
  final List<ThreadDto> threads;
  final RuntimeCursor? runtimeCursor;

  /// Boot-time `at`/`atrm`/`atd`/`atq` preflight issues, when that facility is
  /// unavailable — null when it's fine or the server doesn't report it. A
  /// missing one-shot facility never fails boot (cron-only recurrences keep
  /// working); this is the health-visible surface for that non-fatal state.
  final List<String>? schedulerWarning;

  factory ThreadsSnapshot.fromJson(Map<String, dynamic> j) => ThreadsSnapshot(
    halted: j['halted'] as bool? ?? false,
    runtimeCursor: j['runtimeCursor'] == null
        ? null
        : RuntimeCursor.fromJson(j['runtimeCursor'] as Map<String, dynamic>),
    threads: (j['threads'] as List<dynamic>? ?? const [])
        .map((e) => ThreadDto.fromJson(e as Map<String, dynamic>))
        .toList(),
    schedulerWarning: (j['schedulerWarning'] as List<dynamic>?)
        ?.map((e) => e as String)
        .toList(),
  );
}

class RuntimeCursor {
  const RuntimeCursor({required this.streamId, required this.revision});

  final String streamId;
  final int revision;

  factory RuntimeCursor.fromJson(Map<String, dynamic> j) => RuntimeCursor(
    streamId: j['streamId'] as String,
    revision: j['revision'] as int,
  );
}

class RuntimeHello {
  const RuntimeHello({required this.streamId});

  final String streamId;

  factory RuntimeHello.fromJson(Map<String, dynamic> j) =>
      RuntimeHello(streamId: j['streamId'] as String);
}

class ActorRuntimeStateDelta {
  const ActorRuntimeStateDelta({
    required this.streamId,
    required this.revision,
    required this.actorId,
    required this.runState,
  });

  final String streamId;
  final int revision;
  final String actorId;
  final RunState runState;

  factory ActorRuntimeStateDelta.fromJson(Map<String, dynamic> j) =>
      ActorRuntimeStateDelta(
        streamId: j['streamId'] as String,
        revision: j['revision'] as int,
        actorId: j['actorId'] as String,
        runState: runStateFromJson(j['runState']),
      );
}

/// Normalized view state for a single actor in the mesh.
/// Combines the underlying [ThreadDto] metadata with the live, reactive [RunState].
class ActorViewState {
  const ActorViewState({required this.thread, required this.runState});

  final ThreadDto thread;
  final RunState runState;

  String get id => thread.id;
  String get handle => thread.handle;
  String? get parentId => thread.parentId;
  String get status => thread.status;
  bool get isRetired => thread.isRetired;
  String? get provider => thread.provider;
  String? get model => thread.model;
  String? get desiredModel => thread.desiredModel;
  String? get desiredProvider => thread.desiredProvider;
  String get charterPreview => thread.charterPreview;
  String get title => thread.title;
  String get createdAt => thread.createdAt;
  String? get lastActiveAt => thread.lastActiveAt;
  bool get chatDisabled => thread.chatDisabled;
  String? get commitmentKind => thread.commitmentKind;
  String? get waitingOn => thread.waitingOn;
  String? get nextProviderAvailableAt => thread.nextProviderAvailableAt;
  bool? get ownerExpectsRetirement => thread.ownerExpectsRetirement;

  bool get isRunning => runState == RunState.running;
  bool get isWindingDown => runState == RunState.windingDown;
  bool get isQueued => runState == RunState.queued;
  bool get isIdle => runState == RunState.idle;
  bool get isActiveRun => isRunning || isWindingDown;

  DotState get dotState {
    if (isRetired) return DotState.retired;
    switch (runState) {
      case RunState.running:
      case RunState.windingDown:
        return DotState.active;
      case RunState.queued:
        return DotState.queued;
      case RunState.idle:
      case RunState.unknown:
        return DotState.idle;
    }
  }

  ActorViewState copyWith({ThreadDto? thread, RunState? runState}) =>
      ActorViewState(
        thread: thread ?? this.thread,
        runState: runState ?? this.runState,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ActorViewState &&
          runtimeType == other.runtimeType &&
          thread == other.thread &&
          runState == other.runState;

  @override
  int get hashCode => Object.hash(thread, runState);
}

/// Normalized snapshot of all actor states across the mesh.
/// Serves as the single source of truth for the actor tree, detail panel,
/// and overview tab.
class ActorStateSnapshot {
  const ActorStateSnapshot({
    this.revision = 0,
    this.actors = const {},
    this.orderedIds = const [],
  });

  final int revision;
  final Map<String, ActorViewState> actors;
  final List<String> orderedIds;

  ActorViewState? operator [](String id) => actors[id];
  ActorViewState? actor(String id) => actors[id];

  List<ActorViewState> get all =>
      orderedIds.map((id) => actors[id]).whereType<ActorViewState>().toList();

  List<ActorViewState> get runningActors =>
      all.where((a) => a.isRunning || a.isWindingDown).toList();

  List<ActorViewState> get queuedActors =>
      all.where((a) => a.isQueued).toList();

  DotState dotFor(String actorId) {
    return actors[actorId]?.dotState ?? DotState.idle;
  }

  DotState dotForThread(ThreadDto t) {
    if (t.isRetired) return DotState.retired;
    return actors[t.id]?.dotState ?? DotState.idle;
  }

  ActorStateSnapshot copyWith({
    int? revision,
    Map<String, ActorViewState>? actors,
    List<String>? orderedIds,
  }) => ActorStateSnapshot(
    revision: revision ?? this.revision,
    actors: actors ?? this.actors,
    orderedIds: orderedIds ?? this.orderedIds,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ActorStateSnapshot &&
          runtimeType == other.runtimeType &&
          revision == other.revision &&
          actors.length == other.actors.length;

  @override
  int get hashCode => Object.hash(revision, actors.length);
}

/// One mesh event, as returned by `GET /api/mesh/events` and the SSE
/// `mesh_event` channel.
class MeshEvent {
  const MeshEvent({
    required this.id,
    required this.ts,
    required this.kind,
    required this.actorId,
    required this.detail,
    required this.body,
    this.payload,
    required this.success,
  });

  final String id;
  final String ts;
  final String kind;
  final String? actorId;
  final String? detail;
  final String? body;
  final String? payload;
  final bool? success;

  factory MeshEvent.fromJson(Map<String, dynamic> j) => MeshEvent(
    id: j['id'] as String,
    ts: j['ts'] as String? ?? '',
    kind: j['kind'] as String? ?? '',
    actorId: j['actorId'] as String?,
    detail: j['detail'] as String?,
    body: j['body'] as String?,
    payload: j['payload'] as String?,
    success: j['success'] as bool?,
  );

  String? get messageRecipient {
    if (payload != null) {
      try {
        final decoded = jsonDecode(payload!) as Map<String, dynamic>;
        if (decoded.containsKey('to')) return decoded['to'] as String?;
        if (kind == 'message_received') return actorId;
        // If it's a legacy message_sent (migrated with 'from' but no 'to'), actorId is the recipient.
        if (kind == 'message_sent' && !decoded.containsKey('to')) {
          return actorId;
        }
      } catch (_) {}
    }
    return null;
  }

  String? get messageId {
    if (payload == null) return null;
    try {
      final decoded = jsonDecode(payload!) as Map<String, dynamic>;
      return decoded['messageId'] as String?;
    } catch (_) {
      return null;
    }
  }

  String? get messageSender {
    if (payload != null) {
      try {
        final decoded = jsonDecode(payload!) as Map<String, dynamic>;
        if (decoded.containsKey('from')) return decoded['from'] as String?;
      } catch (_) {}
    }
    return actorId;
  }

  String? get parentId {
    if (payload != null) {
      try {
        final decoded = jsonDecode(payload!) as Map<String, dynamic>;
        return (decoded['parentId'] ?? decoded['toParentId']) as String?;
      } catch (_) {}
    }
    return null;
  }

  String? get handleId {
    if (payload != null) {
      try {
        final decoded = jsonDecode(payload!) as Map<String, dynamic>;
        return decoded['handleId'] as String?;
      } catch (_) {}
    }
    return null;
  }
}

/// A page from `GET /api/mesh/events` (newest-first; `nextCursor` is an opaque
/// rowid to pass back as `before`, or null when exhausted).
class EventPage {
  const EventPage({required this.events, required this.nextCursor});

  final List<MeshEvent> events;
  final int? nextCursor;

  factory EventPage.fromJson(Map<String, dynamic> j) => EventPage(
    events: (j['events'] as List<dynamic>)
        .map((e) => MeshEvent.fromJson(e as Map<String, dynamic>))
        .toList(),
    nextCursor: j['nextCursor'] as int?,
  );
}

class MeshChat {
  const MeshChat({
    required this.id,
    required this.ts,
    required this.senderId,
    required this.recipientId,
    required this.body,
    required this.sessionId,
  });

  final String id;
  final DateTime ts;
  final String senderId;
  final String recipientId;
  final String body;
  final String? sessionId;

  factory MeshChat.fromJson(Map<String, dynamic> j) => MeshChat(
    id: j['id'] as String,
    ts: DateTime.parse(j['ts'] as String).toLocal(),
    senderId: j['senderId'] as String,
    recipientId: j['recipientId'] as String,
    body: j['body'] as String,
    sessionId: j['sessionId'] as String?,
  );
}

class ChatPage {
  const ChatPage({required this.chat, required this.nextCursor});

  final List<MeshChat> chat;
  final int? nextCursor;

  factory ChatPage.fromJson(Map<String, dynamic> j) => ChatPage(
    chat: (j['chat'] as List<dynamic>)
        .map((e) => MeshChat.fromJson(e as Map<String, dynamic>))
        .toList(),
    nextCursor: j['nextCursor'] as int?,
  );
}

/// One quota window from `GET /api/quota`.
class QuotaWindowDto {
  const QuotaWindowDto({
    required this.id,
    required this.label,
    required this.usedPercent,
    required this.status,
    required this.headline,
    this.resetAtIso,
    this.windowMs = 0,
    this.scrapedAt,
  });

  final String id;
  final String label;
  final double? usedPercent;
  final String status;
  final bool headline;

  /// Normalized absolute ISO-8601 instant for reset , when the
  /// backend's LLM parse could resolve or infer one.
  final String? resetAtIso;

  /// Fixed duration of this window in milliseconds (weekly = 7d, session/5h =
  /// 5h), or 0 when the server didn't send one (older payload / no reading).
  final int windowMs;

  /// ISO-8601 instant the underlying provider was actually scraped (ISSUE_NUM,
  /// ask 5) — ground truth for "as of HH:mm" in the tooltip, distinct from
  /// `QuotaSnapshotDto.generatedAt` (dashboard fetch time) or any client-side
  /// SWR revalidation time. Null when the state behind this window never
  /// reached a probe.
  final String? scrapedAt;

  bool get isKnown => usedPercent != null && status != 'unknown';

  /// Returns true if this window has an absolute reset instant that has already
  /// passed relative to [now]. When true, the pre-reset reading does not
  /// describe the current window and must not be presented as live quota.
  bool isPastReset(DateTime now) {
    final resetText = resetAtIso;
    if (resetText == null) return false;
    final reset = DateTime.tryParse(resetText);
    if (reset == null) return false;
    return now.isAfter(reset);
  }

  factory QuotaWindowDto.fromJson(Map<String, dynamic> j) => QuotaWindowDto(
    id: j['id'] as String? ?? '',
    label: j['label'] as String? ?? '',
    usedPercent: (j['usedPercent'] as num?)?.toDouble(),
    status: j['status'] as String? ?? 'unknown',
    headline: j['headline'] as bool? ?? false,
    resetAtIso: j['resetAtIso'] as String?,
    windowMs: (j['windowMs'] as num?)?.toInt() ?? 0,
    scrapedAt: j['scrapedAt'] as String?,
  );

  /// Inverse of [fromJson] — used to persist the last-known snapshot to
  /// localStorage (ISSUE_NUM ask 4). Every field, `scrapedAt` included, is emitted
  /// verbatim so a restored window reports the same as-of time it was scraped
  /// with; nothing is restamped on the way out (ISSUE_NUM ask 5).
  Map<String, dynamic> toJson() => {
    'id': id,
    'label': label,
    'usedPercent': usedPercent,
    'status': status,
    'headline': headline,
    'resetAtIso': resetAtIso,
    'windowMs': windowMs,
    'scrapedAt': scrapedAt,
  };
}

/// One quota window's contribution to the server-side closed-loop throttle.
class QuotaThrottleBucketDto {
  const QuotaThrottleBucketDto({
    required this.key,
    required this.error,
    required this.percentLeft,
    required this.timeRemainingPct,
  });

  final String key;
  final double error;
  final double percentLeft;
  final double timeRemainingPct;

  factory QuotaThrottleBucketDto.fromJson(Map<String, dynamic> j) =>
      QuotaThrottleBucketDto(
        key: j['key'] as String? ?? '',
        error: (j['error'] as num?)?.toDouble() ?? 0,
        percentLeft: (j['percentLeft'] as num?)?.toDouble() ?? 0,
        timeRemainingPct: (j['timeRemainingPct'] as num?)?.toDouble() ?? 0,
      );

  Map<String, dynamic> toJson() => {
    'key': key,
    'error': error,
    'percentLeft': percentLeft,
    'timeRemainingPct': timeRemainingPct,
  };
}

/// Latest adaptive start interval for one provider, when quota pacing is enabled.
class QuotaThrottleDto {
  const QuotaThrottleDto({
    required this.intervalSeconds,
    required this.expired,
    this.capped = false,
    required this.buckets,
    required this.updatedAt,
  });

  final double intervalSeconds;
  final bool expired;
  final bool capped;
  final List<QuotaThrottleBucketDto> buckets;
  final String updatedAt;

  factory QuotaThrottleDto.fromJson(Map<String, dynamic> j) => QuotaThrottleDto(
    intervalSeconds: (j['intervalSeconds'] as num?)?.toDouble() ?? 0,
    expired: j['expired'] as bool? ?? false,
    capped: j['capped'] as bool? ?? false,
    buckets: (j['buckets'] as List<dynamic>? ?? const [])
        .map((e) => QuotaThrottleBucketDto.fromJson(e as Map<String, dynamic>))
        .toList(),
    updatedAt: j['updatedAt'] as String? ?? '',
  );

  Map<String, dynamic> toJson() => {
    'intervalSeconds': intervalSeconds,
    'expired': expired,
    'capped': capped,
    'buckets': buckets.map((bucket) => bucket.toJson()).toList(),
    'updatedAt': updatedAt,
  };
}

/// Per-provider quota payload from the dashboard quota API.
class ProviderQuotaDto {
  const ProviderQuotaDto({
    required this.provider,
    required this.status,
    required this.usedPercent,
    required this.tier,
    required this.message,
    required this.windows,
    this.scrapedAt,
    this.throttle,
  });

  final String provider;
  final String status;
  final double? usedPercent;
  final String? tier;
  final String? message;
  final List<QuotaWindowDto> windows;

  /// Same `scrapedAt` pass-through as `QuotaWindowDto`, mirrored at the
  /// provider level (ISSUE_NUM, ask 5).
  final String? scrapedAt;

  /// Current closed-loop launch throttle, null when the feature is disabled.
  final QuotaThrottleDto? throttle;

  QuotaWindowDto? get headlineWindow {
    for (final w in windows) {
      if (w.headline) return w;
    }
    return null;
  }

  factory ProviderQuotaDto.fromJson(Map<String, dynamic> j) => ProviderQuotaDto(
    provider: j['provider'] as String? ?? '',
    status: j['status'] as String? ?? 'unknown',
    usedPercent: (j['usedPercent'] as num?)?.toDouble(),
    tier: j['tier'] as String?,
    message: j['message'] as String?,
    windows: (j['windows'] as List<dynamic>? ?? const [])
        .map((e) => QuotaWindowDto.fromJson(e as Map<String, dynamic>))
        .toList(),
    scrapedAt: j['scrapedAt'] as String?,
    throttle: j['throttle'] is Map<String, dynamic>
        ? QuotaThrottleDto.fromJson(j['throttle'] as Map<String, dynamic>)
        : null,
  );

  Map<String, dynamic> toJson() => {
    'provider': provider,
    'status': status,
    'usedPercent': usedPercent,
    'tier': tier,
    'message': message,
    'windows': windows.map((w) => w.toJson()).toList(),
    'scrapedAt': scrapedAt,
    'throttle': throttle?.toJson(),
  };
}

/// One durable remaining-quota reading from a real provider scrape.
class QuotaHistoryPointDto {
  const QuotaHistoryPointDto({
    required this.observedAt,
    required this.remainingPercent,
    this.error,
    this.resetAtIso,
    this.intervalSeconds,
  });

  final String observedAt;
  final double remainingPercent;
  final double? error;
  final String? resetAtIso;
  final double? intervalSeconds;

  factory QuotaHistoryPointDto.fromJson(Map<String, dynamic> j) =>
      QuotaHistoryPointDto(
        observedAt: j['observedAt'] as String? ?? '',
        remainingPercent: (j['remainingPercent'] as num?)?.toDouble() ?? 0,
        error: (j['error'] as num?)?.toDouble(),
        resetAtIso: j['resetAtIso'] as String?,
        intervalSeconds: (j['intervalSeconds'] as num?)?.toDouble(),
      );
}

/// The prior-3-day readings for one provider quota pool.
class QuotaHistorySeriesDto {
  const QuotaHistorySeriesDto({
    required this.provider,
    required this.windowId,
    required this.label,
    required this.points,
  });

  final String provider;
  final String windowId;
  final String label;
  final List<QuotaHistoryPointDto> points;

  factory QuotaHistorySeriesDto.fromJson(Map<String, dynamic> j) =>
      QuotaHistorySeriesDto(
        provider: j['provider'] as String? ?? '',
        windowId: j['windowId'] as String? ?? '',
        label: j['label'] as String? ?? '',
        points: (j['points'] as List<dynamic>? ?? const [])
            .map(
              (e) => QuotaHistoryPointDto.fromJson(e as Map<String, dynamic>),
            )
            .toList(),
      );
}

class QuotaSnapshotDto {
  const QuotaSnapshotDto({required this.generatedAt, required this.providers});

  final String generatedAt;
  final List<ProviderQuotaDto> providers;

  ProviderQuotaDto? provider(String id) {
    for (final p in providers) {
      if (p.provider == id) return p;
    }
    return null;
  }

  factory QuotaSnapshotDto.fromJson(Map<String, dynamic> j) => QuotaSnapshotDto(
    generatedAt: j['generatedAt'] as String? ?? '',
    providers: (j['providers'] as List<dynamic>? ?? const [])
        .map((e) => ProviderQuotaDto.fromJson(e as Map<String, dynamic>))
        .toList(),
  );

  /// Serialize the whole snapshot for localStorage persistence (ISSUE_NUM ask 4).
  /// `fromJson(toJson(x))` round-trips every field verbatim — the property the
  /// persistence path relies on to replay a stale-but-honest first paint.
  Map<String, dynamic> toJson() => {
    'generatedAt': generatedAt,
    'providers': providers.map((p) => p.toJson()).toList(),
  };
}

class QuotaHistoryDto {
  const QuotaHistoryDto({
    required this.generatedAt,
    required this.historySince,
    required this.history,
  });

  final String generatedAt;
  final String historySince;
  final List<QuotaHistorySeriesDto> history;

  factory QuotaHistoryDto.fromJson(Map<String, dynamic> j) => QuotaHistoryDto(
    generatedAt: j['generatedAt'] as String? ?? '',
    historySince: j['historySince'] as String? ?? '',
    history: (j['history'] as List<dynamic>? ?? const [])
        .map((e) => QuotaHistorySeriesDto.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

class QuotaProviderConfigDto {
  const QuotaProviderConfigDto({required this.primaryWindow});

  final String primaryWindow;

  factory QuotaProviderConfigDto.fromJson(Map<String, dynamic> j) =>
      QuotaProviderConfigDto(
        primaryWindow: j['primaryWindow'] as String? ?? 'weekly',
      );
}

class DashboardConfigDto {
  const DashboardConfigDto({required this.quotaProviders});

  final Map<String, QuotaProviderConfigDto> quotaProviders;

  factory DashboardConfigDto.fromJson(Map<String, dynamic> j) {
    final rawProviders =
        j['quotaProviders'] as Map<String, dynamic>? ?? const {};
    return DashboardConfigDto(
      quotaProviders: rawProviders.map(
        (key, value) => MapEntry(
          key,
          QuotaProviderConfigDto.fromJson(value as Map<String, dynamic>),
        ),
      ),
    );
  }
}

/// One rendered walkie-talkie reply , as pushed on the `voice` SSE
/// channel and listed by `GET /api/mesh/actors/:id/voice/backlog`. Mirrors
/// `VoiceAnnouncementFrame` in `src/voice/voice-service.ts` exactly.
class VoiceAnnouncement {
  const VoiceAnnouncement({
    required this.id,
    required this.actorId,
    required this.text,
    required this.audioUrl,
    required this.mime,
    required this.createdAt,
  });

  final String id;

  /// The actor whose reply this is (the walkie peer, not `human:operator`).
  final String actorId;

  /// The speakable text that was synthesized — shown large while playing.
  final String text;

  /// Server-relative audio route (`/api/mesh/voice/audio/<id>`).
  final String audioUrl;

  /// `audio/mpeg` or `audio/wav`.
  final String mime;
  final String createdAt;

  factory VoiceAnnouncement.fromJson(Map<String, dynamic> j) =>
      VoiceAnnouncement(
        id: j['id'] as String,
        actorId: j['actorId'] as String? ?? '',
        text: j['text'] as String? ?? '',
        audioUrl: j['audioUrl'] as String? ?? '',
        mime: j['mime'] as String? ?? 'audio/wav',
        createdAt: j['createdAt'] as String? ?? '',
      );
}

/// `POST /api/mesh/actors/:id/voice-memo` 200 response: the transcript that was
/// delivered into the chat, plus whether the actor was actually woken.
class VoiceMemoResult {
  const VoiceMemoResult({required this.transcript, required this.delivered});

  final String transcript;
  final bool delivered;

  factory VoiceMemoResult.fromJson(Map<String, dynamic> j) => VoiceMemoResult(
    transcript: j['transcript'] as String? ?? '',
    delivered: j['delivered'] as bool? ?? false,
  );
}

/// A live model-output chunk from the SSE `live_output` channel.
class LiveOutputChunk {
  const LiveOutputChunk({required this.actorId, required this.text});

  final String actorId;
  final String text;

  factory LiveOutputChunk.fromJson(Map<String, dynamic> j) => LiveOutputChunk(
    actorId: j['actorId'] as String? ?? '',
    text: j['text'] as String? ?? '',
  );
}

/// Longest an obligation heading may be. Mirrors `OBLIGATION_TITLE_MAX` on the
/// server, which rejects anything longer.
const int kObligationTitleMax = 200;

/// A reference resolved down to what the UI needs to show it, mirroring the
/// server's `ResolvedReference`.
///
/// One shape for every source so the obligation and inbox call sites can reuse
/// one rendering. In v1 only mesh chat actually resolves; anything else arrives
/// with [unavailable] set and is shown as a citation that cannot yet be
/// expanded, rather than as an empty one.
class ReferenceDto {
  const ReferenceDto({
    required this.ref,
    required this.scheme,
    required this.title,
    this.body,
    this.author,
    this.timestamp,
    this.url,
    this.unavailable,
    this.entity,
    this.cacheState,
  });

  final String ref;
  final String scheme;
  final String title;
  final String? body;
  final String? author;
  final String? timestamp;
  final String? url;
  final String? unavailable;
  final Map<String, dynamic>? entity;
  final String? cacheState;

  bool get isResolved => unavailable == null;

  factory ReferenceDto.fromJson(Map<String, dynamic> j) => ReferenceDto(
    ref: j['ref'] as String? ?? '',
    scheme: j['scheme'] as String? ?? '',
    title: j['title'] as String? ?? '',
    body: j['body'] as String?,
    author: j['author'] as String?,
    timestamp: j['timestamp'] as String?,
    url: j['url'] as String?,
    unavailable: j['unavailable'] as String?,
    entity: j['entity'] as Map<String, dynamic>?,
    cacheState: j['cacheState'] as String?,
  );
}

/// An artifact cited by an obligation, with its reference resolved when we can.
class ObligationArtifactDto {
  const ObligationArtifactDto({
    required this.ref,
    this.label,
    this.attachedBy,
    this.attachedAt,
    this.reference,
  });

  final String ref;
  final String? label;
  final String? attachedBy;
  final String? attachedAt;
  final ReferenceDto? reference;

  factory ObligationArtifactDto.fromJson(Map<String, dynamic> j) {
    final artifact = (j['artifact'] as Map<String, dynamic>?) ?? j;
    final resolved = j['reference'];
    return ObligationArtifactDto(
      ref: artifact['ref'] as String? ?? '',
      label: artifact['label'] as String?,
      attachedBy: artifact['attachedBy'] as String?,
      attachedAt: artifact['attachedAt'] as String?,
      reference: resolved is Map<String, dynamic>
          ? ReferenceDto.fromJson(resolved)
          : null,
    );
  }
}

class ObligationDto {
  const ObligationDto({
    required this.id,
    this.parentId,
    required this.ownerId,
    this.title,
    this.creatorId,
    this.createdAt,
    this.updatedAt,
    this.intent,
    this.externalRef,
    required this.status,
    this.priority,
    required this.effectivePriority,
    this.prioritySourceId,
    this.terminalNote,
    this.resolutionRef,
    this.recurrencePolicy,
    this.recurrenceCron,
    this.recurrenceIntervalSeconds,
    this.nextReadyAt,
    this.hasCompletionHistory = false,
  });

  final String id;
  final String? parentId;

  /// One entity id in the mesh's single id space: an actor UUID, `root`,
  /// `human:*`, or `system:*`. The category is read off the prefix — there is
  /// no separate owner "kind".
  final String ownerId;

  /// The heading — short, and what a queue shows. Null only for rows that
  /// predate the title/body split with no intent to derive one from.
  final String? title;

  /// Who raised this obligation; immutable across reassignment. Null means
  /// genuinely unknown (a row predating attribution), never inferred.
  final String? creatorId;
  final String? createdAt;
  final String? updatedAt;
  final String? intent;
  final String? externalRef;
  final String status; // "ready" | "waiting" | "done" | "cancelled" | "scheduled"
  final double? priority;
  final double effectivePriority;
  final String? prioritySourceId;

  /// Which attached artifact settled this obligation, as a `kind:value` ref.
  /// Distinct from [externalRef], which is an identity claim.
  final String? resolutionRef;

  /// Why this obligation was completed or cancelled, in the terminating
  /// principal's own words. Null while live, and null for a terminal
  /// obligation whose reason was never stated or predates the column.
  final String? terminalNote;

  /// `"cron"` | `"completion_interval"` | null. Null means this obligation
  /// never recurs — the three recurrence fields below are only meaningful
  /// together.
  final String? recurrencePolicy;

  /// The 5-field cron expression driving a `"cron"`-policy obligation. Null
  /// for `"completion_interval"` policy and for non-recurring obligations.
  final String? recurrenceCron;

  /// Seconds after completion before a `"completion_interval"`-policy
  /// obligation returns to ready. Null for `"cron"` policy and for
  /// non-recurring obligations.
  final int? recurrenceIntervalSeconds;

  /// When a `scheduled` obligation returns to ready. Null unless [status] is
  /// `scheduled`.
  final String? nextReadyAt;

  /// Whether the durable completion ledger contains at least one row, even if
  /// recurrence was later disabled. Exact counts live on the detail snapshot's
  /// completion-page metadata rather than every obligation projection.
  final bool hasCompletionHistory;

  /// What to show as the heading. Prefers [title]; falls back to [intent] so a
  /// row written before the split still reads, rather than rendering blank.
  String get heading {
    final t = title?.trim();
    if (t != null && t.isNotEmpty) return t;
    final i = intent?.trim();
    if (i == null || i.isEmpty) return 'Untitled Obligation';
    final firstLine = i.split('\n').first.trim();
    return firstLine.isEmpty ? 'Untitled Obligation' : firstLine;
  }

  /// The fuller statement, or null when there isn't one worth showing. A row
  /// written before the title/body split has an intent whose first line *is*
  /// the heading, so rendering both would echo it under itself.
  String? get body {
    final i = intent?.trim();
    if (i == null || i.isEmpty || i == heading) return null;
    return i;
  }

  bool get isReady => status == 'ready';
  bool get isWaiting => status == 'waiting';
  bool get isDone => status == 'done';
  bool get isCancelled => status == 'cancelled';
  bool get isScheduled => status == 'scheduled';
  bool get isTerminal => status == 'done' || status == 'cancelled';
  bool get isRecurring => recurrencePolicy != null;

  factory ObligationDto.fromJson(Map<String, dynamic> j) {
    // The server sends a parsed reference object; older rows and some fixtures
    // send the bare canonical string. Both reduce to the same `key`.
    final dynamic rawRef = j['externalRef'];
    final String? extRef = rawRef is Map
        ? rawRef['key'] as String?
        : rawRef as String?;

    return ObligationDto(
      id: j['id'] as String? ?? '',
      parentId: j['parentId'] as String?,
      ownerId: j['ownerId'] as String? ?? '',
      title: j['title'] as String?,
      creatorId: j['creatorId'] as String?,
      createdAt: j['createdAt'] as String?,
      updatedAt: j['updatedAt'] as String?,
      intent: j['intent'] as String?,
      externalRef: extRef,
      status: j['status'] as String? ?? 'ready',
      priority: (j['priority'] as num?)?.toDouble(),
      effectivePriority: (j['effectivePriority'] as num?)?.toDouble() ?? 0.0,
      prioritySourceId: j['prioritySourceId'] as String?,
      terminalNote: j['terminalNote'] as String?,
      resolutionRef: j['resolutionRef'] as String?,
      recurrencePolicy: j['recurrencePolicy'] as String?,
      recurrenceCron: j['recurrenceCron'] as String?,
      recurrenceIntervalSeconds: j['recurrenceIntervalSeconds'] as int?,
      nextReadyAt: j['nextReadyAt'] as String?,
      hasCompletionHistory: j['hasCompletionHistory'] as bool? ?? false,
    );
  }
}

class ObligationPage {
  const ObligationPage({
    required this.obligations,
    required this.total,
    required this.hasMore,
  });

  final List<ObligationDto> obligations;
  final int total;
  final bool hasMore;

  factory ObligationPage.fromJson(Map<String, dynamic> j) => ObligationPage(
    obligations: (j['obligations'] as List<dynamic>? ?? const [])
        .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
        .toList(),
    total: j['total'] as int? ?? 0,
    hasMore: j['hasMore'] as bool? ?? false,
  );
}

class ObligationTreeDto {
  const ObligationTreeDto({
    required this.obligation,
    required this.children,
    required this.blockingChildren,
  });

  final ObligationDto obligation;
  final List<ObligationTreeDto> children;
  final List<ObligationDto> blockingChildren;

  factory ObligationTreeDto.fromJson(Map<String, dynamic> j) =>
      ObligationTreeDto(
        obligation: ObligationDto.fromJson(
          j['obligation'] as Map<String, dynamic>,
        ),
        children: (j['children'] as List<dynamic>? ?? const [])
            .map((e) => ObligationTreeDto.fromJson(e as Map<String, dynamic>))
            .toList(),
        blockingChildren: (j['blockingChildren'] as List<dynamic>? ?? const [])
            .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class ObligationListPage {
  const ObligationListPage({
    required this.items,
    required this.total,
    required this.hasMore,
  });

  final List<ObligationDto> items;
  final int total;
  final bool hasMore;

  factory ObligationListPage.fromJson(Map<String, dynamic> j) =>
      ObligationListPage(
        items: (j['items'] as List<dynamic>? ?? const [])
            .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
            .toList(),
        total: j['total'] as int? ?? 0,
        hasMore: j['hasMore'] as bool? ?? false,
      );
}

/// One completed cycle of a recurring obligation, as returned in the
/// `completions` page of `GET /api/mesh/obligations/:id`.
class ObligationCompletionDto {
  const ObligationCompletionDto({
    required this.id,
    required this.obligationId,
    required this.sequence,
    required this.completedAt,
    this.note,
    this.resolutionRef,
    this.nextReadyAt,
  });

  final String id;
  final String obligationId;
  final int sequence;
  final String completedAt;
  final String? note;
  final String? resolutionRef;
  final String? nextReadyAt;

  factory ObligationCompletionDto.fromJson(Map<String, dynamic> j) =>
      ObligationCompletionDto(
        id: j['id'] as String? ?? '',
        obligationId: j['obligationId'] as String? ?? '',
        sequence: j['sequence'] as int? ?? 0,
        completedAt: j['completedAt'] as String? ?? '',
        note: j['note'] as String?,
        resolutionRef: j['resolutionRef'] as String?,
        nextReadyAt: j['nextReadyAt'] as String?,
      );
}

class ObligationDetailSnapshot {
  const ObligationDetailSnapshot({
    required this.obligation,
    this.parent,
    required this.children,
    required this.blockingChildren,
    this.artifacts = const [],
    this.completions = const [],
    this.completionsTotal = 0,
    this.completionsHasMore = false,
  });

  final ObligationDto obligation;
  final ObligationDto? parent;
  final List<ObligationDto> children;
  final List<ObligationDto> blockingChildren;
  final List<ObligationArtifactDto> artifacts;
  final List<ObligationCompletionDto> completions;
  final int completionsTotal;
  final bool completionsHasMore;

  factory ObligationDetailSnapshot.fromJson(
    Map<String, dynamic> j,
  ) => ObligationDetailSnapshot(
    obligation: ObligationDto.fromJson(j['obligation'] as Map<String, dynamic>),
    parent: j['parent'] == null
        ? null
        : ObligationDto.fromJson(j['parent'] as Map<String, dynamic>),
    children: (j['children'] is List)
        ? (j['children'] as List<dynamic>)
              .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
              .toList()
        : (j['children'] is Map<String, dynamic> &&
              j['children']['items'] is List)
        ? (j['children']['items'] as List<dynamic>)
              .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
              .toList()
        : const <ObligationDto>[],
    blockingChildren: (j['blockingChildren'] is List)
        ? (j['blockingChildren'] as List<dynamic>)
              .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
              .toList()
        : (j['blockingChildren'] is Map<String, dynamic> &&
              j['blockingChildren']['items'] is List)
        ? (j['blockingChildren']['items'] as List<dynamic>)
              .map((e) => ObligationDto.fromJson(e as Map<String, dynamic>))
              .toList()
        : const <ObligationDto>[],
    artifacts: (j['artifacts'] is List)
        ? (j['artifacts'] as List<dynamic>)
              .map(
                (e) =>
                    ObligationArtifactDto.fromJson(e as Map<String, dynamic>),
              )
              .toList()
        : const <ObligationArtifactDto>[],
    completions: (j['completions'] as List<dynamic>? ?? const [])
        .map((e) => ObligationCompletionDto.fromJson(e as Map<String, dynamic>))
        .toList(),
    completionsTotal: j['completionsTotal'] as int? ?? 0,
    completionsHasMore: j['completionsHasMore'] as bool? ?? false,
  );
}
