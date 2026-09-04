import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'models.dart';

/// REST client for the PR2 dashboard Data API. All paths are resolved against
/// the page origin (`Uri.base`), so the same build works on localhost and
/// behind `tailscale serve` (relative paths, no hard-coded host).
class DashboardApi {
  DashboardApi({http.Client? client, Uri? base})
    : _client = client ?? http.Client(),
      _base = base ?? Uri.base;

  final http.Client _client;
  final Uri _base;

  Uri _u(String path, [Map<String, String>? query]) => _base
      .resolve(path)
      .replace(queryParameters: query?.isEmpty ?? true ? null : query);

  Future<Map<String, dynamic>> _getJson(Uri uri) async {
    final res = await _client.get(uri, headers: {'Accept': 'application/json'});
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// `GET /api/mesh/threads` → all threads (active + retired) plus the mesh
  /// halt state, as one snapshot (no second fetch for the header).
  Future<ThreadsSnapshot> fetchThreads() async {
    return ThreadsSnapshot.fromJson(await _getJson(_u('/api/mesh/threads')));
  }

  /// `GET /api/mesh/threads/charter` → one actor's full charter.
  ///
  /// The thread list carries only a clipped preview, since it is the same field
  /// for every actor on every poll. The whole text is fetched here, for the one
  /// actor whose detail panel is open.
  Future<String> fetchCharter(String threadId) async {
    final json = await _getJson(
      _u('/api/mesh/threads/charter', {'id': threadId}),
    );
    return json['charter'] as String? ?? '';
  }

  Future<List<String>> fetchRootControlProviders() async {
    final json = await _getJson(_u('/api/mesh/control/options'));
    return (json['providers'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .toList();
  }

  Future<String> spawnRootChild({
    required String charter,
    String? title,
    String? provider,
    String? model,
  }) async {
    final uri = _u('/api/mesh/actors');
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'charter': charter,
        'title': ?title,
        'provider': ?provider,
        'model': ?model,
      }),
    );
    if (res.statusCode != 201) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    return (jsonDecode(res.body) as Map<String, dynamic>)['id'] as String;
  }

  /// `GET /api/quota` → cached per-provider provider quota snapshot.
  Future<QuotaSnapshotDto> fetchQuota() async {
    return QuotaSnapshotDto.fromJson(await _getJson(_u('/api/quota')));
  }

  /// `GET /api/quota/history` → durable quota history series payload.
  Future<QuotaHistoryDto> fetchQuotaHistory() async {
    return QuotaHistoryDto.fromJson(await _getJson(_u('/api/quota/history')));
  }

  /// `GET /api/dashboard/config` → frontend-only dashboard config.
  Future<DashboardConfigDto> fetchDashboardConfig() async {
    return DashboardConfigDto.fromJson(
      await _getJson(_u('/api/dashboard/config')),
    );
  }

  /// `GET /api/understanding/reports` → IU reports index.
  Future<Map<String, dynamic>> fetchIuReports() async {
    return await _getJson(_u('/api/understanding/reports'));
  }

  /// `GET /api/understanding/reports/content?run_id=...` → markdown content.
  Future<Map<String, dynamic>> fetchIuReportContent(String runId) async {
    return await _getJson(
      _u('/api/understanding/reports/content', {'run_id': runId}),
    );
  }

  /// `GET /api/mesh/events` — merged, newest-first, rowid-cursor paginated.
  Future<EventPage> fetchEvents({
    List<String>? actors,
    String? since,
    List<String>? kinds,
    int? before,
    int limit = 50,
    bool conversation = false,
    String? order,
  }) async {
    if ((actors == null || actors.isEmpty) && since == null) {
      return const EventPage(events: [], nextCursor: null);
    }
    final q = <String, String>{
      if (actors != null && actors.isNotEmpty) 'actors': actors.join(','),
      'since':? since,
      'limit': '$limit',
      if (kinds != null && kinds.isNotEmpty) 'kinds': kinds.join(','),
      if (before != null) 'before': '$before',
      if (conversation) 'conversation': 'true',
      'order':? order,
    };
    return EventPage.fromJson(await _getJson(_u('/api/mesh/events', q)));
  }

  /// `GET /api/mesh/chat` — direct chat history, newest-first, rowid-cursor paginated.
  Future<ChatPage> fetchChat({
    required List<String> actors,
    int? before,
    int limit = 50,
  }) async {
    if (actors.isEmpty) return const ChatPage(chat: [], nextCursor: null);
    final q = <String, String>{
      'actors': actors.join(','),
      'limit': '$limit',
      if (before != null) 'before': '$before',
    };
    return ChatPage.fromJson(await _getJson(_u('/api/mesh/chat', q)));
  }

