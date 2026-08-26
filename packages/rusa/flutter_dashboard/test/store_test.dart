import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';

import 'fakes.dart';

Future<DashboardStore> _booted(FakeApi api, FakeStream stream) async {
  final store = DashboardStore(api: api, stream: stream);
  await store.init();
  await pumpEventQueue();
  return store;
}

void main() {
  test('init loads dashboard quota provider config', () async {
    final api = FakeApi()
      ..threadsResult = [makeThread('root', created: 't0')]
      ..dashboardConfigResult = const DashboardConfigDto(
        quotaProviders: {
          'claude': QuotaProviderConfigDto(primaryWindow: 'session'),
        },
      );
    final store = await _booted(api, FakeStream());

    expect(
      store.dashboardConfig.value?.quotaProviders['claude']?.primaryWindow,
      'session',
    );
    await store.dispose();
  });

  test(
    'flattenedVisible hides retired by default and respects the toggle',
    () async {
      final recent = DateTime.now()
          .toUtc()
          .subtract(const Duration(days: 1))
          .toIso8601String();
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('a', parent: 'root', created: 't1'),
          makeThread('b', parent: 'root', created: 't2'),
          makeThread(
            'c',
            parent: 'root',
            status: 'retired',
            created: 't3',
            lastActiveAt: recent,
          ),
        ];
      final store = await _booted(api, FakeStream());

      expect(store.flattenedVisible().map((t) => t.id), ['root', 'a', 'b']);
      store.setShowRetired(true);
      expect(store.flattenedVisible().map((t) => t.id), [
        'root',
        'a',
        'b',
        'c',
      ]);
      await store.dispose();
    },
  );

  test(
    'flattenedVisible hides long-inactive retired actors even when showRetired is on',
    () async {
      final recent = DateTime.now()
          .toUtc()
          .subtract(const Duration(days: 1))
          .toIso8601String();
      final stale = DateTime.now()
          .toUtc()
          .subtract(const Duration(days: 8))
          .toIso8601String();
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'a',
            parent: 'root',
            status: 'retired',
            created: 't1',
            lastActiveAt: recent,
          ),
          makeThread(
            'b',
            parent: 'root',
            status: 'retired',
            created: 't2',
            lastActiveAt: stale,
          ),
          makeThread('c', parent: 'root', status: 'retired', created: 't3'),
          makeThread('d', parent: 'root', created: 't4'),
        ];
      final store = await _booted(api, FakeStream());
      store.setShowRetired(true);

      // Active 'd' and recently active retired 'a' are visible; stale/no-activity
      // retired actors 'b' and 'c' are hidden.
      expect(store.flattenedVisible().map((t) => t.id), ['root', 'a', 'd']);
      await store.dispose();
    },
  );

  test(
    'flattenedVisible hides collapsed subtrees and toggleCollapsed works',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('a', parent: 'root', created: 't1'),
          makeThread('b', parent: 'a', created: 't2'),
          makeThread('c', parent: 'root', created: 't3'),
        ];
      final store = await _booted(api, FakeStream());

      // Initially everything is expanded
      expect(store.flattenedVisible().map((t) => t.id), [
        'root',
        'a',
        'b',
        'c',
      ]);
      expect(store.collapsed.value, isEmpty);

      // Collapse 'a' -> should hide 'b'
      store.toggleCollapsed('a');
      expect(store.collapsed.value, {'a'});
      expect(store.flattenedVisible().map((t) => t.id), ['root', 'a', 'c']);

      // Expand 'a' again -> should show 'b'
      store.toggleCollapsed('a');
      expect(store.collapsed.value, isEmpty);
      expect(store.flattenedVisible().map((t) => t.id), [
        'root',
        'a',
        'b',
        'c',
      ]);

      // Collapse 'root' -> should hide 'a', 'b', 'c'
      store.toggleCollapsed('root');
      expect(store.collapsed.value, {'root'});
      expect(store.flattenedVisible().map((t) => t.id), ['root']);

      await store.dispose();
    },
  );

  test(
    'persists collapsed and showRetired preferences across store reloads via TreePreferencesCache',
    () async {
      final cache = FakeTreePreferencesCache();
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('a', parent: 'root', created: 't1'),
          makeThread('b', parent: 'a', created: 't2'),
        ];

      // Session 1: toggle collapse on 'a' and toggle showRetired
      final store1 = DashboardStore(
        api: api,
        stream: FakeStream(),
        treePreferencesCache: cache,
      );
      await store1.init();
      await pumpEventQueue();

      expect(store1.collapsed.value, isEmpty);
      expect(store1.showRetired.value, isFalse);

      store1.toggleCollapsed('a');
      store1.setShowRetired(true);

      expect(store1.collapsed.value, {'a'});
      expect(store1.showRetired.value, isTrue);
      expect(cache.storedCollapsed, {'a'});
      expect(cache.storedShowRetired, isTrue);

      await store1.dispose();

      // Session 2: new store instance booted with the same cache
      final store2 = DashboardStore(
        api: api,
        stream: FakeStream(),
        treePreferencesCache: cache,
      );
      await store2.init();
      await pumpEventQueue();

      // Restored immediately on instantiation
      expect(store2.collapsed.value, {'a'});
      expect(store2.showRetired.value, isTrue);
      expect(store2.flattenedVisible().map((t) => t.id), ['root', 'a']);

      // setCollapsed explicitly expands
      store2.setCollapsed('a', false);
      expect(store2.collapsed.value, isEmpty);
      expect(cache.storedCollapsed, isEmpty);
      expect(store2.flattenedVisible().map((t) => t.id), ['root', 'a', 'b']);

      await store2.dispose();
    },
  );

  test(
    'click / ctrl-toggle / shift-range selection over the visible list',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('a', parent: 'root', created: 't1'),
          makeThread('b', parent: 'root', created: 't2'),
        ];
      final store = await _booted(api, FakeStream());

      store.clickActor('a');
      expect(store.selection.value, {'a'});
      expect(store.primary.value, 'a');

      store.toggleActor('b');
      expect(store.selection.value, {'a', 'b'});
      expect(store.primary.value, 'b');

      store.toggleActor('a'); // remove a
      expect(store.selection.value, {'b'});
      expect(store.primary.value, 'b');

      store.clickActor('root'); // anchor = root
      store.rangeSelectTo('a'); // range root..a over [root,a,b]
      expect(store.selection.value, {'root', 'a'});
      expect(store.primary.value, 'a');
      await store.dispose();
    },
  );

  test('selection is capped at 2 actors maximum', () async {
    final api = FakeApi()
      ..threadsResult = [
        makeThread('root', created: 't0'),
        makeThread('a', parent: 'root', created: 't1'),
        makeThread('b', parent: 'root', created: 't2'),
      ];
    final store = await _booted(api, FakeStream());

    store.clickActor('root');
    expect(store.selection.value, {'root'});

    store.toggleActor('a');
    expect(store.selection.value, {'root', 'a'});

    // Attempting to select a 3rd actor should be ignored
    store.toggleActor('b');
    expect(store.selection.value, {'root', 'a'});

    await store.dispose();
  });

  test(
    'dotFor: retired wins; seeded run-state drives the dot; SSE transitions update it',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread(
            'a',
            parent: 'root',
            created: 't1',
            runState: RunState.idle,
          ),
          makeThread('r', parent: 'root', status: 'retired', created: 't2'),
          makeThread(
            'b',
            parent: 'root',
            created: 't3',
            runState: RunState.running,
          ),
        ];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      // Seeded from the server payload — no longer defaults to green/active.
      expect(store.dotFor(api.threadsResult[0]), DotState.idle); // seeded idle
      expect(
        store.dotFor(api.threadsResult[1]),
        DotState.retired,
      ); // retired wins
      expect(
        store.dotFor(api.threadsResult[2]),
        DotState.active,
      ); // seeded running → green

      // Live SSE transitions still drive the dot.
      stream.meshCtrl.add(makeEvent('q1', 'run_queued', actor: 'a'));
      await pumpEventQueue();
      expect(store.dotFor(api.threadsResult[0]), DotState.queued);

      stream.meshCtrl.add(makeEvent('e1', 'run_start', actor: 'a'));
      await pumpEventQueue();
      expect(store.dotFor(api.threadsResult[0]), DotState.active);

      stream.meshCtrl.add(makeEvent('e2', 'run_end', actor: 'a'));
      await pumpEventQueue();
      expect(store.dotFor(api.threadsResult[0]), DotState.idle);
      await store.dispose();
    },
  );

  test(
    'actorStates stream and selectors: normalized single source of truth with live updates',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('a', parent: 'root', runState: RunState.idle),
          makeThread('b', parent: 'root', runState: RunState.queued),
          makeThread('c', parent: 'root', runState: RunState.running),
        ];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      expect(store.runningActors.map((a) => a.id), ['c']);
      expect(store.queuedActors.map((a) => a.id), ['b']);
      expect(store.actor('a')?.runState, RunState.idle);
      expect(store.actor('b')?.runState, RunState.queued);
      expect(store.actor('c')?.runState, RunState.running);

      // SSE run_start moves 'b' to running
      stream.meshCtrl.add(makeEvent('e1', 'run_start', actor: 'b'));
      await pumpEventQueue();

      expect(store.runningActors.map((a) => a.id), ['b', 'c']);
      expect(store.queuedActors.map((a) => a.id), isEmpty);
      expect(store.actor('b')?.runState, RunState.running);
      expect(store.actor('b')?.dotState, DotState.active);

      // SSE run_yielded moves 'c' to windingDown (still in runningActors)
      stream.meshCtrl.add(makeEvent('e2', 'run_yielded', actor: 'c'));
      await pumpEventQueue();

      expect(store.runningActors.map((a) => a.id), ['b', 'c']);
      expect(store.actor('c')?.runState, RunState.windingDown);
      expect(store.actor('c')?.dotState, DotState.active);

      // SSE run_end moves 'c' to idle
      stream.meshCtrl.add(makeEvent('e3', 'run_end', actor: 'c'));
      await pumpEventQueue();

      expect(store.runningActors.map((a) => a.id), ['b']);
      expect(store.actor('c')?.runState, RunState.idle);
      expect(store.actor('c')?.dotState, DotState.idle);

      // SSE run_abandoned moves 'b' to idle
      stream.meshCtrl.add(makeEvent('e4', 'run_abandoned', actor: 'b'));
      await pumpEventQueue();

      expect(store.runningActors, isEmpty);
      expect(store.queuedActors, isEmpty);
      expect(store.actor('b')?.runState, RunState.idle);

      await store.dispose();
    },
  );

  test(
    'reducer fix: continuation_capped and root_control_action do NOT transition to idle',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('a', parent: 'root', runState: RunState.running),
        ];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      expect(store.actor('a')?.runState, RunState.running);

      // continuation_capped is not a terminal bracket and must not make the actor idle
      stream.meshCtrl.add(makeEvent('e1', 'continuation_capped', actor: 'a'));
      await pumpEventQueue();
      expect(store.actor('a')?.runState, RunState.running);
      expect(store.dotFor(api.threadsResult[0]), DotState.active);

      // root_control_action is not a terminal bracket and must not make the actor idle
      stream.meshCtrl.add(makeEvent('e2', 'root_control_action', actor: 'a'));
      await pumpEventQueue();
      expect(store.actor('a')?.runState, RunState.running);
      expect(store.dotFor(api.threadsResult[0]), DotState.active);

      // Genuine terminal bracket run_end DOES make it idle
      stream.meshCtrl.add(makeEvent('e3', 'run_end', actor: 'a'));
      await pumpEventQueue();
      expect(store.actor('a')?.runState, RunState.idle);
      expect(store.dotFor(api.threadsResult[0]), DotState.idle);

      await store.dispose();
    },
  );

  test(
    'interruptActor updates normalized actorStates and runState to idle',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('a', parent: 'root', runState: RunState.running),
        ];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      expect(store.runningActors.map((a) => a.id), ['a']);

      await store.interruptActor('a');

      expect(store.runningActors, isEmpty);
      expect(store.actor('a')?.runState, RunState.idle);
      expect(store.dotFor(api.threadsResult[0]), DotState.idle);

      await store.dispose();
    },
  );

  test(
    'dotFor: an unseeded/unknown run-state is neutral idle, not active',
    () async {
      final api = FakeApi()
        ..threadsResult = [makeThread('a', parent: 'root')]; // runState unknown
      final store = await _booted(api, FakeStream());
      expect(
        store.dotFor(api.threadsResult[0]),
        DotState.idle,
      ); // the cold-load bug fix
      await store.dispose();
    },
  );

  test('topology refresh unconditionally adopts the snapshot run state to heal dropped SSE events', () async {
    final api = FakeApi()
      ..threadsResult = [
        makeThread('a', parent: 'root', runState: RunState.running),
      ];
    final stream = FakeStream();
    final store = DashboardStore(api: api, stream: stream);
    await store.init(); // opens stream, then fetches/seeds threads
    await pumpEventQueue();

    // A live run_end moves it to idle.
    stream.meshCtrl.add(makeEvent('e1', 'run_end', actor: 'a'));
    await pumpEventQueue();
    expect(store.actor('a')?.runState, RunState.idle);

    // BUT a subsequent topology refresh showing it still 'running' MUST win, 
    // because the dashboard must trust the server's API snapshot.
    await store.refreshThreads();
    await pumpEventQueue();
    expect(store.dotFor(api.threadsResult[0]), DotState.active);
    expect(store.actor('a')?.runState, RunState.running);
    await store.dispose();
  });

  test(
    'halted: seeded from the threads payload and exposed as a stream',
    () async {
      final api = FakeApi()
        ..halted = true
        ..threadsResult = [makeThread('a', parent: 'root')];
      final store = await _booted(api, FakeStream());
      expect(store.halted.value, true);
      await store.dispose();
    },
  );

  test(
    'events: live/history seam de-dupes by id, prepends only matching live frames',
    () async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('a', parent: 'root', created: 't1'),
          makeThread('b', parent: 'root', created: 't2'),
        ]
        ..eventPages = [
          EventPage(
            events: [makeEvent('e1', 'run_start', actor: 'a')],
            nextCursor: null,
          ),
        ];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      store.clickActor('a');
      await pumpEventQueue();
      expect(store.events.value.events.map((e) => e.id), ['e1']);

      stream.meshCtrl.add(
        makeEvent('e1', 'run_start', actor: 'a'),
      ); // dup id → ignored
      stream.meshCtrl.add(
        makeEvent('x', 'run_start', actor: 'b'),
      ); // not selected → ignored
      stream.meshCtrl.add(
        makeEvent('e2', 'message_sent', actor: 'a'),
      ); // fresh → prepended
      await pumpEventQueue();

      expect(store.events.value.events.map((e) => e.id), ['e2', 'e1']);
      await store.dispose();
    },
  );

  test('events: kind filter excludes non-matching live frames', () async {
    final api = FakeApi()
      ..threadsResult = [makeThread('a', parent: 'root', created: 't1')]
      ..eventPages = [
        const EventPage(events: [], nextCursor: null),
        const EventPage(events: [], nextCursor: null),
      ];
    final stream = FakeStream();
    final store = await _booted(api, stream);

    store.clickActor('a');
    await pumpEventQueue();
    store.setKindFilter('message_sent');
    await pumpEventQueue();

    stream.meshCtrl.add(
      makeEvent('r1', 'run_start', actor: 'a'),
    ); // filtered out
    stream.meshCtrl.add(makeEvent('m1', 'message_sent', actor: 'a')); // kept
    await pumpEventQueue();

    expect(store.events.value.events.map((e) => e.id), ['m1']);
    await store.dispose();
  });

  test(
    'events: Load More appends the older page and clears hasMore at the end',
    () async {
      final api = FakeApi()
        ..threadsResult = [makeThread('a', parent: 'root', created: 't1')]
        ..eventPages = [
          EventPage(
            events: [makeEvent('e2', 'run_start', actor: 'a')],
            nextCursor: 10,
          ),
          EventPage(
            events: [makeEvent('e1', 'run_start', actor: 'a')],
            nextCursor: null,
          ),
        ];
      final store = await _booted(api, FakeStream());

      store.clickActor('a');
      await pumpEventQueue();
      expect(store.events.value.events.map((e) => e.id), ['e2']);
      expect(store.events.value.hasMore, true);

      await store.loadMoreEvents();
      await pumpEventQueue();
      expect(store.events.value.events.map((e) => e.id), ['e2', 'e1']);
      expect(store.events.value.hasMore, false);
      await store.dispose();
    },
  );

  test(
    'events: a live frame arriving mid-fetch on reset is not dropped (seam)',
    () async {
      final api = FakeApi()
        ..threadsResult = [makeThread('a', parent: 'root', created: 't1')];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      // Gate the events fetch so we can inject a live frame during the await.
      final gate = Completer<EventPage>();
      api.eventsGate = gate;

      store.clickActor('a'); // → _loadEvents(reset:true) awaits the gated fetch
      await pumpEventQueue();

      // A live mesh_event for the selected actor arrives mid-fetch.
      stream.meshCtrl.add(makeEvent('live1', 'message_sent', actor: 'a'));
      await pumpEventQueue();

      // The history page resolves WITHOUT that live event (recorded after the query).
      gate.complete(
        EventPage(
          events: [makeEvent('hist1', 'run_start', actor: 'a')],
          nextCursor: null,
        ),
      );
      await pumpEventQueue();

      // Both survive: live frame on top (newest-first), history beneath it.
      expect(store.events.value.events.map((e) => e.id), ['live1', 'hist1']);
      await store.dispose();
    },
  );

  test(
    'selection reconnects the SSE stream with the selected actors',
    () async {
      final api = FakeApi()
        ..threadsResult = [makeThread('a', parent: 'root', created: 't1')];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      expect(stream.connectCalls.first, isEmpty); // init() opens with no filter
      store.clickActor('a');
      await pumpEventQueue();
      expect(stream.connectCalls.last, ['a']);
      await store.dispose();
    },
  );

  test(
    'operatorChat: loads and updates on selection / live events / send',
    () async {
      final api = FakeApi()
        ..threadsResult = [makeThread('a', parent: 'root', created: 't1')]
        ..chatPages = [
          ChatPage(
            chat: [makeChat('e1')],
            nextCursor: null,
          ),
        ];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      // Initial select
      store.clickActor('a');
      await pumpEventQueue();
      expect(store.operatorChat.value.chat.map((e) => e.id), ['e1']);
      expect(api.chatActorCalls.last, containsAll(['a', 'human:operator']));

      // Live incoming messages
      // 1. human operator to actor
      stream.meshCtrl.add(
        makeEvent(
          'e2-event',
          'message_sent',
          actor: 'a',
          payload: '{"messageId":"e2","to":"human:operator"}',
        ),
      );
      // 2. actor to human operator (reply)
      stream.meshCtrl.add(
        makeEvent(
          'e3-event',
          'message_sent',
          actor: 'human:operator',
          payload: '{"messageId":"e3","to":"a"}',
        ),
      );
      // 3. non-matching message
      stream.meshCtrl.add(
        makeEvent('e4', 'message_sent', actor: 'b', peer: 'human:operator'),
      );
      await pumpEventQueue();

      expect(store.operatorChat.value.chat.map((e) => e.id), [
        'e3',
        'e2',
        'e1',
      ]);

      // Send chat message
      await store.sendOperatorChatMessage('hello actor');
      expect(api.chatSends.length, 1);
      expect(api.chatSends.first['actorId'], 'a');
      expect(api.chatSends.first['body'], 'hello actor');

      await store.dispose();
    },
  );

  test(
    'operatorChat: dedupes sent and received live echoes for one mesh_chat row',
    () async {
      final api = FakeApi()
        ..threadsResult = [makeThread('a', parent: 'root', created: 't1')];
      final stream = FakeStream();
      final store = await _booted(api, stream);

      store.clickActor('a');
      await pumpEventQueue();

      stream.meshCtrl.add(
        makeEvent(
          'sent-event',
          'message_sent',
          actor: 'human:operator',
          body: 'hello actor',
          payload: '{"messageId":"chat-1","to":"a"}',
        ),
      );
      stream.meshCtrl.add(
        makeEvent(
          'received-event',
          'message_received',
          actor: 'a',
          body: 'hello actor',
          payload: '{"messageId":"chat-1","from":"human:operator"}',
        ),
      );
      await pumpEventQueue();

      expect(store.operatorChat.value.chat.map((e) => e.id), ['chat-1']);

      await store.dispose();
    },
  );

  test('refreshQuota keeps the last-known snapshot visible and flips '
      'quotaRefreshing while a background revalidation is in flight '
      '(ISSUE_NUM ask 4)', () async {
    const firstSnapshot = QuotaSnapshotDto(generatedAt: 'first', providers: []);
    const secondSnapshot = QuotaSnapshotDto(
      generatedAt: 'second',
      providers: [],
    );
    final api = FakeApi()
      ..threadsResult = [makeThread('root', created: 't0')]
      ..quotaResult = firstSnapshot;
    final store = await _booted(api, FakeStream());

    expect(store.quota.value?.generatedAt, 'first');
    expect(store.quotaRefreshing.value, false);

    final gate = Completer<QuotaSnapshotDto>();
    api.quotaGate = gate;
    final refresh = store.refreshQuota();
    await pumpEventQueue();

    // The stale reading stays visible — this is the whole point of SWR —
    // but the refreshing flag flips on so the UI can dim/annotate it.
    expect(store.quota.value?.generatedAt, 'first');
    expect(store.quotaRefreshing.value, true);

    gate.complete(secondSnapshot);
    await refresh;

    expect(store.quota.value?.generatedAt, 'second');
    expect(store.quotaRefreshing.value, false);

    await store.dispose();
  });

  test(
    'seeds the quota subject from the persisted cache at construction, before '
    'any fetch — the 0ms first paint (ISSUE_NUM ask 4)',
    () async {
      const persisted = QuotaSnapshotDto(
        generatedAt: 'persisted',
        providers: [],
      );
      final store = DashboardStore(
        api: FakeApi(),
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(persisted),
      );

      // No init(), no fetch: the header reads store.quota.valueOrNull as its
      // StreamBuilder initialData, so a value present here paints immediately.
      expect(store.quota.value?.generatedAt, 'persisted');
      expect(store.quotaStale.value, true);

      await store.dispose();
    },
  );

  test(
    'persists each successful quota snapshot for the next cold load',
    () async {
      final cache = FakeQuotaCache();
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')]
        ..quotaResult = const QuotaSnapshotDto(
          generatedAt: 'fresh',
          providers: [],
        );
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: cache,
      );
      await store.init();
      await pumpEventQueue();

      expect(cache.stored?.generatedAt, 'fresh');
      expect(cache.saveCount, greaterThanOrEqualTo(1));

      await store.dispose();
    },
  );

  test(
    'serves the persisted snapshot immediately, then swaps in a fresh reading '
    'while preserving the restored scrapedAt verbatim (ISSUE_NUM ask 4/5)',
    () async {
      const persisted = QuotaSnapshotDto(
        generatedAt: 'persisted',
        providers: [
          ProviderQuotaDto(
            provider: 'claude',
            status: 'available',
            usedPercent: 12,
            tier: null,
            message: null,
            scrapedAt: '2026-07-14T09:15:00.000Z',
            windows: [
              QuotaWindowDto(
                id: 'weekly',
                label: 'Weekly',
                usedPercent: 12,
                status: 'available',
                headline: true,
                scrapedAt: '2026-07-14T09:15:00.000Z',
              ),
            ],
          ),
        ],
      );
      final cache = FakeQuotaCache(persisted);
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')]
        ..quotaResult = const QuotaSnapshotDto(
          generatedAt: 'fresh',
          providers: [],
        );
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: cache,
      );

      // Instant: the restored snapshot is visible with its ORIGINAL scrapedAt —
      // never restamped to boot/restore time (ISSUE_NUM ask 5).
      expect(store.quota.value?.generatedAt, 'persisted');
      expect(
        store.quota.value?.provider('claude')?.windows.first.scrapedAt,
        '2026-07-14T09:15:00.000Z',
      );
      expect(store.quotaStale.value, true);

      // A fresh reading swaps in behind it.
      await store.refreshQuota();
      expect(store.quota.value?.generatedAt, 'fresh');
      expect(store.quotaStale.value, false);

      await store.dispose();
    },
  );

  test('a 503 (no quota service bound) clears the persisted snapshot so a '
      'no-quota deployment does not resurrect stale rings', () async {
    final cache = FakeQuotaCache(
      const QuotaSnapshotDto(generatedAt: 'stale', providers: []),
    );
    final api = FakeApi()
      ..quotaError = DashboardApiException(
        Uri.parse('/api/quota'),
        503,
        'unavailable',
      );
    final store = DashboardStore(
      api: api,
      stream: FakeStream(),
      quotaCache: cache,
    );

    await store.refreshQuota();

    expect(cache.stored, isNull);
    expect(cache.clearCount, greaterThanOrEqualTo(1));
    expect(store.quotaStale.value, false);

    await store.dispose();
  });

  test(
    'a failed revalidation retains the snapshot and marks it stale without setting global error',
    () async {
      final api = FakeApi()
        ..quotaResult = const QuotaSnapshotDto(
          generatedAt: 'last-known',
          providers: [],
        );
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.refreshQuota();
      expect(store.quotaStale.value, false);

      api.quotaError = DashboardApiException(
        Uri.parse('/api/quota'),
        500,
        'probe failed',
      );
      await store.refreshQuota();

      expect(store.quota.value?.generatedAt, 'last-known');
      expect(store.quotaStale.value, true);
      // Quota revalidation failure must not pollute the global dashboard error bar 
      expect(store.error.value, isNull);

      // Network exception (e.g. timeout / connection closed) also marks stale and avoids global error bar
      api.quotaError = Exception('ClientException: XMLHttpRequest error.');
      await store.refreshQuota();
      expect(store.quotaStale.value, true);
      expect(store.error.value, isNull);

      await store.dispose();
    },
  );

  test('background quota polling refetches periodically without user '
      'interaction (ISSUE_NUM ask 4)', () {
    fakeAsync((async) {
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')]
        ..quotaResult = const QuotaSnapshotDto(
          generatedAt: 'snap',
          providers: [],
        );
      final store = DashboardStore(api: api, stream: FakeStream());
      unawaited(store.init());
      async.flushMicrotasks();

      expect(api.quotaCallCount, 1);

      async.elapse(const Duration(seconds: 60));
      expect(api.quotaCallCount, 2);

      async.elapse(const Duration(seconds: 60));
      expect(api.quotaCallCount, 3);

      unawaited(store.dispose());
      async.flushMicrotasks();
    });
  });

  test('refreshQuotaHistory keeps last-known history and flips '
      'quotaHistoryRefreshing while a background fetch is in flight', () async {
    const firstHistory = QuotaHistoryDto(
      generatedAt: 'first',
      historySince: '2026-07-01T00:00:00.000Z',
      history: [],
    );
    const secondHistory = QuotaHistoryDto(
      generatedAt: 'second',
      historySince: '2026-07-01T00:00:00.000Z',
      history: [],
    );
    final api = FakeApi()
      ..threadsResult = [makeThread('root', created: 't0')]
      ..quotaHistoryResult = firstHistory;
    final store = await _booted(api, FakeStream());

    expect(store.quotaHistory.value?.generatedAt, 'first');
    expect(store.quotaHistoryRefreshing.value, false);

    final gate = Completer<QuotaHistoryDto>();
    api.quotaHistoryGate = gate;
    final refresh = store.refreshQuotaHistory();
    await pumpEventQueue();

    expect(store.quotaHistory.value?.generatedAt, 'first');
    expect(store.quotaHistoryRefreshing.value, true);

    gate.complete(secondHistory);
    await refresh;

    expect(store.quotaHistory.value?.generatedAt, 'second');
    expect(store.quotaHistoryRefreshing.value, false);

    await store.dispose();
  });

  test('a 503 on quota history reports null and does not mark stale', () async {
    final api = FakeApi()
      ..quotaHistoryError = DashboardApiException(
        Uri.parse('/api/quota/history'),
        503,
        'unavailable',
      );
    final store = DashboardStore(api: api, stream: FakeStream());
    await store.refreshQuotaHistory();

    expect(store.quotaHistory.valueOrNull, isNull);
    expect(store.quotaHistoryStale.value, false);

    await store.dispose();
  });

  test('a failed history revalidation retains history and marks it stale without setting global error', () async {
    final api = FakeApi()
      ..quotaHistoryResult = const QuotaHistoryDto(
        generatedAt: 'last-known',
        historySince: '2026-07-01T00:00:00.000Z',
        history: [],
      );
    final store = DashboardStore(api: api, stream: FakeStream());
    await store.refreshQuotaHistory();
    expect(store.quotaHistoryStale.value, false);

    api.quotaHistoryError = DashboardApiException(
      Uri.parse('/api/quota/history'),
      500,
      'fetch failed',
    );
    await store.refreshQuotaHistory();

    expect(store.quotaHistory.value?.generatedAt, 'last-known');
    expect(store.quotaHistoryStale.value, true);
    expect(store.error.value, isNull);

    api.quotaHistoryError = Exception('Connection timeout');
    await store.refreshQuotaHistory();
    expect(store.quotaHistoryStale.value, true);
    expect(store.error.value, isNull);

    await store.dispose();
  });

  test('background quota history polling refetches every 5 minutes', () {
    fakeAsync((async) {
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')]
        ..quotaHistoryResult = const QuotaHistoryDto(
          generatedAt: 'hist',
          historySince: '2026-07-01T00:00:00.000Z',
          history: [],
        );
      final store = DashboardStore(api: api, stream: FakeStream());
      unawaited(store.init());
      async.flushMicrotasks();

      expect(api.quotaHistoryCallCount, 1);

      async.elapse(const Duration(minutes: 5));
      expect(api.quotaHistoryCallCount, 2);

      async.elapse(const Duration(minutes: 5));
      expect(api.quotaHistoryCallCount, 3);

      unawaited(store.dispose());
      async.flushMicrotasks();
    });
  });

  test('conversation: live SSE dedupes message_sent + message_received for the '
      'same messageId — each message renders exactly once ', () async {
    final api = FakeApi()
      ..threadsResult = [
        makeThread('a', parent: 'root', created: 't1'),
        makeThread('b', parent: 'root', created: 't2'),
      ]
      ..eventPages = [const EventPage(events: [], nextCursor: null)]
      ..chatPages = [const ChatPage(chat: [], nextCursor: null)];
    final stream = FakeStream();
    final store = await _booted(api, stream);

    // Select both actors to activate the 2-actor conversation-tab path.
    store.clickActor('a');
    store.toggleActor('b');
    await pumpEventQueue();

    // Feed the two events that one message emits: same messageId, distinct
    // event ids, and payloads that satisfy messageCounterparty checks.
    stream.meshCtrl.add(
      makeEvent(
        'sent-evt',
        'message_sent',
        actor: 'a',
        payload: '{"messageId":"msg-1","to":"b"}',
      ),
    );
    stream.meshCtrl.add(
      makeEvent(
        'received-evt',
        'message_received',
        actor: 'b',
        payload: '{"messageId":"msg-1","from":"a"}',
      ),
    );
    await pumpEventQueue();

    // After the fix: only message_sent passes the kind guard → length 1.
    // Without the fix: both events pass the event-id dedup → length 2.
    expect(store.conversation.value.chat.length, 1);
    expect(store.conversation.value.chat.first.id, 'msg-1');

    await store.dispose();
  });

  test('overview: yieldEvents captures history and live run_yielded SSE events', () async {
    final api = FakeApi()
      ..threadsResult = [makeThread('worker-1', parent: 'root', created: 't1')]
      ..eventPages = [
        EventPage(
          events: [
            makeEvent(
              'y1',
              'run_yielded',
              actor: 'worker-1',
              detail: 'complete',
              body: 'Finished charter task',
            ),
          ],
          nextCursor: null,
        ),
      ];
    final stream = FakeStream();
    final store = await _booted(api, stream);
    await store.refreshYieldEvents();

    expect(store.yieldEvents.value.length, 1);
    expect(store.yieldEvents.value.first.id, 'y1');

    stream.meshCtrl.add(
      makeEvent(
        'y2',
        'run_yielded',
        actor: 'worker-1',
        detail: 'blocked',
        body: 'Blocked on review',
      ),
    );
    await pumpEventQueue();

    expect(store.yieldEvents.value.length, 2);
    expect(store.yieldEvents.value.first.id, 'y2');
    expect(store.yieldEvents.value.first.detail, 'blocked');

    await store.dispose();
  });

  test('overview: yieldEvents populates even when threads are empty at init', () async {
    final api = FakeApi()
      ..threadsResult = []
      ..eventPages = [
        EventPage(
          events: [
            makeEvent(
              'y1',
              'run_yielded',
              actor: 'worker-1',
              detail: 'complete',
              body: 'Finished charter task',
            ),
          ],
          nextCursor: null,
        ),
      ];
    final stream = FakeStream();
    final store = await _booted(api, stream);
    await store.refreshYieldEvents();

    expect(store.yieldEvents.value.length, 1);
    expect(store.yieldEvents.value.first.id, 'y1');

    await store.dispose();
  });

  test('overview: refreshYieldEvents requests descending order and registers since parameter', () async {
    final api = FakeApi()
      ..threadsResult = []
      ..eventPages = [
        const EventPage(
          events: [],
          nextCursor: null,
        ),
      ];
    final stream = FakeStream();
    final store = await _booted(api, stream);
    await store.refreshYieldEvents();

    expect(api.eventSinceCalls.length, 1);
    expect(api.eventSinceCalls.first, isNotNull);
    expect(api.eventOrderCalls.length, 1);
    expect(api.eventOrderCalls.first, 'desc');

    await store.dispose();
  });
}
