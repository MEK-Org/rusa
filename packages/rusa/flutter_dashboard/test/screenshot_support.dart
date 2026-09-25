// Shared rendering helpers for headless screenshot harnesses.
//
// Real fonts (Roboto + Material Icons) are loaded from the Flutter SDK cache
// so text and icons are legible, and avatars (`Image.network`) are served by
// an HttpOverrides shim that returns a per-actor portrait PNG, because widget
// tests have no network transport.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';

// ── Capture + image settling ────────────────────────────────────────────────

List<String> portraitUrls(List<String> ids) => [
  for (final id in ids) Uri.base.resolve('/api/mesh/avatar/$id.png').toString(),
];

Future<void> settleImages(WidgetTester tester, List<String> urls) async {
  await tester.pump();
  final ctx = tester.element(find.byType(MaterialApp));
  for (final url in urls) {
    await precacheImage(NetworkImage(url), ctx);
  }
  await tester.pump(const Duration(milliseconds: 80));
  await tester.pump(const Duration(milliseconds: 80));
}

Future<void> captureBoundary(GlobalKey key, String path) async {
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

Future<Map<String, Uint8List>> portraits(List<String> ids) async {
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

Future<void> loadFonts() async {
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

class FakeImageHttpOverrides extends HttpOverrides {
  FakeImageHttpOverrides(this.byId);
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