  /// `GET /api/mesh/inbox?actor=` — durable inbox entries for one actor.
  Future<Map<String, dynamic>> fetchInbox(
    String actorId, {
    String status = 'all',
    int limit = 20,
  }) =>
      _getJson(_u('/api/mesh/inbox', {
        'actor': actorId,
        'status': status,
        'limit': '$limit',
      }));

  /// `POST /api/mesh/actors/:actorId/inbox/handled` — clear one inbox entry
  /// the actor should not have to answer. `reason` is the operator's own
  /// words; the server always records who cleared it, reason or not.
  Future<void> markInboxHandled(
    String actorId,
    String entryId, {
    String? reason,
  }) async {
    final uri = _u('/api/mesh/actors/$actorId/inbox/handled');
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'entryId': entryId, 'reason': ?reason}),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  /// `POST /api/mesh/actors/:actorId/chat` — send a chat message to an actor.
  Future<void> sendChatMessage(
    String actorId,
    String body, {
    String? sessionId,
  }) async {
    final uri = _u('/api/mesh/actors/$actorId/chat');
    final payload = {'body': body, 'sessionId': ?sessionId};
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(payload),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  /// `POST /api/mesh/actors/:actorId/interrupt` — interrupt a running actor .
  Future<void> interruptActor(
    String actorId, {
    String by = 'human:operator',
  }) async {
    final uri = _u('/api/mesh/actors/$actorId/interrupt');
    final payload = {'by': by};
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(payload),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  /// `POST /api/mesh/actors/:actorId/run-now` — bypass queue and quota throttling for an actor.
  Future<void> runNowActor(String actorId) async {
    final uri = _u('/api/mesh/actors/$actorId/run-now');
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({}),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  /// `POST /api/mesh/avatar/<id>` — manual avatar upload . `imageBase64`
  /// must already be base64-encoded (the caller reads the picked file's raw
  /// bytes and encodes client-side); `contentType` must be `image/png` — the
  /// server's cache/serve path is PNG-only and verifies the PNG signature on
  /// the decoded bytes too.
  Future<void> uploadAvatar(
    String id,
    String imageBase64,
    String contentType,
  ) async {
    final uri = _u('/api/mesh/avatar/$id');
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'imageBase64': imageBase64, 'contentType': contentType}),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  /// `POST /api/mesh/avatar/<id>/generate` — on-demand AI avatar generation
  /// . Throws [DashboardApiException] on any non-200: 400 for root or
  /// a missing `geminiApiKey`, 502 if the Gemini call itself fails, 503 if
  /// root control is unavailable.
  Future<void> generateAvatar(String id) async {
    final uri = _u('/api/mesh/avatar/$id/generate');
    final res = await _client.post(
      uri,
      headers: {'Accept': 'application/json'},
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  // ── Walkie-talkie voice routes (ISSUE_NUM, `src/voice/voice-api.ts`) ──

  /// `POST /api/mesh/actors/:id/voice-memo` — raw audio bytes in, transcript
  /// (delivered into the chat server-side) out. Throws [DashboardApiException]
  /// on any non-200: 400 retired/non-audio, 404 unknown actor, 502 transcription
  /// failure (`audioSaved: true` — the raw memo survived), 503 voice
  /// unconfigured on this instance.
  Future<VoiceMemoResult> sendVoiceMemo(
    String actorId,
    Uint8List audio, {
    required String mimeType,
    String? sessionId,
  }) async {
    final uri = _u('/api/mesh/actors/$actorId/voice-memo', {
      'sessionId': ?sessionId,
    });
    final res = await _client.post(
      uri,
      headers: {'Accept': 'application/json', 'Content-Type': mimeType},
      body: audio,
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    return VoiceMemoResult.fromJson(
      jsonDecode(res.body) as Map<String, dynamic>,
    );
  }

  /// `GET /api/mesh/actors/:id/voice/backlog` — unplayed announcements for the
  /// actor, oldest first. 503 when voice is unconfigured (the availability
  /// probe leans on this).
  Future<List<VoiceAnnouncement>> fetchVoiceBacklog(String actorId) async {
    final j = await _getJson(_u('/api/mesh/actors/$actorId/voice/backlog'));
    return (j['announcements'] as List<dynamic>? ?? const [])
        .map((e) => VoiceAnnouncement.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// `POST /api/mesh/voice/ack` — mark an announcement played (sent after it
  /// finishes playing, or is manually skipped).
  Future<void> ackVoiceAnnouncement(String id) async {
    final uri = _u('/api/mesh/voice/ack');
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'id': id}),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
  }

  // ── Obligations read routes ──

  Future<ObligationPage> fetchObligations({
    String? ownerId,
    String? status,
    bool? rootsOnly,
    int? limit,
    int? offset,
  }) async {
    final q = <String, String>{
      'ownerId':? ownerId,
      'status':? status,
      if (rootsOnly != null) 'rootsOnly': '$rootsOnly',
      if (limit != null) 'limit': '$limit',
      if (offset != null) 'offset': '$offset',
    };
    return ObligationPage.fromJson(
      await _getJson(_u('/api/mesh/obligations', q)),
    );
  }

  Future<ObligationDetailSnapshot> fetchObligationDetail(
    String id, {
    int? childrenOffset,
    int? blockingOffset,
    int? completionsOffset,
    int? limit,
  }) async {
    final q = <String, String>{
      if (childrenOffset != null) 'children_offset': '$childrenOffset',
      if (blockingOffset != null) 'blocking_offset': '$blockingOffset',
      if (completionsOffset != null) 'completions_offset': '$completionsOffset',
      if (limit != null) 'limit': '$limit',
    };
    return ObligationDetailSnapshot.fromJson(
      await _getJson(_u('/api/mesh/obligations/$id', q)),
    );
  }

  Future<ObligationTreeDto> fetchObligationTree(String id) async {
    return ObligationTreeDto.fromJson(
      await _getJson(_u('/api/mesh/obligations/$id/tree')),
    );
  }

  // ── Obligations write routes ──

  Future<ObligationDto> createObligation({
    required String ownerId,
    required String title,
    String? parentId,
    String? intent,
    String? externalRef,
    double? priority,
  }) async {
    final uri = _u('/api/mesh/obligations');
    final payload = {
      'ownerId': ownerId,
      'title': title,
      'parentId': ?parentId,
      'intent': ?intent,
      'externalRef': ?externalRef,
      'priority': ?priority,
    };
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(payload),
    );
    if (res.statusCode != 201) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return ObligationDto.fromJson(json['obligation'] as Map<String, dynamic>);
  }

  Future<ObligationDto> setObligationStatus(
    String id,
    String status, {
    String? note,
    String? resolutionRef,
  }) async {
    final uri = _u('/api/mesh/obligations/$id/status');
    final trimmed = note?.trim();
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'status': status,
        // Omitted rather than sent as '' so the server records "no reason
        // given" as null, matching the repository's own normalization.
        if (trimmed != null && trimmed.isNotEmpty) 'note': trimmed,
        if (resolutionRef != null && resolutionRef.trim().isNotEmpty)
          'resolutionRef': resolutionRef.trim(),
      }),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return ObligationDto.fromJson(json['obligation'] as Map<String, dynamic>);
  }

  /// `POST /api/mesh/obligations/:id/external-ref` — link, relink or unlink the
  /// issue/PR/repo this obligation *is*. A null or blank [ref] unlinks.
  Future<ObligationDto> setObligationExternalRef(String id, String? ref) async {
    final uri = _u('/api/mesh/obligations/$id/external-ref');
    final trimmed = ref?.trim();
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'externalRef': (trimmed == null || trimmed.isEmpty) ? null : trimmed}),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return ObligationDto.fromJson(json['obligation'] as Map<String, dynamic>);
  }

  Future<ObligationDto> reorderObligation(
    String id, {
    String? previousId,
    String? nextId,
    String scope = 'subtree',
  }) async {
    final uri = _u('/api/mesh/obligations/$id/reorder');
    final payload = {
      'previousId': ?previousId,
      'nextId': ?nextId,
      'scope': scope,
    };
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(payload),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return ObligationDto.fromJson(json['obligation'] as Map<String, dynamic>);
  }

  Future<ObligationDto> reparentObligation(String id, {String? parentId}) async {
    final uri = _u('/api/mesh/obligations/$id/reparent');
    final payload = {
      'parentId': ?parentId,
    };
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(payload),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return ObligationDto.fromJson(json['obligation'] as Map<String, dynamic>);
  }

  Future<ObligationDto> reassignObligation(
    String id, {
    required String ownerId,
  }) async {
    final uri = _u('/api/mesh/obligations/$id/reassign');
    final res = await _client.post(
      uri,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'ownerId': ownerId}),
    );
    if (res.statusCode != 200) {
      throw DashboardApiException(uri, res.statusCode, res.body);
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return ObligationDto.fromJson(json['obligation'] as Map<String, dynamic>);
  }

  void close() => _client.close();
}

class DashboardApiException implements Exception {
  DashboardApiException(this.uri, this.status, this.body);
  final Uri uri;
  final int status;
  final String body;
  @override
  String toString() => 'DashboardApiException($status for $uri): $body';
}
