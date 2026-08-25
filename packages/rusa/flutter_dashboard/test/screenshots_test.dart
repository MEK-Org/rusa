// Screenshot harness (ISSUE_NUM item 1).
//
// A repeatable, headless way to render the real dashboard widgets to PNG with
// seeded fake actors — no live mesh, no API, no network. Run it with:
//
//   flutter test test/screenshots_test.dart
//
// and it writes PNGs under `flutter_dashboard/screenshots/`, which are committed
// and embedded in PRs so visual changes get before/after images. It is also the
// validation for the visual items (enlarged detail avatar, true-circle avatars,
// charter-in-its-own-tab, coalesced run rows).
//
// Rendering notes:
//  • Real fonts (Roboto + Material Icons) are loaded from the Flutter SDK cache
//    so text/icons are legible instead of the test renderer's placeholder boxes.
//  • Avatars are `Image.network`; an HttpOverrides shim serves a per-actor
//    portrait PNG (a non-square gradient) so the circular clip / BoxFit.cover
//    fill is demonstrated with real pixels.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(() async {
    await _loadFonts();
  });

  testWidgets(
    'renders the dashboard overview (tree + detail + coalesced events)',
    (tester) async {
      await tester.runAsync(() async {
        final ids = _seedIds();
        HttpOverrides.global = _FakeImageHttpOverrides(await _portraits(ids));
        addTearDown(() => HttpOverrides.global = null);

        final api = FakeApi()
          ..threadsResult = _seedThreads()
          ..eventPages = [EventPage(events: _seedEvents(), nextCursor: null)];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        // Select a worker so the detail panel shows the enlarged avatar + tabs.
        store.clickActor('11111111-1111-4111-8111-111111111111');

        await tester.binding.setSurfaceSize(const Size(1360, 840));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final key = GlobalKey();
        await tester.pumpWidget(_app(store, key));
        // Overview is the default landing view now; switch to Actors for the
        // master-detail + Info-tab captures below.
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await _settleImages(tester, _portraitUrls(ids));
        // Guard against a silently-missed nav tap (mirrors the mobile guard
        // below, ISSUE_NUM review) before capturing the master-detail shots.
        expect(find.byType(OverviewTab), findsNothing);
        expect(find.byType(ActorTree), findsOneWidget);

        await _capture(key, '$_outDir/dashboard_overview.png');

        // Second shot: the Info tab selected, showing the charter lives in its
        // own tab alongside the work-state detail.
        await tester.ensureVisible(find.text('Info'));
        await tester.tap(find.text('Info'));
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.text('Charter'), findsOneWidget);
        await _capture(key, '$_outDir/detail_info_tab.png');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders the mobile (~390px) master-detail list + detail ',
    (tester) async {
      await tester.runAsync(() async {
        final ids = _seedIds();
        HttpOverrides.global = _FakeImageHttpOverrides(await _portraits(ids));
        addTearDown(() => HttpOverrides.global = null);

        final api = FakeApi()
          ..threadsResult = _seedThreads()
          ..eventPages = [EventPage(events: _seedEvents(), nextCursor: null)];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        // A typical tall phone viewport (~390 logical px wide → narrow layout).
        await tester.binding.setSurfaceSize(const Size(390, 844));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final key = GlobalKey();
        await tester.pumpWidget(_mobileApp(store, key));
        // Overview is the default landing view now; switch to Actors for the
        // master-detail navigation captures below. At this width the header
        // nav is horizontally scrollable and "Actors" starts off-screen
        // (~x=389) — scroll it into view before tapping, else the tap
        // silently misses and both shots below would capture Overview while
        // still passing (ISSUE_NUM review).
        await tester.ensureVisible(find.text('Actors'));
        await tester.pump();
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await _settleImages(tester, _portraitUrls(ids));

        // 1) The full-width actor list (no actor selected → master view).
        // Assert the actor tree actually rendered — not still Overview — so
        // a missed nav tap fails loudly instead of silently capturing the
        // wrong screen.
        expect(find.byType(OverviewTab), findsNothing);
        expect(find.byType(ActorTree), findsOneWidget);
        await _capture(key, '$_outDir/mobile_list.png');

        // 2) Tap an actor → full-width detail view with the back bar.
        store.clickActor('11111111-1111-4111-8111-111111111111');
        await _settleImages(tester, _portraitUrls(ids));
        // Assert the actor detail panel — identified by the selected actor's
        // handle in its header — is what's rendered before capturing.
        expect(find.byType(DetailPanel), findsOneWidget);
        expect(find.text('cloudy-porpoise'), findsWidgets);
        await _capture(key, '$_outDir/mobile_detail.png');

        await store.dispose();
      });
    },
  );

  testWidgets('renders the avatar circle/size strip (26 / 52 / 91 px)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const id = '11111111-1111-4111-8111-111111111111';
      HttpOverrides.global = _FakeImageHttpOverrides(await _portraits([id]));
      addTearDown(() => HttpOverrides.global = null);

      await tester.binding.setSurfaceSize(const Size(560, 260));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: key,
              child: Center(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: const [
                    _LabeledAvatar(id: id, size: 26, label: 'tree · 26px'),
                    SizedBox(width: 40),
                    _LabeledAvatar(
                      id: id,
                      size: 52,
                      label: 'old detail · 52px',
                    ),
                    SizedBox(width: 40),
                    _LabeledAvatar(
                      id: id,
                      size: 91,
                      label: 'new detail · 91px',
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await _settleImages(tester, _portraitUrls([id]));
      await _capture(key, '$_outDir/avatar_circles.png');
    });
  });
}

// ── App composition ──────────────────────────────────────────────────────────

Widget _app(DashboardStore store, Key boundaryKey) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    // Render the real responsive body (wide → side-by-side at this surface
    // size) so the desktop shot matches the app, including the dark detail
    // background that DashboardBody paints itself.
    body: RepaintBoundary(
      key: boundaryKey,
      child: DashboardBody(store: store),
    ),
  ),
);

