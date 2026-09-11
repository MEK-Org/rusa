import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/util.dart';

void main() {
  group('MeshEvent.resolvedRunModel', () {
    test('uses launch metadata and leaves historical run_start rows blank', () {
      final launched = MeshEvent.fromJson({
        'id': 'launch',
        'kind': 'run_start',
        'actorId': 'a',
        'detail': null,
        'body': null,
        'payload': '{"provider":"codex","model":"gpt-5.6-sol"}',
        'success': null,
      });
      final historical = MeshEvent.fromJson({
        'id': 'historical',
        'kind': 'run_start',
        'actorId': 'a',
        'detail': null,
        'body': null,
        'payload': '{"provider":"codex"}',
        'success': null,
      });

      expect(launched.resolvedRunModel, 'gpt-5.6-sol');
      expect(historical.resolvedRunModel, isNull);
    });
  });

  group('ObligationDto.fromJson', () {
    test(
      'deserializes externalRef when it is a nested map (server format)',
      () {
        final json = {
          'id': 'ob-123',
          'parentId': null,
          'ownerId': 'test-actor',
          'intent': 'Test intent',
          'externalRef': {
            'kind': 'github_issue',
            'owner': 'MEK-Org',
            'repo': 'rusa',
            'number': 1589,
            'key': 'github_issue:dummy-org/dummy-repoISSUE_NUM',
          },
          'status': 'ready',
          'priority': 50.0,
          'effectivePriority': 50.0,
          'prioritySourceId': 'ob-123',
        };

        final dto = ObligationDto.fromJson(json);
        expect(dto.id, 'ob-123');
        expect(dto.externalRef, 'github_issue:dummy-org/dummy-repoISSUE_NUM');
      },
    );

    test('deserializes externalRef when it is a string', () {
      final json = {
        'id': 'ob-456',
        'parentId': null,
        'ownerId': 'test-actor',
        'intent': 'Test intent 2',
        'externalRef': 'github_issue:dummy-org/dummy-repoISSUE_NUM',
        'status': 'ready',
        'priority': 50.0,
        'effectivePriority': 50.0,
        'prioritySourceId': 'ob-456',
      };

      final dto = ObligationDto.fromJson(json);
      expect(dto.id, 'ob-456');
      expect(dto.externalRef, 'github_issue:dummy-org/dummy-repoISSUE_NUM');
    });

    test('deserializes externalRef when it is null', () {
      final json = {
        'id': 'ob-789',
        'parentId': null,
        'ownerId': 'test-actor',
        'intent': 'Test intent 3',
        'externalRef': null,
        'status': 'ready',
        'priority': 50.0,
        'effectivePriority': 50.0,
        'prioritySourceId': 'ob-789',
      };

      final dto = ObligationDto.fromJson(json);
      expect(dto.id, 'ob-789');
      expect(dto.externalRef, null);
    });

    test('deserializes recurrence fields and derives isScheduled/isRecurring', () {
      final json = {
        'id': 'ob-cron',
        'parentId': null,
        'ownerId': 'test-actor',
        'intent': 'Nightly sweep',
        'externalRef': null,
        'status': 'scheduled',
        'priority': 50.0,
        'effectivePriority': 50.0,
        'prioritySourceId': 'ob-cron',
        'recurrencePolicy': 'cron',
        'recurrenceCron': '0 3 * * *',
        'recurrenceIntervalSeconds': null,
        'nextReadyAt': '2026-09-03T03:00:00.000Z',
      };

      final dto = ObligationDto.fromJson(json);
      expect(dto.recurrencePolicy, 'cron');
      expect(dto.recurrenceCron, '0 3 * * *');
      expect(dto.recurrenceIntervalSeconds, null);
      expect(dto.nextReadyAt, '2026-09-03T03:00:00.000Z');
      expect(dto.isScheduled, true);
      expect(dto.isRecurring, true);
      expect(dto.isTerminal, false);
    });

    test('a non-recurring ready obligation reports isScheduled/isRecurring false', () {
      final json = {
        'id': 'ob-plain',
        'parentId': null,
        'ownerId': 'test-actor',
        'intent': 'One-off task',
        'externalRef': null,
        'status': 'ready',
        'priority': 50.0,
        'effectivePriority': 50.0,
        'prioritySourceId': 'ob-plain',
      };

      final dto = ObligationDto.fromJson(json);
      expect(dto.recurrencePolicy, null);
      expect(dto.nextReadyAt, null);
      expect(dto.isScheduled, false);
      expect(dto.isRecurring, false);
      expect(dto.hasCompletionHistory, false);
    });

    test('deserializes retained completion-history existence without an exact count', () {
      final dto = ObligationDto.fromJson({
        'id': 'ob-formerly-recurring',
        'ownerId': 'test-actor',
        'status': 'done',
        'effectivePriority': 50.0,
        'hasCompletionHistory': true,
      });

      expect(dto.isRecurring, false);
      expect(dto.hasCompletionHistory, true);
    });
  });

  group('ObligationDetailSnapshot.fromJson', () {
    test('deserializes completion history and pagination fields', () {
      final json = {
        'obligation': {
          'id': 'ob-cron',
          'ownerId': 'test-actor',
          'status': 'scheduled',
          'effectivePriority': 50.0,
          'recurrencePolicy': 'cron',
          'recurrenceCron': '0 3 * * *',
          'nextReadyAt': '2026-09-03T03:00:00.000Z',
        },
        'parent': null,
        'children': [],
        'blockingChildren': [],
        'artifacts': [],
        'completions': [
          {
            'id': 'c-2',
            'obligationId': 'ob-cron',
            'sequence': 2,
            'completedAt': '2026-09-02T03:00:00.000Z',
            'note': 'cycle two',
            'resolutionRef': null,
            'nextReadyAt': '2026-09-03T03:00:00.000Z',
          },
        ],
        'completionsTotal': 2,
        'completionsHasMore': true,
      };

      final snapshot = ObligationDetailSnapshot.fromJson(json);
      expect(snapshot.completions, hasLength(1));
      expect(snapshot.completions.first.id, 'c-2');
      expect(snapshot.completions.first.sequence, 2);
      expect(snapshot.completions.first.note, 'cycle two');
      expect(snapshot.completionsTotal, 2);
      expect(snapshot.completionsHasMore, true);
    });

    test('defaults completion fields when absent (non-recurring obligations)', () {
      final json = {
        'obligation': {
          'id': 'ob-plain',
          'ownerId': 'test-actor',
          'status': 'ready',
          'effectivePriority': 50.0,
        },
        'parent': null,
        'children': [],
        'blockingChildren': [],
        'artifacts': [],
      };

      final snapshot = ObligationDetailSnapshot.fromJson(json);
      expect(snapshot.completions, isEmpty);
      expect(snapshot.completionsTotal, 0);
      expect(snapshot.completionsHasMore, false);
      expect(snapshot.externalReference, isNull);
    });

    test('deserializes externalReference when present', () {
      final json = {
        'obligation': {
          'id': 'ob-with-ext',
          'ownerId': 'test-actor',
          'status': 'ready',
          'effectivePriority': 50.0,
          'externalRef': 'github:MEK-Org/rusa/issues/345',
        },
        'parent': null,
        'children': [],
        'blockingChildren': [],
        'artifacts': [],
        'externalReference': {
          'ref': 'github:MEK-Org/rusa/issues/345',
          'scheme': 'github',
          'title': 'Issue 345 Title',
          'body': 'Issue 345 description',
          'url': 'https://github.com/MEK-Org/rusa/issues/345',
          'author': 'AlabasterAxe',
        },
      };

      final snapshot = ObligationDetailSnapshot.fromJson(json);
      expect(snapshot.externalReference, isNotNull);
      expect(snapshot.externalReference!.ref, 'github:MEK-Org/rusa/issues/345');
      expect(snapshot.externalReference!.scheme, 'github');
      expect(snapshot.externalReference!.title, 'Issue 345 Title');
      expect(snapshot.externalReference!.body, 'Issue 345 description');
      expect(snapshot.externalReference!.url, 'https://github.com/MEK-Org/rusa/issues/345');
      expect(snapshot.externalReference!.author, 'AlabasterAxe');
    });

    test('deserializes blockedBy and blocks from server list format with counts', () {
      final json = {
        'obligation': {
          'id': 'ob-target',
          'ownerId': 'test-actor',
          'status': 'waiting',
          'effectivePriority': 50.0,
        },
        'parent': null,
        'children': [],
        'blockingChildren': [],
        'blockedBy': [
          {
            'id': 'prereq-non-gh',
            'ownerId': 'actor-1',
            'title': 'Prerequisite Title',
            'status': 'ready',
            'effectivePriority': 20.0,
          },
          {
            'id': 'prereq-gh',
            'ownerId': 'actor-2',
            'title': 'Prerequisite with GitHub Ref',
            'status': 'waiting',
            'effectivePriority': 30.0,
            'externalRef': 'github:MEK-Org/rusa/issues/100',
          },
        ],
        'blockedByTotal': 5,
        'blockedByHasMore': true,
        'blocks': [
          {
            'id': 'dep-1',
            'ownerId': 'actor-3',
            'title': 'Dependent Title',
            'status': 'waiting',
            'effectivePriority': 40.0,
          },
        ],
        'blocksTotal': 1,
        'blocksHasMore': false,
      };

      final snapshot = ObligationDetailSnapshot.fromJson(json);
      expect(snapshot.blockedBy, hasLength(2));
      expect(snapshot.blockedBy[0].id, 'prereq-non-gh');
      expect(snapshot.blockedBy[0].heading, 'Prerequisite Title');
      expect(snapshot.blockedBy[0].externalRef, isNull);
      expect(snapshot.blockedBy[1].id, 'prereq-gh');
      expect(snapshot.blockedBy[1].heading, 'Prerequisite with GitHub Ref');
      expect(snapshot.blockedBy[1].externalRef, 'github:MEK-Org/rusa/issues/100');
      expect(snapshot.blockedByTotal, 5);
      expect(snapshot.blockedByHasMore, true);

      expect(snapshot.blocks, hasLength(1));
      expect(snapshot.blocks[0].id, 'dep-1');
      expect(snapshot.blocks[0].heading, 'Dependent Title');
      expect(snapshot.blocksTotal, 1);
      expect(snapshot.blocksHasMore, false);
    });

    test('deserializes blockedBy and unblocks from MCP map format', () {
      final json = {
        'obligation': {
          'id': 'ob-target',
          'ownerId': 'test-actor',
          'status': 'ready',
          'effectivePriority': 50.0,
        },
        'parent': null,
        'children': {'items': [], 'total': 0, 'truncated': false},
        'blockingChildren': {'items': [], 'total': 0, 'truncated': false},
        'blockedBy': {
          'items': [
            {
              'id': 'p-1',
              'ownerId': 'actor-1',
              'title': 'Blocker',
              'status': 'done',
              'effectivePriority': 10.0,
            }
          ],
          'total': 1,
          'truncated': false,
        },
        'unblocks': {
          'items': [
            {
              'id': 'd-1',
              'ownerId': 'actor-2',
              'title': 'Blocked Item',
              'status': 'waiting',
              'effectivePriority': 60.0,
              'externalRef': 'github:MEK-Org/rusa/pulls/200',
            }
          ],
          'total': 3,
          'truncated': true,
        },
      };

      final snapshot = ObligationDetailSnapshot.fromJson(json);
      expect(snapshot.blockedBy, hasLength(1));
      expect(snapshot.blockedBy[0].id, 'p-1');
      expect(snapshot.blockedByTotal, 1);
      expect(snapshot.blockedByHasMore, false);

      expect(snapshot.blocks, hasLength(1));
      expect(snapshot.blocks[0].id, 'd-1');
      expect(snapshot.blocks[0].externalRef, 'github:MEK-Org/rusa/pulls/200');
      expect(snapshot.blocksTotal, 3);
      expect(snapshot.blocksHasMore, true);
    });

    test('handles empty and absent blockedBy and blocks fields gracefully', () {
      final json = {
        'obligation': {
          'id': 'ob-target',
          'ownerId': 'test-actor',
          'status': 'ready',
          'effectivePriority': 50.0,
        },
        'parent': null,
        'children': [],
        'blockingChildren': [],
      };

      final snapshot = ObligationDetailSnapshot.fromJson(json);
      expect(snapshot.blockedBy, isEmpty);
      expect(snapshot.blockedByTotal, 0);
      expect(snapshot.blockedByHasMore, false);
      expect(snapshot.blocks, isEmpty);
      expect(snapshot.blocksTotal, 0);
      expect(snapshot.blocksHasMore, false);
    });

    test('externalRefUrl derives valid URLs and handles unsupported schemes', () {
      expect(
        externalRefUrl('github:MEK-Org/rusa/issues/416'),
        'https://github.com/MEK-Org/rusa/issues/416',
      );
      expect(
        externalRefUrl('github:MEK-Org/rusa/pulls/42'),
        'https://github.com/MEK-Org/rusa/pull/42',
      );
      expect(
        externalRefUrl('github:MEK-Org/rusa'),
        'https://github.com/MEK-Org/rusa',
      );
      expect(
        externalRefUrl('https://example.com/item'),
        'https://example.com/item',
      );
      expect(externalRefUrl('mesh:messages/123'), isNull);
      expect(externalRefUrl(''), isNull);
      expect(externalRefUrl(null), isNull);
    });
  });

  group('ActorViewState', () {
    const thread = ThreadDto(
      id: 'a1',
      handle: 'a1-handle',
      parentId: 'root',
      status: 'active',
      provider: 'claude',
      model: 'claude-3-5-sonnet',
      charterPreview: 'test charter',
      title: 'test title',
      createdAt: '2026-01-01T00:00:00Z',
    );

    test('exposes thread properties and runState correctly', () {
      const state = ActorViewState(thread: thread, runState: RunState.running);
      expect(state.id, 'a1');
      expect(state.handle, 'a1-handle');
      expect(state.parentId, 'root');
      expect(state.status, 'active');
      expect(state.isRetired, false);
      expect(state.provider, 'claude');
      expect(state.isRunning, true);
      expect(state.isQueued, false);
      expect(state.isIdle, false);
      expect(state.isWindingDown, false);
      expect(state.isActiveRun, true);
      expect(state.dotState, DotState.active);
    });

    test('dotState reflects runState and retired override', () {
      expect(
        const ActorViewState(
          thread: thread,
          runState: RunState.queued,
        ).dotState,
        DotState.queued,
      );
      expect(
        const ActorViewState(thread: thread, runState: RunState.idle).dotState,
        DotState.idle,
      );
      expect(
        const ActorViewState(
          thread: thread,
          runState: RunState.unknown,
        ).dotState,
        DotState.idle,
      );
      expect(
        const ActorViewState(
          thread: thread,
          runState: RunState.windingDown,
        ).dotState,
        DotState.active,
      );

      final retiredThread = thread.copyWith(status: 'retired');
      expect(
        ActorViewState(
          thread: retiredThread,
          runState: RunState.running,
        ).dotState,
        DotState.retired,
      );
    });

    test('copyWith updates fields', () {
      const state = ActorViewState(thread: thread, runState: RunState.idle);
      final updated = state.copyWith(runState: RunState.running);
      expect(updated.runState, RunState.running);
      expect(updated.thread, thread);
    });
  });

  group('ActorStateSnapshot', () {
    const thread1 = ThreadDto(
      id: 'a1',
      handle: 'a1-handle',
      parentId: null,
      status: 'active',
      provider: null,
      model: null,
      charterPreview: '',
      createdAt: '2026-01-01T00:00:00Z',
    );
    const thread2 = ThreadDto(
      id: 'a2',
      handle: 'a2-handle',
      parentId: 'a1',
      status: 'active',
      provider: null,
      model: null,
      charterPreview: '',
      createdAt: '2026-01-01T00:01:00Z',
    );
    const thread3 = ThreadDto(
      id: 'a3',
      handle: 'a3-handle',
      parentId: 'a1',
      status: 'retired',
      provider: null,
      model: null,
      charterPreview: '',
      createdAt: '2026-01-01T00:02:00Z',
    );

    final snapshot = ActorStateSnapshot(
      revision: 1,
      orderedIds: const ['a1', 'a2', 'a3'],
      actors: const {
        'a1': ActorViewState(thread: thread1, runState: RunState.running),
        'a2': ActorViewState(thread: thread2, runState: RunState.queued),
        'a3': ActorViewState(thread: thread3, runState: RunState.idle),
      },
    );

    test('selectors filter running and queued actors correctly', () {
      expect(snapshot.runningActors.map((a) => a.id), ['a1']);
      expect(snapshot.queuedActors.map((a) => a.id), ['a2']);
      expect(snapshot.all.map((a) => a.id), ['a1', 'a2', 'a3']);
      expect(snapshot['a1']?.id, 'a1');
      expect(snapshot.actor('a2')?.id, 'a2');
      expect(snapshot.actor('non-existent'), isNull);
    });

    test('dotFor and dotForThread report correct dot state', () {
      expect(snapshot.dotFor('a1'), DotState.active);
      expect(snapshot.dotFor('a2'), DotState.queued);
      expect(snapshot.dotFor('a3'), DotState.retired);
      expect(snapshot.dotFor('unknown'), DotState.idle);

      expect(snapshot.dotForThread(thread1), DotState.active);
      expect(snapshot.dotForThread(thread2), DotState.queued);
      expect(snapshot.dotForThread(thread3), DotState.retired);
    });
  });

  group('ThreadDto queue pacing', () {
    test('deserializes the current pacing interval', () {
      final thread = ThreadDto.fromJson({
        'id': 'synthetic-queued',
        'handle': 'synthetic-queued',
        'parentId': 'root',
        'status': 'active',
        'provider': 'synthetic-provider',
        'model': 'synthetic-model',
        'charterPreview': '',
        'createdAt': '2026-01-01T00:00:00.000Z',
        'runState': 'queued',
        'pacingIntervalMs': 36000000,
      });

      expect(thread.pacingIntervalMs, 36000000);
    });

    test('rounds a fractional wire interval to the nearest millisecond', () {
      final thread = ThreadDto.fromJson({
        'id': 'synthetic-queued',
        'handle': 'synthetic-queued',
        'parentId': 'root',
        'status': 'active',
        'provider': 'synthetic-provider',
        'model': 'synthetic-model',
        'charterPreview': '',
        'createdAt': '2026-01-01T00:00:00.000Z',
        'runState': 'queued',
        'pacingIntervalMs': 36000000.6,
      });

      expect(thread.pacingIntervalMs, 36000001);
    });
  });

  group('ActorStateSnapshot.queuedActors ordering', () {
    ThreadDto queuedThread(
      String id, {
      int? queuePosition,
      String? estimatedStartAt,
    }) => ThreadDto(
      id: id,
      handle: '$id-handle',
      parentId: null,
      status: 'active',
      provider: null,
      model: null,
      charterPreview: '',
      createdAt: '2026-01-01T00:00:00Z',
      queuePosition: queuePosition,
      estimatedStartAt: estimatedStartAt,
    );

    test('sorts by ascending estimated start time', () {
      final snapshot = ActorStateSnapshot(
        orderedIds: const ['late', 'early', 'mid'],
        actors: {
          'late': ActorViewState(
            thread: queuedThread(
              'late',
              estimatedStartAt: '2026-01-01T00:00:30.000Z',
            ),
            runState: RunState.queued,
          ),
          'early': ActorViewState(
            thread: queuedThread(
              'early',
              estimatedStartAt: '2026-01-01T00:00:10.000Z',
            ),
            runState: RunState.queued,
          ),
          'mid': ActorViewState(
            thread: queuedThread(
              'mid',
              estimatedStartAt: '2026-01-01T00:00:20.000Z',
            ),
            runState: RunState.queued,
          ),
        },
      );

      expect(snapshot.queuedActors.map((a) => a.id), ['early', 'mid', 'late']);
    });

    test('places unknown estimates after every known estimate', () {
      final snapshot = ActorStateSnapshot(
        orderedIds: const ['unknown', 'known'],
        actors: {
          'unknown': ActorViewState(
            thread: queuedThread('unknown', queuePosition: 0),
            runState: RunState.queued,
          ),
          'known': ActorViewState(
            thread: queuedThread(
              'known',
              estimatedStartAt: '2026-01-01T00:05:00.000Z',
            ),
            runState: RunState.queued,
          ),
        },
      );

      expect(snapshot.queuedActors.map((a) => a.id), ['known', 'unknown']);
    });

    test(
      'breaks ties on equal estimated start time deterministically by id',
      () {
        final snapshot = ActorStateSnapshot(
          orderedIds: const ['zeta', 'alpha'],
          actors: {
            'zeta': ActorViewState(
              thread: queuedThread(
                'zeta',
                estimatedStartAt: '2026-01-01T00:00:10.000Z',
              ),
              runState: RunState.queued,
            ),
            'alpha': ActorViewState(
              thread: queuedThread(
                'alpha',
                estimatedStartAt: '2026-01-01T00:00:10.000Z',
              ),
              runState: RunState.queued,
            ),
          },
        );

        // Same ordering regardless of insertion/orderedIds order — proves the
        // comparator is symmetric rather than always favoring one side.
        expect(snapshot.queuedActors.map((a) => a.id), ['alpha', 'zeta']);

        final reversed = ActorStateSnapshot(
          orderedIds: const ['alpha', 'zeta'],
          actors: snapshot.actors,
        );
        expect(reversed.queuedActors.map((a) => a.id), ['alpha', 'zeta']);
      },
    );

    test('breaks ties among unknown estimates by lane position then id', () {
      final snapshot = ActorStateSnapshot(
        orderedIds: const ['b-pos1', 'a-pos0', 'c-pos1'],
        actors: {
          'b-pos1': ActorViewState(
            thread: queuedThread('b-pos1', queuePosition: 1),
            runState: RunState.queued,
          ),
          'a-pos0': ActorViewState(
            thread: queuedThread('a-pos0', queuePosition: 0),
            runState: RunState.queued,
          ),
          'c-pos1': ActorViewState(
            thread: queuedThread('c-pos1', queuePosition: 1),
            runState: RunState.queued,
          ),
        },
      );

      expect(snapshot.queuedActors.map((a) => a.id), [
        'a-pos0',
        'b-pos1',
        'c-pos1',
      ]);
    });
  });

  group('ThreadDto selected obligation', () {
    test(
      'parses the optional active-run focus and leaves an absent focus null',
      () {
        final withFocus = ThreadDto.fromJson({
          'id': 'actor-1',
          'handle': 'actor-1-handle',
          'parentId': 'root',
          'status': 'active',
          'provider': null,
          'model': null,
          'charterPreview': 'charter',
          'createdAt': '2026-09-06T00:00:00.000Z',
          'runState': 'running',
          'selectedObligation': {
            'id': 'focus-1',
            'ownerId': 'actor-1',
            'title': 'Current work',
            'intent': 'Finish the dashboard card',
            'status': 'ready',
            'effectivePriority': 1,
          },
        });
        final withoutFocus = ThreadDto.fromJson({
          'id': 'actor-2',
          'handle': 'actor-2-handle',
          'parentId': 'root',
          'status': 'active',
          'provider': null,
          'model': null,
          'charterPreview': 'charter',
          'createdAt': '2026-09-06T00:00:00.000Z',
          'runState': 'queued',
        });

        expect(withFocus.selectedObligation?.id, 'focus-1');
        expect(withFocus.selectedObligation?.heading, 'Current work');
        expect(withoutFocus.selectedObligation, isNull);
      },
    );
  });
}
