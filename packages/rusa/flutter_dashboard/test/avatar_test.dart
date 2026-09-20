import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';

import 'fakes.dart';

// In widget tests Image.network has no real transport, so the load fails and the
// errorBuilder fires — which is exactly the "not generated yet / unreachable"
// path the placeholder exists for. So these tests double as placeholder coverage.
// The fade test swaps in a fake transport through Flutter's own
// `debugNetworkImageHttpClientProvider` hook so the real NetworkImage path runs.

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

/// A 1×1 PNG, so the real codec decodes exactly one frame.
final List<int> _onePixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);

/// Serves [body] for every request, but only once [release] completes, so a
/// test can observe the pre-frame state before letting the image arrive.
class _FakeHttpClient implements HttpClient {
  _FakeHttpClient(this.body, this.release);

  final List<int> body;
  final Completer<void> release;
  int requests = 0;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    requests++;
    return _FakeHttpClientRequest(_FakeHttpClientResponse(body, release));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientRequest implements HttpClientRequest {
  _FakeHttpClientRequest(this.response);

  final HttpClientResponse response;

  @override
  Future<HttpClientResponse> close() async => response;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  _FakeHttpClientResponse(this.body, this.release);

  final List<int> body;
  final Completer<void> release;

  @override
  int get statusCode => HttpStatus.ok;

  @override
  int get contentLength => body.length;

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream<List<int>>.fromFuture(release.future.then((_) => body)).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

DashboardStore _storeWith(FakeStream stream) {
  final store = DashboardStore(
    api: FakeApi(),
    stream: stream,
    avatarFilePicker: FakeAvatarFilePicker(),
  );
  addTearDown(store.dispose);
  return store;
}

void main() {
  testWidgets(
    'renders a circular avatar and falls back to the silhouette placeholder',
    (tester) async {
      await tester.runAsync(() async {
        await tester.pumpWidget(
          _wrap(
            const ActorAvatar(
              id: 'aaaaaaaa-0000-4000-8000-000000000001',
              size: 26,
            ),
          ),
        );
        // Let the (failing) network load resolve so the errorBuilder runs.
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(ActorAvatar), findsOneWidget);
        // Graceful placeholder: a neutral silhouette, never a broken-image glyph.
        expect(find.byIcon(Icons.pets), findsOneWidget);
        // A plain missing/cached load is not a generation: no ring.
        expect(find.byType(CircularProgressIndicator), findsNothing);

        // The container is masked to a circle (shape: circle).
        final decorated = tester.widget<Container>(
          find
              .descendant(
                of: find.byType(ActorAvatar),
                matching: find.byType(Container),
              )
              .first,
        );
        expect((decorated.decoration as BoxDecoration).shape, BoxShape.circle);
      });
    },
  );

  testWidgets(
    'shows the progress ring over the fallback only while the server reports generating',
    (tester) async {
      await tester.runAsync(() async {
        const id = 'eeeeeeee-0000-4000-8000-000000000007';
        final stream = FakeStream();
        final store = _storeWith(stream);
        await store.init();

        await tester.pumpWidget(
          _wrap(ActorAvatar(id: id, size: 26, store: store)),
        );
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.byIcon(Icons.pets), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);

        stream.avatarCtrl.add(
          const AvatarGenerationUpdate(
            actorId: id,
            state: AvatarGenerationState.generating,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.byIcon(Icons.pets), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(
          tester
              .widget<CircularProgressIndicator>(
                find.byType(CircularProgressIndicator),
              )
              .semanticsLabel,
          'Generating avatar',
        );

        // Another actor's generation is not this avatar's ring.
        stream.avatarCtrl.add(
          const AvatarGenerationUpdate(
            actorId: 'ffffffff-0000-4000-8000-000000000099',
            state: AvatarGenerationState.failed,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.byType(CircularProgressIndicator), findsOneWidget);

        // A failed attempt settles on the fallback: ring gone, URL unchanged
        // (no re-request), silhouette stays.
        stream.avatarCtrl.add(
          const AvatarGenerationUpdate(
            actorId: id,
            state: AvatarGenerationState.failed,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.byIcon(Icons.pets), findsOneWidget);
        expect(store.avatarVersion(id), 0);
      });
    },
  );

  testWidgets('fades the generated avatar in over the fallback once it is ready', (
    tester,
  ) async {
    const id = 'ffffffff-0000-4000-8000-000000000008';
    final release = Completer<void>();
    final client = _FakeHttpClient(_onePixelPng, release);
    // The binding asserts every painting debug variable is reset before the
    // test body returns, so this is restored in `finally`, not a tearDown.
    debugNetworkImageHttpClientProvider = () => client;
    try {
      await tester.runAsync(() async {
        final stream = FakeStream();
        final store = _storeWith(stream);
        await store.init();

        await tester.pumpWidget(
          _wrap(ActorAvatar(id: id, size: 26, store: store)),
        );
        await tester.pump();
        // The first request is the 404-and-start path; the store's `ready` frame
        // bumps this actor's version so a fresh URL is requested.
        stream.avatarCtrl.add(
          const AvatarGenerationUpdate(
            actorId: id,
            state: AvatarGenerationState.ready,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(store.avatarVersion(id), 1);
        expect(
          tester.widget<Image>(find.byType(Image)).image,
          isA<NetworkImage>().having((p) => p.url, 'url', contains('?v=1')),
        );

        // Bytes not delivered yet: fallback visible, image held at opacity 0.
        expect(find.byIcon(Icons.pets), findsOneWidget);
        var fade = tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity));
        expect(fade.opacity, 0);
        expect(fade.duration, const Duration(milliseconds: 200));

        release.complete();
        // Fetch and decode run on the real event loop inside runAsync, so give
        // them real time (pump alone only advances the fake clock).
        for (var i = 0; i < 100 && fade.opacity == 0; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
          fade = tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity));
        }
        // The decoded frame arrived and the opacity target flipped to fully
        // visible, animating over the still-present fallback.
        expect(fade.opacity, 1);
        expect(find.byIcon(Icons.pets), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
      });
    } finally {
      debugNetworkImageHttpClientProvider = null;
    }
  });

  testWidgets('retired avatar renders muted (wrapped in Opacity)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await tester.pumpWidget(
        _wrap(
          const ActorAvatar(
            id: 'bbbbbbbb-0000-4000-8000-000000000002',
            size: 26,
            retired: true,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      final opacities = tester.widgetList<Opacity>(
        find.descendant(
          of: find.byType(ActorAvatar),
          matching: find.byType(Opacity),
        ),
      );
      expect(opacities, isNotEmpty);
      expect(opacities.first.opacity, lessThan(1.0));
    });
  });

  testWidgets('tapping avatar opens lightbox modal and dismisses on Esc', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await tester.pumpWidget(
        _wrap(
          const ActorAvatar(
            id: 'cccccccc-0000-4000-8000-000000000003',
            size: 26,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(AvatarLightbox), findsNothing);

      // Tap avatar to open
      await tester.tap(find.byType(ActorAvatar));
      await tester.pumpAndSettle();

      expect(find.byType(AvatarLightbox), findsOneWidget);

      // Press Escape to dismiss
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();

      expect(find.byType(AvatarLightbox), findsNothing);
    });
  });

  testWidgets(
    'tapping avatar opens lightbox modal and dismisses on backdrop tap',
    (tester) async {
      await tester.runAsync(() async {
        await tester.pumpWidget(
          _wrap(
            const ActorAvatar(
              id: 'dddddddd-0000-4000-8000-000000000004',
              size: 26,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(AvatarLightbox), findsNothing);

        // Tap avatar to open
        await tester.tap(find.byType(ActorAvatar));
        await tester.pumpAndSettle();

        expect(find.byType(AvatarLightbox), findsOneWidget);

        // Tap the backdrop area (top-left padding region)
        await tester.tapAt(const Offset(5, 5));
        await tester.pumpAndSettle();

        expect(find.byType(AvatarLightbox), findsNothing);
      });
    },
  );

  // ── Upload UI  ──

  testWidgets('lightbox shows an upload button when a store is provided', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi();
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        avatarFilePicker: FakeAvatarFilePicker(),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(
        _wrap(
          ActorAvatar(
            id: 'eeeeeeee-0000-4000-8000-000000000005',
            size: 26,
            store: store,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.byType(ActorAvatar));
      await tester.pumpAndSettle();

      expect(find.byType(AvatarLightbox), findsOneWidget);
      expect(find.text('Upload image'), findsOneWidget);
    });
  });

  testWidgets('lightbox hides the upload button when no store is provided', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await tester.pumpWidget(
        _wrap(
          const ActorAvatar(
            id: 'ffffffff-0000-4000-8000-000000000006',
            size: 26,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.byType(ActorAvatar));
      await tester.pumpAndSettle();

      expect(find.byType(AvatarLightbox), findsOneWidget);
      expect(find.text('Upload image'), findsNothing);
    });
  });

  testWidgets(
    'lightbox shows the upload button for the root avatar when a store is provided',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          avatarFilePicker: FakeAvatarFilePicker(),
        );
        addTearDown(store.dispose);

        await tester.pumpWidget(
          _wrap(ActorAvatar(id: 'root', size: 26, store: store)),
        );
        await tester.pump(const Duration(milliseconds: 50));
        await tester.tap(find.byType(ActorAvatar));
        await tester.pumpAndSettle();

        expect(find.byType(AvatarLightbox), findsOneWidget);
        expect(find.text('Upload image'), findsOneWidget);
      });
    },
  );

  testWidgets(
    'tapping upload picks and uploads a file, bumping the avatar epoch',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi();
        final picker = FakeAvatarFilePicker();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          avatarFilePicker: picker,
        );
        addTearDown(store.dispose);

        await tester.pumpWidget(
          _wrap(
            ActorAvatar(
              id: 'gggggggg-0000-4000-8000-000000000007',
              size: 26,
              store: store,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));
        await tester.tap(find.byType(ActorAvatar));
        await tester.pumpAndSettle();

        expect(store.avatarEpoch.value, 0);
        await tester.tap(find.text('Upload image'));
        await tester.pumpAndSettle();

        expect(picker.pickCalls, 1);
        expect(api.uploadCalls, hasLength(1));
        expect(
          api.uploadCalls.single.id,
          'gggggggg-0000-4000-8000-000000000007',
        );
        expect(api.uploadCalls.single.contentType, 'image/png');
        expect(store.avatarEpoch.value, 1);
      });
    },
  );

  // ── Generate UI  ──

  testWidgets('lightbox shows a generate button when a store is provided', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi();
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        avatarFilePicker: FakeAvatarFilePicker(),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(
        _wrap(
          ActorAvatar(
            id: 'hhhhhhhh-0000-4000-8000-000000000008',
            size: 26,
            store: store,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.byType(ActorAvatar));
      await tester.pumpAndSettle();

      expect(find.byType(AvatarLightbox), findsOneWidget);
      expect(find.text('Generate'), findsOneWidget);
    });
  });

  testWidgets('lightbox hides the generate button when no store is provided', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await tester.pumpWidget(
        _wrap(
          const ActorAvatar(
            id: 'iiiiiiii-0000-4000-8000-000000000009',
            size: 26,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.byType(ActorAvatar));
      await tester.pumpAndSettle();

      expect(find.byType(AvatarLightbox), findsOneWidget);
      expect(find.text('Generate'), findsNothing);
    });
  });

  testWidgets(
    'lightbox shows the generate button for the root avatar when a store is provided',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          avatarFilePicker: FakeAvatarFilePicker(),
        );
        addTearDown(store.dispose);

        await tester.pumpWidget(
          _wrap(ActorAvatar(id: 'root', size: 26, store: store)),
        );
        await tester.pump(const Duration(milliseconds: 50));
        await tester.tap(find.byType(ActorAvatar));
        await tester.pumpAndSettle();

        expect(find.byType(AvatarLightbox), findsOneWidget);
        expect(find.text('Generate'), findsOneWidget);
      });
    },
  );

  testWidgets(
    'tapping generate requests generation and bumps the avatar epoch',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          avatarFilePicker: FakeAvatarFilePicker(),
        );
        addTearDown(store.dispose);

        await tester.pumpWidget(
          _wrap(
            ActorAvatar(
              id: 'jjjjjjjj-0000-4000-8000-000000000010',
              size: 26,
              store: store,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));
        await tester.tap(find.byType(ActorAvatar));
        await tester.pumpAndSettle();

        expect(store.avatarEpoch.value, 0);
        await tester.tap(find.text('Generate'));
        await tester.pumpAndSettle();

        expect(api.generateCalls, ['jjjjjjjj-0000-4000-8000-000000000010']);
        expect(store.avatarEpoch.value, 1);
      });
    },
  );

  testWidgets(
    'a failed generate surfaces via the shared error stream and resets the button',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..generateError = DashboardApiException(
            Uri.parse('http://localhost/api/mesh/avatar/x/generate'),
            400,
            'Set geminiApiKey in config to enable avatar generation',
          );
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          avatarFilePicker: FakeAvatarFilePicker(),
        );
        addTearDown(store.dispose);

        String? lastError;
        store.error.listen((e) => lastError = e);

        await tester.pumpWidget(
          _wrap(
            ActorAvatar(
              id: 'kkkkkkkk-0000-4000-8000-000000000011',
              size: 26,
              store: store,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));
        await tester.tap(find.byType(ActorAvatar));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Generate'));
        await tester.pumpAndSettle();

        expect(lastError, contains('geminiApiKey'));
        expect(store.avatarEpoch.value, 0);
        expect(find.text('Generate'), findsOneWidget);
      });
    },
  );
}