/// The real responsive body ([DashboardBody]) at a phone width, so the mobile
/// shots are the actual reflowed layout (full-width list → tap → detail).
Widget _mobileApp(DashboardStore store, Key boundaryKey) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    body: RepaintBoundary(
      key: boundaryKey,
      child: DashboardBody(store: store),
    ),
  ),
);

class _LabeledAvatar extends StatelessWidget {
  const _LabeledAvatar({
    required this.id,
    required this.size,
    required this.label,
  });
  final String id;
  final double size;
  final String label;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      ActorAvatar(id: id, size: size),
      const SizedBox(height: 10),
      Text(
        label,
        style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12),
      ),
    ],
  );
}

// ── Seed data ────────────────────────────────────────────────────────────────

List<String> _seedIds() => const [
  'root',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

List<ThreadDto> _seedThreads() => [
  _thread(
    'root',
    null,
    'active',
    RunState.running,
    '2026-06-26T09:00:00Z',
    handle: 'silicon-familiar',
    charter: 'the root actor',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  ),
  _thread(
    '11111111-1111-4111-8111-111111111111',
    'root',
    'active',
    RunState.running,
    '2026-06-26T09:01:00Z',
    handle: 'cloudy-porpoise',
    charter:
        'dashboard-refinements implementer: enlarge the detail avatar, fix the circular clip, coalesce run rows.',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  ),
  _thread(
    '22222222-2222-4222-8222-222222222222',
    'root',
    'active',
    RunState.idle,
    '2026-06-26T09:02:00Z',
    handle: 'burning-paca',
    charter: 'mesh-architecture elder',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  ),
  _thread(
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    'active',
    RunState.idle,
    '2026-06-26T09:03:00Z',
    handle: 'kinetic-deer',
    charter: 'screenshot sub-worker',
    provider: 'google',
    model: 'gemini-2.5-pro',
  ),
  _thread(
    '44444444-4444-4444-8444-444444444444',
    'root',
    'retired',
    RunState.idle,
    '2026-06-26T09:04:00Z',
    handle: 'misty-otter',
    charter: 'retired reviewer',
  ),
];

ThreadDto _thread(
  String id,
  String? parent,
  String status,
  RunState run,
  String created, {
  required String handle,
  required String charter,
  String? provider,
  String? model,
}) => ThreadDto(
  id: id,
  handle: handle,
  parentId: parent,
  status: status,
  provider: provider,
  requestedModel: model,
  model: model,
  boundModel: model,
  charter: charter,
  title: charter,
  createdAt: created,
  runState: run,
);

/// Newest-first events for the selected worker, including a run that both
/// yielded and ended (coalesced into one row) plus a standalone run_end.
List<MeshEvent> _seedEvents() {
  const actor = '11111111-1111-4111-8111-111111111111';
  return [
    makeEvent('e8', 'run_end', actor: actor, detail: 'exit 0'),
    _ev(
      'e7',
      'run_yielded',
      actor,
      detail: 'complete',
      body: 'PR opened with screenshots; ready for review.',
    ),
    makeEvent('e6', 'run_queued', actor: actor, detail: 'message from root'),
    makeEvent(
      'e5',
      'run_end',
      actor: actor,
      detail: 'exit 0',
    ), // auto-continued → standalone
    makeEvent(
      'e4',
      'run_continued',
      actor: actor,
      detail: 'auto-continuation 1/8',
    ),
    makeEvent(
      'e3',
      'message_sent',
      actor: actor,
      peer: 'root',
      detail: 'progress update',
    ),
    makeEvent('e2', 'run_queued', actor: actor, detail: 'spawned'),
    makeEvent('e1', 'actor_spawned', actor: actor, peer: 'root'),
  ];
}

MeshEvent _ev(
  String id,
  String kind,
  String actor, {
  String? detail,
  String? body,
}) => MeshEvent(
  id: id,
  ts: '2026-01-01T00:00:00Z',
  kind: kind,
  actorId: actor,
  detail: detail,
  body: body,
  success: null,
);

// ── Capture + image settling ────────────────────────────────────────────────

List<String> _portraitUrls(List<String> ids) => [
  for (final id in ids) Uri.base.resolve('/api/mesh/avatar/$id.png').toString(),
];

Future<void> _settleImages(WidgetTester tester, List<String> urls) async {
  await tester.pump();
  final ctx = tester.element(find.byType(MaterialApp));
  for (final url in urls) {
    await precacheImage(NetworkImage(url), ctx);
  }
  await tester.pump(const Duration(milliseconds: 80));
  await tester.pump(const Duration(milliseconds: 80));
}

Future<void> _capture(GlobalKey key, String path) async {
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: 2.0);
  final bytes = (await image.toByteData(
    format: ui.ImageByteFormat.png,
  ))!.buffer.asUint8List();
  final file = File(path)..createSync(recursive: true);
  file.writeAsBytesSync(bytes);
}

