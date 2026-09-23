import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/obligations_cache.dart';

import 'fakes.dart';

void main() {
  final now = DateTime.utc(2026, 9, 22, 12, 0, 0);

  test('PersistedObligationsSnapshot survives toJson -> jsonEncode -> fromJson round-trip verbatim', () {
    final rootOb = makeObligation(
      'root-1',
      title: 'Title for root-1',
      intent: 'Full intent for root-1',
      status: 'active',
      priority: 1789962406449.0,
      effectivePriority: 1789962406449.0,
      prioritySourceId: 'root-1',
      creatorId: 'creator-uuid',
      terminalNote: 'terminal note for root-1',
      checkpoint: 'checkpoint text for root-1',
      checkpointAt: '2026-09-22T12:01:51.719Z',
      checkpointBy: 'actor-checkpoint-author',
      resolutionRef: 'mesh:messages/msg-123',
      recurrencePolicy: 'interval',
      recurrenceCron: '*/5 * * * *',
      recurrenceIntervalSeconds: 300,
      nextReadyAt: '2026-09-22T13:00:00.000Z',
      hasCompletionHistory: true,
      externalRef: 'github:MEK-Org/rusa/issues/505',
    );
    final childOb = makeObligation(
      'child-1',
      parentId: 'root-1',
      title: 'Child title',
    );
    final blockerOb = makeObligation(
      'blocker-1',
      title: 'Blocker title',
    );
    final tree = ObligationTreeDto(
      obligation: rootOb,
      children: [
        ObligationTreeDto(
          obligation: childOb,
          children: const [],
          blockingChildren: const [],
        ),
      ],
      blockingChildren: [blockerOb],
    );

    final snapshot = PersistedObligationsSnapshot.capture(
      scope: 'http://localhost:4040',
      principalId: 'user-principal-42',
      trees: [tree],
      now: now,
    );

    final encoded = jsonEncode(snapshot.toJson());
    final decoded = jsonDecode(encoded);
    final restored = PersistedObligationsSnapshot.fromJson(decoded);

    expect(restored, isNotNull);
    expect(restored!.scope, 'http://localhost:4040');
    expect(restored.principalId, 'user-principal-42');
    expect(restored.savedAt, now.toIso8601String());
    expect(restored.trees.length, 1);

    final restoredRoot = restored.trees.first;
    expect(restoredRoot.obligation.id, 'root-1');
    expect(restoredRoot.obligation.title, 'Title for root-1');
    expect(restoredRoot.obligation.intent, 'Full intent for root-1');
    expect(restoredRoot.obligation.status, 'active');
    expect(restoredRoot.obligation.priority, 1789962406449.0);
    expect(restoredRoot.obligation.effectivePriority, 1789962406449.0);
    expect(restoredRoot.obligation.creatorId, 'creator-uuid');
    expect(restoredRoot.obligation.terminalNote, 'terminal note for root-1');
    expect(restoredRoot.obligation.checkpoint, 'checkpoint text for root-1');
    expect(restoredRoot.obligation.checkpointAt, '2026-09-22T12:01:51.719Z');
    expect(restoredRoot.obligation.checkpointBy, 'actor-checkpoint-author');
    expect(restoredRoot.obligation.resolutionRef, 'mesh:messages/msg-123');
    expect(restoredRoot.obligation.recurrencePolicy, 'interval');
    expect(restoredRoot.obligation.recurrenceCron, '*/5 * * * *');
    expect(restoredRoot.obligation.recurrenceIntervalSeconds, 300);
    expect(restoredRoot.obligation.nextReadyAt, '2026-09-22T13:00:00.000Z');
    expect(restoredRoot.obligation.hasCompletionHistory, isTrue);
    expect(restoredRoot.obligation.externalRef, 'github:MEK-Org/rusa/issues/505');

    expect(restoredRoot.children.length, 1);
    final restoredChild = restoredRoot.children.first;
    expect(restoredChild.obligation.id, 'child-1');
    expect(restoredChild.obligation.parentId, 'root-1');

    expect(restoredRoot.blockingChildren.length, 1);
    final restoredBlocker = restoredRoot.blockingChildren.first;
    expect(restoredBlocker.id, 'blocker-1');
  });

  group('Isolation and Usability boundaries (#505)', () {
    final snapshot = PersistedObligationsSnapshot.capture(
      scope: 'https://mesh.example.invalid:8080',
      principalId: 'principal-alice',
      trees: [
        ObligationTreeDto(
          obligation: makeObligation('ob-1'),
          children: const [],
          blockingChildren: const [],
        ),
      ],
      now: now,
    );

    test('usable only when scope and principal match exactly and time is fresh', () {
      expect(
        snapshot.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: now,
        ),
        isTrue,
      );
    });

    test('refused across different authenticated principals (no cross-user leak)', () {
      expect(
        snapshot.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-bob',
          now: now,
        ),
        isFalse,
      );
    });

    test('refused across different server environments (no cross-instance leak)', () {
      expect(
        snapshot.isUsableAt(
          scope: 'https://staging.mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: now,
        ),
        isFalse,
      );
    });

    test('refused when expired past maxAge (7 days)', () {
      final expiredTime = now.add(PersistedObligationsSnapshot.maxAge + const Duration(minutes: 1));
      expect(
        snapshot.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: expiredTime,
        ),
        isFalse,
      );

      final freshTime = now.add(PersistedObligationsSnapshot.maxAge - const Duration(minutes: 1));
      expect(
        snapshot.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: freshTime,
        ),
        isTrue,
      );
    });

    test('tolerates a small backwards clock adjustment but rejects larger skew', () {
      final withinTolerance = now.subtract(PersistedObligationsSnapshot.maxFutureSkew);
      expect(
        snapshot.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: withinTolerance,
        ),
        isTrue,
      );
      expect(
        snapshot.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: withinTolerance.subtract(const Duration(milliseconds: 1)),
        ),
        isFalse,
      );
    });

    test('refused when savedAt timestamp is malformed', () {
      const malformed = PersistedObligationsSnapshot(
        scope: 'https://mesh.example.invalid:8080',
        principalId: 'principal-alice',
        savedAt: 'invalid-time',
        trees: [],
      );
      expect(
        malformed.isUsableAt(
          scope: 'https://mesh.example.invalid:8080',
          principalId: 'principal-alice',
          now: now,
        ),
        isFalse,
      );
    });
  });

  group('Schema robustness and size limits', () {
    test('refused when schema version does not match', () {
      final json = PersistedObligationsSnapshot.capture(
        scope: 'http://localhost:4040',
        principalId: 'u1',
        trees: const [],
        now: now,
      ).toJson();
      json['version'] = PersistedObligationsSnapshot.schemaVersion + 1;

      expect(PersistedObligationsSnapshot.fromJson(json), isNull);
    });

    test('refused when decoded payload is corrupt or not a map', () {
      expect(PersistedObligationsSnapshot.fromJson(null), isNull);
      expect(PersistedObligationsSnapshot.fromJson('not a map'), isNull);
      expect(PersistedObligationsSnapshot.fromJson([1, 2, 3]), isNull);
      expect(
        PersistedObligationsSnapshot.fromJson({
          'version': PersistedObligationsSnapshot.schemaVersion,
          'scope': 'http://localhost',
          // missing principalId
          'savedAt': now.toIso8601String(),
          'trees': [],
        }),
        isNull,
      );
    });

    test('refused when payload exceeds max budget (512 KiB)', () {
      final hugeIntent = 'x' * (PersistedObligationsSnapshot.maxSerializedBytes + 100);
      final hugeTree = ObligationTreeDto(
        obligation: makeObligation('huge', intent: hugeIntent),
        children: const [],
        blockingChildren: const [],
      );
      final raw = {
        'version': PersistedObligationsSnapshot.schemaVersion,
        'scope': 'http://localhost',
        'principalId': 'u1',
        'savedAt': now.toIso8601String(),
        'trees': [hugeTree.toJson()],
      };
      expect(PersistedObligationsSnapshot.fromJson(raw), isNull);
    });

    test('rejects an oversized raw value before decoding', () {
      final raw = 'x' * (PersistedObligationsSnapshot.maxSerializedBytes + 1);
      expect(PersistedObligationsSnapshot.rawFitsStorageBudget(raw), isFalse);
    });

    test('does not offer an oversized capture to the storage adapter', () {
      final hugeIntent = 'x' * (PersistedObligationsSnapshot.maxSerializedBytes + 100);
      final snapshot = PersistedObligationsSnapshot.capture(
        scope: 'http://localhost',
        principalId: 'u1',
        trees: [
          ObligationTreeDto(
            obligation: makeObligation('huge-write', intent: hugeIntent),
            children: const [],
            blockingChildren: const [],
          ),
        ],
        now: now,
      );
      expect(
        PersistedObligationsSnapshot.rawFitsStorageBudget(snapshot.encode()),
        isFalse,
      );
    });

    test('uses a known serialized byte count without re-encoding the payload', () {
      final snapshot = PersistedObligationsSnapshot.capture(
        scope: 'http://localhost',
        principalId: 'u1',
        trees: const [],
        now: now,
      );
      final encoded = snapshot.encode();

      expect(
        PersistedObligationsSnapshot.fromJson(
          snapshot.toJson(),
          serializedByteCount: PersistedObligationsSnapshot.encodedSize(encoded),
        ),
        isNotNull,
      );

      // The supplied serialized byte count governs the storage-budget boundary:
      // an otherwise small payload is rejected when the known byte count exceeds the budget.
      expect(
        PersistedObligationsSnapshot.fromJson(
          snapshot.toJson(),
          serializedByteCount: PersistedObligationsSnapshot.maxSerializedBytes + 1,
        ),
        isNull,
      );
    });
  });

  group('NoopObligationsCache', () {
    test('load returns null and operations do not throw', () {
      const cache = NoopObligationsCache();
      expect(cache.load(scope: 's', principalId: 'u'), isNull);
      final snapshot = PersistedObligationsSnapshot.capture(
        scope: 's',
        principalId: 'u',
        trees: const [],
        now: now,
      );
      cache.save(snapshot);
      expect(cache.load(scope: 's', principalId: 'u'), isNull);
      cache.invalidate(scope: 's', principalId: 'u');
      cache.clear();
      expect(cache.load(scope: 's', principalId: 'u'), isNull);
    });
  });

  group('FakeObligationsCache', () {
    test('saves and loads by scope and principalId, and invalidates accurately', () {
      final cache = FakeObligationsCache();
      final snap1 = PersistedObligationsSnapshot.capture(
        scope: 'http://server-a',
        principalId: 'user-1',
        trees: [ObligationTreeDto(obligation: makeObligation('o1'), children: const [], blockingChildren: const [])],
        now: now,
      );
      final snap2 = PersistedObligationsSnapshot.capture(
        scope: 'http://server-a',
        principalId: 'user-2',
        trees: [ObligationTreeDto(obligation: makeObligation('o2'), children: const [], blockingChildren: const [])],
        now: now,
      );

      cache.save(snap1);
      cache.save(snap2);

      expect(cache.load(scope: 'http://server-a', principalId: 'user-1')?.trees.first.obligation.id, 'o1');
      expect(cache.load(scope: 'http://server-a', principalId: 'user-2')?.trees.first.obligation.id, 'o2');
      expect(cache.load(scope: 'http://server-b', principalId: 'user-1'), isNull);

      cache.invalidate(scope: 'http://server-a', principalId: 'user-1');
      expect(cache.load(scope: 'http://server-a', principalId: 'user-1'), isNull);
      expect(cache.load(scope: 'http://server-a', principalId: 'user-2')?.trees.first.obligation.id, 'o2');

      cache.clear();
      expect(cache.load(scope: 'http://server-a', principalId: 'user-2'), isNull);
    });
  });
}
