import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

// Op is re-exported by goals_core/sync.dart, so we don't take a direct goals_types dep.
import 'package:goals_core/sync.dart' show LoadOpsResp, Op, PersistenceService;
import 'package:http/http.dart' as http;

/// A **read-only** [PersistenceService] for the IU calibration view (ISSUE_NUM 2b).
///
/// It sources the distiller's **LOCAL would-be-graph** ops from the rusa op-getter
/// endpoint (`GET /api/understanding/ops?cursor=&limit=` → `{ops, nextCursor}`) — NOT the
/// live IU graph. A goals-core `SyncClient` sits on top, rebuilds the graph in the browser,
/// and renders it via `FlattenedGoalTree`, so Operator can review un-flushed distiller work
/// before any flushToRemote.
///
/// Like the in-memory `PersistenceService`, it extracts each op's entry text into a strings
/// map on load so [loadString] can hydrate node bodies (the `SyncClient` fetches text-goal
/// bodies via `loadString`, not inline). It NEVER writes: [save] throws.
class OpGetterPersistenceService implements PersistenceService {
  OpGetterPersistenceService({this.baseUrl = '', http.Client? client})
    : _client = client ?? http.Client();

  /// Origin for the endpoint; '' = same-origin (the dashboard serves both).
  final String baseUrl;
  final http.Client _client;

  /// Resolved entry-id → body-text cache. Seeded on [load] from ops that carry their text
  /// INLINE (the distiller's own writes); externalized baseline bodies are filled lazily by
  /// [loadString] via the `/api/understanding/strings` endpoint.
  final Map<String, String> _strings = {};

  /// Entry ids whose body text wasn't inline and are awaiting the next batched fetch.
  final Set<String> _pendingStringIds = {};

  /// The in-flight coalesced strings fetch, or null when none is scheduled. The `SyncClient`
  /// calls [loadString] once per text entry during a render; coalescing turns that burst into
  /// a single `/api/understanding/strings?ids=…` request (no N+1).
  Future<void>? _stringBatch;

  /// Running count of ops that failed to deserialize and were skipped. The live op stream
  /// can emit shapes the pinned glass_goals op model doesn't map; rather than let one bad op
  /// blank the entire tree, we skip it and surface the count here for the view.
  int skippedOps = 0;

  /// The canonical root node id the op-getter reports (`config.glassGoals.rootNodeId`).
  /// The view anchors the tree to this root's children (hiding the root itself). Null when
  /// unconfigured → the view falls back to rendering all top-level roots.
  String? rootNodeId;

  @override
  Future<LoadOpsResp> load({String? cursor, int? limit}) async {
    final qp = <String, String>{};
    if (cursor != null) qp['cursor'] = cursor;
    if (limit != null) qp['limit'] = '$limit';
    final uri = Uri.parse(
      '$baseUrl/api/understanding/ops',
    ).replace(queryParameters: qp.isEmpty ? null : qp);
    final resp = await _client.get(uri);
    if (resp.statusCode != 200) {
      throw Exception('op-getter returned ${resp.statusCode}: ${resp.body}');
    }
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    final rid = body['rootNodeId'];
    if (rid is String) {
      rootNodeId = rid; // every page carries it; the first sets it
    }
    final rawOps = (body['ops'] as List<dynamic>?) ?? const [];
    final ops = <Op>[];
    for (final raw in rawOps) {
      final map = raw as Map<String, dynamic>;
      try {
        final op = Op.fromJsonMap(map);
        ops.add(op);
        final extracted = Op.extractEntryTextField(map);
        if (extracted != null) {
          final (entryId, text) = extracted;
          _strings[entryId] = text;
        }
      } catch (e) {
        // Durable guard: one unmappable op must never blank the whole calibration view.
        // Skip it, keep paging, and count it so the view can warn the reviewer rather than
        // silently dropping data. (Schema drift between the live op stream and the pinned
        // glass_goals model is expected over time.)
        skippedOps++;
        developer.log(
          'IU calibration: skipped an unmappable op (${map['id'] ?? '?'}): $e',
          name: 'OpGetterPersistenceService',
        );
      }
    }
    return LoadOpsResp(ops: ops, cursor: body['nextCursor'] as String?);
  }

  /// Read-only snapshot: page through the op-getter once, emitting each page, then end.
  /// (No live updates — calibration review is over a fixed local would-be graph.)
  @override
  Stream<(Iterable<Op>, String)> stream(String? cursor) async* {
    String? c = cursor;
    while (true) {
      final resp = await load(cursor: c, limit: 500);
      if (resp.ops.isEmpty) break;
      final next = resp.cursor;
      yield (resp.ops, next ?? c ?? '');
      if (next == null || next == c) break;
      c = next;
    }
  }

  /// Resolve a log entry's body text. Inline text (distiller writes) is returned immediately
  /// from [_strings]; an externalized baseline body is fetched from the op-getter's strings
  /// endpoint — the glass_goals "separately-loaded strings" pattern. Concurrent misses within a
  /// turn coalesce into ONE batched request. Returns null if the string can't be resolved (the
  /// body renders blank, never throws).
  @override
  Future<String?> loadString(String entryId) async {
    final inline = _strings[entryId];
    if (inline != null) return inline;
    _pendingStringIds.add(entryId);
    _stringBatch ??= Future.microtask(_resolvePendingStrings);
    await _stringBatch;
    return _strings[entryId];
  }

  /// Fetch every queued externalized entry id in one request, merging results into [_strings].
  Future<void> _resolvePendingStrings() async {
    final ids = _pendingStringIds.toList();
    _pendingStringIds.clear();
    _stringBatch = null; // a miss after this point opens a fresh batch
    if (ids.isEmpty) return;
    try {
      final uri = Uri.parse(
        '$baseUrl/api/understanding/strings',
      ).replace(queryParameters: {'ids': ids.join(',')});
      final resp = await _client.get(uri);
      if (resp.statusCode != 200) {
        developer.log(
          'strings endpoint returned ${resp.statusCode}: ${resp.body}',
          name: 'OpGetterPersistenceService',
        );
        return;
      }
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      final strings = (body['strings'] as Map<String, dynamic>?) ?? const {};
      strings.forEach((k, v) {
        if (v is String) _strings[k] = v;
      });
    } catch (e) {
      // One failed strings batch must never throw out of a render — bodies just stay blank.
      developer.log(
        'strings fetch failed: $e',
        name: 'OpGetterPersistenceService',
      );
    }
  }

  @override
  Future<int> count({String? cursor}) async => _strings.length; // best-effort; unused by the view

  @override
  Future<void> save(Iterable<Op> ops) async {
    throw UnsupportedError(
      'IU calibration view is read-only — no remote write',
    );
  }
}
