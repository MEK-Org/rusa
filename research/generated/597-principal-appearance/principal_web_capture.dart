import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/events_tab.dart';
import 'fakes.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  for (final family in ['Roboto', 'system-ui', 'monospace']) {
    final loader = FontLoader(family);
    loader.addFont(rootBundle.load('fonts/Roboto-Regular.ttf'));
    await loader.load();
  }
  SemanticsBinding.instance.ensureSemantics();
  final after = Uri.base.queryParameters['state'] == 'after';
  // Reserved synthetic UUID represents the repository-minted durable id.
  final principal = after
      ? '00000000-0000-4000-8000-000000000597'
      : 'human:operator';
  final api = FakeApi()
    ..dashboardConfigResult = DashboardConfigDto(
      quotaProviders: {}, userPrincipalId: after ? principal : null)
    ..threadsResult = [makeThread('fixture-actor')]
    ..eventPages = [EventPage(events: [
      makeEvent('fixture-control', 'root_control_action', actor: 'fixture-actor',
        detail: '$principal interrupt_child',
        payload: '{"principal":"$principal","action":"interrupt_child","targetId":"fixture-actor"}'),
      makeEvent('fixture-reply', 'message_sent', actor: 'fixture-actor',
        body: 'Synthetic local reply.', payload: '{"to":"$principal"}'),
      makeEvent('fixture-message', 'message_received', actor: 'fixture-actor',
        body: 'Synthetic local message.', payload: '{"from":"$principal"}'),
    ], nextCursor: null)];
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.refreshDashboardConfig();
  await store.refreshThreads();
  store.clickActor('fixture-actor');
  runApp(MaterialApp(debugShowCheckedModeBanner: false, theme: buildMeshTheme(),
    home: Scaffold(body: Column(crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(padding: const EdgeInsets.all(16), child: Row(children: [
          ActorAvatar(id: principal, size: 36, store: store),
          const SizedBox(width: 12),
          const Expanded(child: Text('Human avatar fallback — synthetic fixture')),
        ])),
        Expanded(child: EventsTab(store: store)),
      ]))));
}
