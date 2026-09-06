import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_hierarchy_cache.dart';
import 'package:rusa_dashboard/models.dart';

import 'fakes.dart';

/// The persisted hierarchy (#273) is only safe if it survives a
/// `toJson` → JSON string → `fromJson` round-trip *and* refuses to hand back
/// anything a stale blob shouldn't be able to claim. These pin both at the
/// serialization boundary the browser `WebActorHierarchyCache` depends on,
/// without needing `package:web`.
///
/// The record is deliberately narrower than `ThreadDto`: it holds what an
/// actor row draws and nothing else, so the tests below pin the omissions as
/// firmly as the fields — a field the record doesn't carry must come back as
/// its default, never as a previous session's answer.
void main() {
  final now = DateTime.utc(2026, 3, 1, 12);

  PersistedActorHierarchy? roundTrip(PersistedActorHierarchy source) =>
      PersistedActorHierarchy.fromJson(jsonDecode(jsonEncode(source.toJson())));

  test('a capture round-trips every field the tree row draws', () {
    final threads = [
      makeThread('root', created: '2026-01-01T00:00:00Z'),
      makeThread(
        'child',
        parent: 'root',
        created: '2026-01-02T00:00:00Z',
        title: 'Persist actor hierarchy',
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        desiredModel: 'claude-sonnet-5',
        desiredProvider: 'claude',
        modelConfig: const [
          ProviderModelConfig(
            provider: 'claude',
            model: 'claude-opus-5',
            effort: 'high',
          ),
        ],
        desiredModelConfig: const [
          ProviderModelConfig(provider: 'claude', model: 'claude-sonnet-5'),
        ],
        charterPreview: 'a charter preview…',
        lastActiveAt: '2026-02-28T00:00:00Z',
      ),
    ];
    final restored = roundTrip(
      PersistedActorHierarchy.capture(
        scope: 'https://mesh.example',
        threads: threads,
        now: now,
      ),
    );

    expect(restored, isNotNull);
    expect(restored!.scope, 'https://mesh.example');
    expect(restored.threads.map((t) => t.id), ['root', 'child']);
    final child = restored.threads[1];
    expect(child.parentId, 'root');
    expect(child.title, 'Persist actor hierarchy');
    expect(child.handle, 'child-handle');
    expect(child.model, 'claude-opus-5');
    expect(child.effort, 'high');
    expect(child.desiredModel, 'claude-sonnet-5');
    expect(child.modelConfig, threads[1].modelConfig);
    expect(child.desiredModelConfig, threads[1].desiredModelConfig);
    expect(child.createdAt, '2026-01-02T00:00:00Z');
    expect(child.lastActiveAt, '2026-02-28T00:00:00Z');
  });

  test('detail-panel metadata is not persisted — a restored actor carries '
      'defaults there, not the previous session\'s answers', () {
    final live = ThreadDto(
      id: 'a',
      handle: 'a-handle',
      parentId: null,
      status: 'active',
      provider: 'claude',
      model: 'claude-opus-5',
      desiredProvider: 'openai',
      charterPreview: 'a charter that may have been rewritten since',
      createdAt: '2026-01-01T00:00:00Z',
      chatDisabled: true,
      waitingOn: 'operator',
      ownerExpectsRetirement: true,
      selectedObligation: const ObligationDto(
        id: 'o1',
        ownerId: 'a',
        title: 'ship it',
        status: 'active',
        effectivePriority: 1,
      ),
    );

    final restored = roundTrip(
      PersistedActorHierarchy.capture(scope: 's', threads: [live], now: now),
    )!.threads.single;

    expect(restored.model, 'claude-opus-5', reason: 'the row draws this');
    expect(restored.provider, isNull);
    expect(restored.desiredProvider, isNull);
    expect(restored.charterPreview, isEmpty);
    expect(restored.waitingOn, isNull);
    expect(restored.chatDisabled, isFalse);
    expect(restored.ownerExpectsRetirement, isNull);
    expect(restored.selectedObligation, isNull);
  });

  test('a staged effort clear survives, and "nothing staged" stays unstaged — '
      'the record keys desiredEffort on presence, not value', () {
    final staged = makeThread('a', effortChangePending: true);
    final unstaged = makeThread('b');
    expect(staged.effortChangePending, isTrue);
    expect(staged.desiredEffort, isNull);

    final restored = roundTrip(
      PersistedActorHierarchy.capture(
        scope: 's',
        threads: [staged, unstaged],
        now: now,
      ),
    )!;

    expect(restored.threads[0].effortChangePending, isTrue);
    expect(restored.threads[0].desiredEffort, isNull);
    expect(restored.threads[1].effortChangePending, isFalse);
    expect(restored.threads[1].desiredModelConfig, isNull);
  });

  test('per-run state is never written and never read back — a restored actor '
      'cannot claim it is running or queued', () {
    final live = [
      makeThread('busy', runState: RunState.running),
      makeThread(
        'waiting',
        runState: RunState.queued,
        queuePosition: 3,
        estimatedStartAt: '2026-03-01T13:00:00Z',
      ),
    ];
    final capture = PersistedActorHierarchy.capture(
      scope: 's',
      threads: live,
      now: now,
    );

    final encoded = capture.toJson()['threads'] as List;
    for (final raw in encoded.cast<Map<String, dynamic>>()) {
      expect(raw.containsKey('runState'), isFalse);
      expect(raw.containsKey('queuePosition'), isFalse);
      expect(raw.containsKey('estimatedStartAt'), isFalse);
    }

    for (final t in roundTrip(capture)!.threads) {
      expect(t.runState, RunState.unknown);
      expect(t.queuePosition, isNull);
      expect(t.estimatedStartAt, isNull);
    }
  });

  test(
    'a tampered payload that re-adds run state is still read as unknown',
    () {
      final payload = PersistedActorHierarchy.capture(
        scope: 's',
        threads: [makeThread('a')],
        now: now,
      ).toJson();
      (payload['threads'] as List).first['runState'] = 'running';
      (payload['threads'] as List).first['queuePosition'] = 1;

      final restored = PersistedActorHierarchy.fromJson(payload)!;
      expect(restored.threads.single.runState, RunState.unknown);
      expect(restored.threads.single.queuePosition, isNull);
    },
  );

  test('a capture is bounded by serialized bytes, keeping the newest actors '
      'and the ancestors that make them drawable', () {
    // Wide, not deep: one root with many children, each padded so a few
    // hundred of them overrun the budget. Ids ascend with createdAt.
    String id(int i) => 'a${i.toString().padLeft(4, '0')}';
    final threads = [
      makeThread('root', created: '2026-01-01T00:00:00Z'),
      for (var i = 0; i < 600; i++)
        makeThread(
          id(i),
          parent: 'root',
          title: 'x' * 2000,
          created: DateTime.utc(
            2026,
            1,
            2,
          ).add(Duration(minutes: i)).toIso8601String(),
        ),
    ];

    final capture = PersistedActorHierarchy.capture(
      scope: 's',
      threads: threads,
      now: now,
    );
    final ids = capture.threads.map((t) => t.id).toSet();

    expect(
      utf8.encode(jsonEncode(capture.toJson()['threads'])).length,
      lessThanOrEqualTo(PersistedActorHierarchy.maxSerializedBytes),
    );
    expect(ids, hasLength(lessThan(threads.length)));
    // Newest kept, oldest dropped — the reverse would drop exactly the actors
    // an operator just spawned and is waiting to see.
    expect(ids, contains(id(599)));
    expect(ids, isNot(contains(id(0))));
    // Ancestor-closed: the root rode along despite being the oldest actor,
    // because the tree walk descends from it.
    expect(ids, contains('root'));
    for (final t in capture.threads) {
      if (t.parentId != null) expect(ids, contains(t.parentId));
    }
    expect(roundTrip(capture)!.threads, hasLength(ids.length));
  });

  test('a payload larger than the budget is refused rather than restored', () {
    final oversized = {
      'version': PersistedActorHierarchy.schemaVersion,
      'scope': 's',
      'savedAt': '2026-03-01T12:00:00.000Z',
      'threads': [
        for (var i = 0; i < 4; i++)
          {
            'id': 'a$i',
            'handle': 'a$i-handle',
            'status': 'active',
            'createdAt': '2026-01-01T00:00:00Z',
            'title': 'x' * (PersistedActorHierarchy.maxSerializedBytes ~/ 2),
          },
      ],
    };

    expect(PersistedActorHierarchy.fromJson(oversized), isNull);
  });

  test('a payload from another schema version is dropped, not migrated', () {
    final payload = PersistedActorHierarchy.capture(
      scope: 's',
      threads: [makeThread('a')],
      now: now,
    ).toJson();
    payload['version'] = PersistedActorHierarchy.schemaVersion + 1;

    expect(PersistedActorHierarchy.fromJson(payload), isNull);
  });

  test('corrupt or foreign payloads decode to null rather than throwing', () {
    expect(PersistedActorHierarchy.fromJson(null), isNull);
    expect(PersistedActorHierarchy.fromJson('not json'), isNull);
    expect(PersistedActorHierarchy.fromJson(const []), isNull);
    expect(
      PersistedActorHierarchy.fromJson({
        'version': PersistedActorHierarchy.schemaVersion,
        'scope': 's',
        'savedAt': '2026-03-01T12:00:00.000Z',
        'threads': 'not-a-list',
      }),
      isNull,
    );
    // A thread missing a required field means the blob no longer matches the
    // record the dashboard speaks — the whole capture is discarded.
    expect(
      PersistedActorHierarchy.fromJson({
        'version': PersistedActorHierarchy.schemaVersion,
        'scope': 's',
        'savedAt': '2026-03-01T12:00:00.000Z',
        'threads': [
          {'id': 'a'},
        ],
      }),
      isNull,
    );
  });

  test('usability is scoped to one server and bounded in time', () {
    final capture = PersistedActorHierarchy.capture(
      scope: 'https://mesh.example',
      threads: [makeThread('a')],
      now: now,
    );

    expect(capture.isUsableAt(scope: 'https://mesh.example', now: now), isTrue);
    expect(
      capture.isUsableAt(scope: 'https://other.example', now: now),
      isFalse,
    );
    expect(
      capture.isUsableAt(
        scope: 'https://mesh.example',
        now: now.add(PersistedActorHierarchy.maxAge - const Duration(hours: 1)),
      ),
      isTrue,
    );
    expect(
      capture.isUsableAt(
        scope: 'https://mesh.example',
        now: now.add(PersistedActorHierarchy.maxAge + const Duration(hours: 1)),
      ),
      isFalse,
    );
    // A clock that jumped backwards must not make a future capture look fresh.
    expect(
      capture.isUsableAt(
        scope: 'https://mesh.example',
        now: now.subtract(const Duration(days: 1)),
      ),
      isFalse,
    );
    expect(
      PersistedActorHierarchy(
        scope: 'https://mesh.example',
        savedAt: 'not-a-timestamp',
        threads: const [],
      ).isUsableAt(scope: 'https://mesh.example', now: now),
      isFalse,
    );
  });

  test(
    'NoopActorHierarchyCache never persists — every load is a cold start',
    () {
      const cache = NoopActorHierarchyCache();
      cache.save(
        PersistedActorHierarchy.capture(
          scope: 's',
          threads: [makeThread('a')],
          now: now,
        ),
      );
      expect(cache.load(), isNull);
      cache.clear();
      expect(cache.load(), isNull);
    },
  );
}
