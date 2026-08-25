import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';

import 'fakes.dart';

// In widget tests Image.network has no real transport, so the load fails and the
// errorBuilder fires — which is exactly the "not generated yet / unreachable"
// path the placeholder exists for. So these tests double as placeholder coverage.

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

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