// ── Per-actor portrait PNGs (non-square, so cover-crop + circle is visible) ──

Future<Map<String, Uint8List>> _portraits(List<String> ids) async {
  final out = <String, Uint8List>{};
  for (var i = 0; i < ids.length; i++) {
    out[ids[i]] = await _portraitPng(i);
  }
  return out;
}

const _palette = [
  [Color(0xFFF59E0B), Color(0xFFEF4444)],
  [Color(0xFF38BDF8), Color(0xFF6366F1)],
  [Color(0xFF10B981), Color(0xFF0EA5E9)],
  [Color(0xFFA855F7), Color(0xFFEC4899)],
  [Color(0xFFF97316), Color(0xFFEAB308)],
];

Future<Uint8List> _portraitPng(int seed) async {
  const w = 120.0, h = 168.0; // portrait → BoxFit.cover must crop top/bottom
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, const Rect.fromLTWH(0, 0, w, h));
  final colors = _palette[seed % _palette.length];
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, const Offset(w, h), [
        colors[0],
        colors[1],
      ]),
  );
  // A motif touching the edges so a flat-sided clip would visibly shear it.
  canvas.drawCircle(
    const Offset(w * 0.5, h * 0.46),
    w * 0.34,
    Paint()..color = Colors.white.withValues(alpha: 0.9),
  );
  canvas.drawCircle(
    const Offset(w * 0.5, h * 0.46),
    w * 0.20,
    Paint()..color = colors[1].withValues(alpha: 0.85),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(w.toInt(), h.toInt());
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

// ── Fonts (from the Flutter SDK cache, derived from the test VM path) ────────

Future<void> _loadFonts() async {
  final dir = _materialFontsDir();
  if (dir == null) return; // best-effort: fall back to box glyphs
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    var any = false;
    for (final f in files) {
      final file = File('$dir/$f');
      if (file.existsSync()) {
        loader.addFont(
          Future.value(file.readAsBytesSync().buffer.asByteData()),
        );
        any = true;
      }
    }
    if (any) await loader.load();
  }

  const roboto = ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Bold.ttf'];
  // The app styles text with 'system-ui' (theme) and 'monospace' (kMonoStyle);
  // map both onto Roboto so they render with real glyphs.
  await load('Roboto', roboto);
  await load('system-ui', roboto);
  await load('monospace', roboto);
  await load('MaterialIcons', [
    'MaterialIcons-Regular.otf',
    'MaterialIcons-Regular.ttf',
  ]);
}

String? _materialFontsDir() {
  // …/flutter/bin/cache/dart-sdk/bin/dart  →  …/flutter/bin/cache/artifacts/material_fonts
  final exe = Platform.resolvedExecutable;
  const marker = '/bin/cache/';
  final idx = exe.indexOf(marker);
  if (idx < 0) return null;
  final root = exe.substring(0, idx);
  final dir = '$root/bin/cache/artifacts/material_fonts';
  return Directory(dir).existsSync() ? dir : null;
}

// ── Network-image shim: serve a per-actor portrait for any avatar URL ────────

class _FakeImageHttpOverrides extends HttpOverrides {
  _FakeImageHttpOverrides(this.byId);
  final Map<String, Uint8List> byId;
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _FakeHttpClient(byId);
}

class _FakeHttpClient implements HttpClient {
  _FakeHttpClient(this.byId);
  final Map<String, Uint8List> byId;
  @override
  bool autoUncompress = true;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    final name = url.pathSegments.isEmpty ? '' : url.pathSegments.last;
    final id = name.endsWith('.png')
        ? name.substring(0, name.length - 4)
        : name;
    final bytes = byId[id] ?? byId.values.first;
    return _FakeHttpClientRequest(bytes);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientRequest implements HttpClientRequest {
  _FakeHttpClientRequest(this.bytes);
  final Uint8List bytes;
  @override
  final HttpHeaders headers = _FakeHttpHeaders();
  @override
  Future<HttpClientResponse> close() async => _FakeHttpClientResponse(bytes);
  @override
  Future<HttpClientResponse> get done => close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientResponse implements HttpClientResponse {
  _FakeHttpClientResponse(this.bytes);
  final Uint8List bytes;
  @override
  int get statusCode => HttpStatus.ok;
  @override
  int get contentLength => bytes.length;
  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;
  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream<List<int>>.fromIterable([bytes]).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpHeaders implements HttpHeaders {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
