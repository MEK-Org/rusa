import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';

import 'fakes.dart';

// Multi-model actors declare an ordered pool of provider/model/effort
// candidates; the server's flat provider/model/effort fields are only the
// first entry of it. These cover that the whole pool reaches the UI in order,
// and that a single-model actor still renders exactly as it did before.

Widget _harness(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: Row(
      children: [
        ActorTree(store: store),
        Expanded(child: DetailPanel(store: store)),
      ],
    ),
  ),
);

const _pool = [
  ProviderModelConfig(provider: 'claude', model: 'claude-opus-5'),
  ProviderModelConfig(provider: 'kimi', model: 'kimi-for-coding'),
  ProviderModelConfig(
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  ),
];

/// A whole-pool replacement whose *first* candidate differs from [_pool]'s —
/// the only shape the server's flat `desiredModel` can describe.
const _stagedTrio = [
  ProviderModelConfig(provider: 'claude', model: 'claude-sonnet-5'),
  ProviderModelConfig(provider: 'kimi', model: 'kimi-for-coding'),
  ProviderModelConfig(
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  ),
];

/// A replacement that keeps [_pool]'s first candidate and drops one below it,
/// so `desiredModel == model` while the pool is still wholly replaced.
const _stagedSameHead = [
  ProviderModelConfig(provider: 'claude', model: 'claude-opus-5'),
  ProviderModelConfig(
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  ),
];

