import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/chat_tab.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';
import 'package:rusa_dashboard/widgets/status_dot.dart';

import 'fakes.dart';

Widget _harness(Widget child) => MaterialApp(
  home: Scaffold(body: child),
);

class _InboxTestApi extends FakeApi {
  @override
  Future<Map<String, dynamic>> fetchInbox(
    String actorId, {
    String status = 'all',
    int limit = 20,
  }) async {
    if (status == 'unhandled') {
      return {
        'entries': [
          {
            'id': 'inbox-unhandled',
            'actorId': 'root',
            'source': 'mesh:human:operator',
            'deliveredAt': '2026-08-19T10:00:00Z',
            'handledAt': null,
            'payload': {
              'type': 'human.message',
              'content': 'Unresolved signal',
            },
          },
        ],
      };
    } else if (status == 'handled') {
      return {
        'entries': [
          {
            'id': 'inbox-handled',
            'actorId': 'root',
            'source': 'mesh:human:operator',
            'deliveredAt': '2026-08-19T09:00:00Z',
            'handledAt': '2026-08-19T09:05:00Z',
            'handledNote': 'Resolved successfully',
            'payload': {
              'type': 'human.message',
              'content': 'Resolved signal',
            },
          },
        ],
      };
    }
    return {'entries': []};
  }
}

void main() {
  group('Actor detail pane status indicator and quick actions', () {
    testWidgets('shows status dot indicator on avatar and Run Now for idle actor', (tester) async {
      await tester.runAsync(() async {
        final thread = makeThread('actor-1', status: 'active');
        final api = FakeApi()..threadsResult = [thread];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.clickActor('actor-1');

        await tester.pumpWidget(_harness(DetailPanel(store: store)));
        await tester.pump(const Duration(milliseconds: 50));

        // StatusDot on top of avatar
        expect(find.byType(StatusDot), findsWidgets);

        // Run now button for idle actor
        final runNowBtn = find.byTooltip('Run now');
        expect(runNowBtn, findsOneWidget);

        await tester.tap(runNowBtn);
        await tester.pump(const Duration(milliseconds: 50));

        expect(api.runNowCalls, contains('actor-1'));

        await store.dispose();
      });
    });

    testWidgets('shows Interrupt button for active/running actor', (tester) async {
      await tester.runAsync(() async {
        final thread = makeThread('actor-2', status: 'active', runState: RunState.running);
        final api = FakeApi()..threadsResult = [thread];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.clickActor('actor-2');

        await tester.pumpWidget(_harness(DetailPanel(store: store)));
        await tester.pump(const Duration(milliseconds: 50));

        final interruptBtn = find.byTooltip('Interrupt');
        expect(interruptBtn, findsOneWidget);

        await tester.tap(interruptBtn);
        await tester.pump(const Duration(milliseconds: 50));

        expect(api.interruptCalls.map((c) => c.actorId), contains('actor-2'));

        await store.dispose();
      });
    });

    testWidgets('shows Run now and Cancel queued run for queued actor', (tester) async {
      await tester.runAsync(() async {
        final thread = makeThread('actor-3', status: 'active', runState: RunState.queued);
        final api = FakeApi()..threadsResult = [thread];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.clickActor('actor-3');

        await tester.pumpWidget(_harness(DetailPanel(store: store)));
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byTooltip('Run now'), findsOneWidget);
        expect(find.byTooltip('Cancel queued run'), findsOneWidget);

        await tester.tap(find.byTooltip('Cancel queued run'));
        await tester.pump(const Duration(milliseconds: 50));

        expect(api.interruptCalls.map((c) => c.actorId), contains('actor-3'));

        await store.dispose();
      });
    });
  });

  group('Inbox view arrived and handled timestamps', () {
    testWidgets('renders Arrived and Handled timestamps', (tester) async {
      await tester.runAsync(() async {
        final api = _InboxTestApi()
          ..threadsResult = [makeThread('root')];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_harness(InboxTab(store: store, actorId: 'root')));
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.textContaining('Arrived:'), findsNWidgets(2));
        expect(find.textContaining('Handled:'), findsOneWidget);
        expect(find.textContaining('Resolved successfully', findRichText: true), findsOneWidget);

        await store.dispose();
      });
    });
  });

  group('Chat UI multiline textbox and keyboard shortcuts', () {
    testWidgets('configures multiline text input and handles Enter vs Shift+Enter', (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('actor-1')]
          ..chatPages = [const ChatPage(chat: [], nextCursor: null)];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.clickActor('actor-1');

        await tester.pumpWidget(_harness(ChatTab(store: store)));
        await tester.pump(const Duration(milliseconds: 50));

        final textFieldFinder = find.byType(TextField);
        expect(textFieldFinder, findsOneWidget);

        final TextField textField = tester.widget(textFieldFinder);
        expect(textField.minLines, 1);
        expect(textField.maxLines, 5);
        expect(textField.keyboardType, TextInputType.multiline);
        expect(textField.textInputAction, TextInputAction.newline);

        // Enter text
        await tester.enterText(textFieldFinder, 'Hello world');
        await tester.pump();

        // Shift + Enter should NOT send
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.pump(const Duration(milliseconds: 50));

        // Still contains text
        final fieldStateAfterShift = tester.widget<TextField>(textFieldFinder);
        expect(fieldStateAfterShift.controller!.text, 'Hello world');

        // Plain Enter should send
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 50));

        // Field cleared after send
        final fieldStateAfterSend = tester.widget<TextField>(textFieldFinder);
        expect(fieldStateAfterSend.controller!.text, '');

        await store.dispose();
      });
    });
  });
}
