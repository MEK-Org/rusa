import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';

void main() {
  group('ObligationDto.fromJson', () {
    test('deserializes externalRef when it is a nested map (server format)', () {
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
          'key': 'github_issue:dummy-org/dummy-repoISSUE_NUM'
        },
        'status': 'ready',
        'priority': 50.0,
        'effectivePriority': 50.0,
        'prioritySourceId': 'ob-123',
      };

      final dto = ObligationDto.fromJson(json);
      expect(dto.id, 'ob-123');
      expect(dto.externalRef, 'github_issue:dummy-org/dummy-repoISSUE_NUM');
    });

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
  });

  group('ActorViewState', () {
    const thread = ThreadDto(
      id: 'a1',
      handle: 'a1-handle',
      parentId: 'root',
      status: 'active',
      provider: 'claude',
      model: 'claude-3-5-sonnet',
      charter: 'test charter',
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
        const ActorViewState(thread: thread, runState: RunState.queued).dotState,
        DotState.queued,
      );
      expect(
        const ActorViewState(thread: thread, runState: RunState.idle).dotState,
        DotState.idle,
      );
      expect(
        const ActorViewState(thread: thread, runState: RunState.unknown).dotState,
        DotState.idle,
      );
      expect(
        const ActorViewState(thread: thread, runState: RunState.windingDown).dotState,
        DotState.active,
      );

      final retiredThread = thread.copyWith(status: 'retired');
      expect(
        ActorViewState(thread: retiredThread, runState: RunState.running).dotState,
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
      charter: '',
      createdAt: '2026-01-01T00:00:00Z',
    );
    const thread2 = ThreadDto(
      id: 'a2',
      handle: 'a2-handle',
      parentId: 'a1',
      status: 'active',
      provider: null,
      model: null,
      charter: '',
      createdAt: '2026-01-01T00:01:00Z',
    );
    const thread3 = ThreadDto(
      id: 'a3',
      handle: 'a3-handle',
      parentId: 'a1',
      status: 'retired',
      provider: null,
      model: null,
      charter: '',
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
}
