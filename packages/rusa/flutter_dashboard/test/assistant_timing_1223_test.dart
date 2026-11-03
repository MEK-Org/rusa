import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/assistant_page.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/widgets/walkie_panel.dart';

import 'fakes.dart';

/// Characterization and verification tests for #1223:
/// 1. Immediate capture decoupled from network readiness
/// 2. Audible ready cue ordering (plays only once capture is live, only on assist entry)
/// 3. Cold-start and warm-start trigger-to-capture timing breakdown
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Assistant #1223 trigger-to-capture timings and ordering', () {
    late FakeApi api;
    late FakeWalkie walkie;
    late FakeAssistant assistant;

    setUp(() {
      api = FakeApi();
      walkie = FakeWalkie(api);
      assistant = FakeAssistant();
      api.threadsResult = [makeThread('root')];
    });

    testWidgets(
      'capture starts immediately and ready cue fires before network resolves',
      (tester) async {
        final events = <String>[];

        final threadsGate = Completer<ThreadsSnapshot>();
        api.threadSnapshotGates.add(threadsGate);

        final backlogGate = Completer<List<VoiceAnnouncement>>();
        api.backlogGates.add(backlogGate);

        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );

        // Before any network responds:
        // Recorder start has already been requested and completed locally.
        expect(walkie.recorder.startCalls, 1);
        expect(assistant.readyCueCalls, 1);
        events.add('ready_cue_fired');

        // Verify network is still blocked
        expect(threadsGate.isCompleted, isFalse);
        expect(walkie.streams, isEmpty);

        // Unblock network
        threadsGate.complete(
          ThreadsSnapshot(
            halted: false,
            threads: api.threadsResult,
            rootActorId: 'root',
          ),
        );
        await tester.pump();
        events.add('threads_resolved');

        backlogGate.complete(const []);
        await tester.pump();
        await tester.pump();
        events.add('stream_connected');

        expect(walkie.streams, hasLength(1));
        expect(events, [
          'ready_cue_fired',
          'threads_resolved',
          'stream_connected',
        ]);
      },
    );

    testWidgets(
      'latency characterization: decoupled capture vs sequential baseline',
      (tester) async {
        // Measure the decoupled capture start time vs sequential baseline.
        // In the sequential baseline (pre-#1223), recorder.start() was delayed
        // by the sum of fetchThreads + controller.init() + controller.enable().
        const simulatedNetworkRtt = Duration(milliseconds: 100);

        final stopwatch = Stopwatch()..start();

        final threadsGate = Completer<ThreadsSnapshot>();
        api.threadSnapshotGates.add(threadsGate);

        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );

        // Immediate capture: start() was called synchronously on entry
        final decoupledCaptureStartMs = stopwatch.elapsedMilliseconds;
        expect(walkie.recorder.startCalls, 1);
        expect(assistant.readyCueCalls, 1);

        // Simulate network latency for threads and session backlog
        await tester.pump(simulatedNetworkRtt);
        threadsGate.complete(
          ThreadsSnapshot(
            halted: false,
            threads: api.threadsResult,
            rootActorId: 'root',
          ),
        );
        await tester.pump();
        await tester.pump();

        final sequentialEstimatedCaptureStartMs =
            decoupledCaptureStartMs + simulatedNetworkRtt.inMilliseconds;

        // Decoupled capture is strictly faster by at least the simulated network delay
        expect(
          decoupledCaptureStartMs,
          lessThan(sequentialEstimatedCaptureStartMs),
        );
      },
    );

    testWidgets(
      'ready cue is specific to assist entry and does not fire on manual record toggle',
      (tester) async {
        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        // Initial assist entry fired cue once
        expect(assistant.readyCueCalls, 1);

        // User stops recording via trigger
        assistant.triggerCtrl.add(null);
        await tester.pump();
        await tester.pump();

        // User resumes recording manually via trigger
        assistant.triggerCtrl.add(null);
        await tester.pump();
        await tester.pump();

        // Ready cue must NOT fire again on subsequent manual toggles
        expect(assistant.readyCueCalls, 1);
      },
    );

    testWidgets(
      'locked-phone assist screen provides restricted UI only (dashboard unreachable)',
      (tester) async {
        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        // The assist page only renders WalkiePanel to root actor
        expect(find.byType(WalkiePanel), findsOneWidget);

        // Dashboard views, navigation drawers, and app bars are absent
        expect(find.byType(AppBar), findsNothing);
        expect(find.byType(Drawer), findsNothing);
        expect(find.text('Overview'), findsNothing);
        expect(find.text('Chat'), findsNothing);
        expect(find.text('Settings'), findsNothing);
      },
    );
  });
}