/// Select the actor and swipe to its Info tab, where the pool is rendered.
Future<void> _openInfo(WidgetTester tester, String handle) async {
  await tester.tap(find.text(handle));
  await tester.pump(const Duration(milliseconds: 50));
  await tester.ensureVisible(find.text('Info'));
  await tester.tap(find.text('Info'));
  // Fixed pumps rather than pumpAndSettle: the dashboard's status pulse never
  // settles.
  for (int i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  group('ThreadDto.modelConfig', () {
    test('parses every candidate in configured order', () {
      final t = ThreadDto.fromJson({
        'id': 'a',
        'handle': 'a-handle',
        'parentId': null,
        'status': 'active',
        'provider': 'claude',
        'model': 'claude-opus-5',
        'effort': null,
        'modelConfig': [
          {'provider': 'claude', 'model': 'claude-opus-5'},
          {'provider': 'kimi', 'model': 'kimi-for-coding'},
          {'provider': 'codex', 'model': 'gpt-5.6-sol', 'effort': 'high'},
        ],
        'charterPreview': 'c',
        'createdAt': 't0',
      });

      expect(t.modelConfig, _pool);
      expect(t.modelConfig.map((e) => e.provider), [
        'claude',
        'kimi',
        'codex',
      ]);
      expect(t.modelConfig[2].effort, 'high');
      expect(t.modelConfig[0].effort, isNull);
      // Nothing staged is distinct from a staged empty pool.
      expect(t.desiredModelConfig, isNull);
    });

    test('parses a staged pool and tolerates an absent modelConfig', () {
      final t = ThreadDto.fromJson({
        'id': 'a',
        'handle': 'a-handle',
        'parentId': null,
        'status': 'active',
        'provider': null,
        'model': null,
        'desiredModelConfig': [
          {'provider': 'claude', 'model': 'claude-sonnet-5'},
        ],
        'charterPreview': 'c',
        'createdAt': 't0',
      });

      expect(t.modelConfig, isEmpty);
      expect(t.desiredModelConfig, [
        const ProviderModelConfig(provider: 'claude', model: 'claude-sonnet-5'),
      ]);
    });

    test('a malformed candidate fails the parse rather than fabricating one', () {
      // provider/model are required by the server contract, so a missing one
      // is API drift and should be as loud as a missing `id`.
      expect(
        () => ThreadDto.fromJson({
          'id': 'a',
          'handle': 'a-handle',
          'parentId': null,
          'status': 'active',
          'provider': 'claude',
          'model': 'claude-opus-5',
          'modelConfig': [
            {'provider': 'claude', 'model': 'claude-opus-5'},
            {'provider': 'kimi'},
          ],
          'charterPreview': 'c',
          'createdAt': 't0',
        }),
        throwsA(isA<TypeError>()),
      );
    });

    test('label omits the parts the server left out', () {
      expect(
        const ProviderModelConfig(
          provider: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        ).label,
        'codex · gpt-5.6-sol · effort high',
      );
      expect(
        const ProviderModelConfig(
          provider: 'claude',
          model: 'claude-opus-5',
        ).label,
        'claude · claude-opus-5',
      );
    });
  });

  testWidgets('detail panel lists every configured candidate in order', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            modelConfig: _pool,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));
      await _openInfo(tester, 'a-handle');

      expect(find.text('Configured models (3)'), findsOneWidget);
      expect(find.text('claude · claude-opus-5'), findsOneWidget);
      expect(find.text('kimi · kimi-for-coding'), findsOneWidget);
      expect(find.text('codex · gpt-5.6-sol · effort high'), findsOneWidget);

      // Configured order, top to bottom.
      final ys = [
        'claude · claude-opus-5',
        'kimi · kimi-for-coding',
        'codex · gpt-5.6-sol · effort high',
      ].map((t) => tester.getTopLeft(find.text(t)).dy).toList();
      expect(ys[0], lessThan(ys[1]));
      expect(ys[1], lessThan(ys[2]));

      // The first entry is never presented as the actor's one model.
      expect(find.textContaining('Model: ', findRichText: true), findsNothing);
      expect(
        find.textContaining('Provider: ', findRichText: true),
        findsNothing,
      );

      await store.dispose();
    });
  });

  testWidgets('detail panel shows a staged pool alongside the configured one', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            modelConfig: _pool,
            desiredModelConfig: const [
              ProviderModelConfig(provider: 'claude', model: 'claude-sonnet-5'),
              ProviderModelConfig(provider: 'kimi', model: 'kimi-for-coding'),
            ],
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));
      await _openInfo(tester, 'a-handle');

      expect(find.text('Configured models (3)'), findsOneWidget);
      expect(find.text('Staged for next run (2)'), findsOneWidget);
      expect(find.text('claude · claude-sonnet-5'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('a single-model actor keeps the plain model rows', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            effort: 'medium',
            modelConfig: const [
              ProviderModelConfig(
                provider: 'claude',
                model: 'claude-opus-5',
                effort: 'medium',
              ),
            ],
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Tree row is the bare model, with no pool count appended.
      expect(find.text('claude-opus-5'), findsOneWidget);
      expect(find.text('effort medium'), findsOneWidget);

      await _openInfo(tester, 'a-handle');

      expect(
        find.textContaining('Model: ', findRichText: true),
        findsOneWidget,
      );
      expect(find.textContaining('Configured models'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('tree row counts the remaining candidates', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            effort: 'medium',
            modelConfig: _pool,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('claude-opus-5 +2'), findsOneWidget);
      // Effort is per candidate in a pool, so the first entry's is not shown
      // as if it governed the actor.
      expect(find.text('effort medium'), findsNothing);
      expect(
        tester
            .widget<Tooltip>(find.ancestor(
              of: find.text('claude-opus-5 +2'),
              matching: find.byType(Tooltip),
            ))
            .message,
        'Configured candidates, in order:\n'
        '• claude · claude-opus-5\n'
        '• kimi · kimi-for-coding\n'
        '• codex · gpt-5.6-sol · effort high',
      );

      await store.dispose();
    });
  });

  testWidgets('tree row counts both sides of a staged pool replacement', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            desiredModel: 'claude-sonnet-5',
            modelConfig: _pool,
            desiredModelConfig: const [
              ProviderModelConfig(provider: 'claude', model: 'claude-sonnet-5'),
              ProviderModelConfig(provider: 'kimi', model: 'kimi-for-coding'),
            ],
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      expect(
        find.text('claude-opus-5 +2 → claude-sonnet-5 +1'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<Tooltip>(find.ancestor(
              of: find.text('claude-opus-5 +2 → claude-sonnet-5 +1'),
              matching: find.byType(Tooltip),
            ))
            .message,
        contains('Staged for next run:\n• claude · claude-sonnet-5'),
      );

      await store.dispose();
    });
  });

  // The two staged shapes the server's flat `desiredModel` cannot describe:
  // it is `desiredModelConfig[0].model`, so it is silent about a count change
  // and identical to `model` when the head candidate survives a replacement.
  testWidgets('one model staged to become a pool reads as a pool on both surfaces', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            effort: 'medium',
            desiredModel: 'claude-sonnet-5',
            modelConfig: const [
              ProviderModelConfig(
                provider: 'claude',
                model: 'claude-opus-5',
                effort: 'medium',
              ),
            ],
            desiredModelConfig: _stagedTrio,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // The staged side carries the count; the single current model has none.
      expect(find.text('claude-opus-5 → claude-sonnet-5 +2'), findsOneWidget);
      // The current effort is one candidate's of four about to be declared,
      // so it is not shown as if it governed the actor.
      expect(find.text('effort medium'), findsNothing);
      expect(
        tester
            .widget<Tooltip>(find.ancestor(
              of: find.text('claude-opus-5 → claude-sonnet-5 +2'),
              matching: find.byType(Tooltip),
            ))
            .message,
        'Configured candidates, in order:\n'
        '• claude · claude-opus-5 · effort medium\n'
        'Staged for next run:\n'
        '• claude · claude-sonnet-5\n'
        '• kimi · kimi-for-coding\n'
        '• codex · gpt-5.6-sol · effort high',
      );

      await _openInfo(tester, 'a-handle');

      expect(find.text('Configured models (1)'), findsOneWidget);
      expect(find.text('Staged for next run (3)'), findsOneWidget);
      expect(find.textContaining('Model: ', findRichText: true), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('a replacement keeping the first candidate still reads as staged', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            // Exactly what the server derives from `_stagedSameHead[0]`:
            // unchanged, and so no evidence of the replacement.
            desiredModel: 'claude-opus-5',
            modelConfig: _pool,
            desiredModelConfig: _stagedSameHead,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Same head candidate on both sides, different counts — the row shows
      // the staged side rather than collapsing to the configured pool alone.
      expect(
        find.text('claude-opus-5 +2 → claude-opus-5 +1'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<Tooltip>(find.ancestor(
              of: find.text('claude-opus-5 +2 → claude-opus-5 +1'),
              matching: find.byType(Tooltip),
            ))
            .message,
        contains(
          'Staged for next run:\n'
          '• claude · claude-opus-5\n'
          '• codex · gpt-5.6-sol · effort high',
        ),
      );

      await _openInfo(tester, 'a-handle');

      expect(find.text('Configured models (3)'), findsOneWidget);
      expect(find.text('Staged for next run (2)'), findsOneWidget);
      // The shared head candidate is listed under both pools, not deduped
      // into a single line that hides which pool declares it.
      expect(find.text('claude · claude-opus-5'), findsNWidgets(2));

      await store.dispose();
    });
  });

  testWidgets('the pool list stays readable at mobile width', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            provider: 'claude',
            model: 'claude-opus-5',
            modelConfig: _pool,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      // The phone layout is the detail panel alone, in compact mode, with the
      // actor already selected from the tree it replaced.
      store.clickActor('a');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: DetailPanel(store: store, narrow: true)),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      await tester.ensureVisible(find.text('Info'));
      await tester.tap(find.text('Info'));
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(tester.takeException(), isNull);
      expect(find.text('codex · gpt-5.6-sol · effort high'), findsOneWidget);

      await store.dispose();
    });
  });
}
