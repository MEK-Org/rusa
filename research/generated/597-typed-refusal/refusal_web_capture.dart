import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_tab.dart';
import 'fakes.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  for (final family in ['Roboto', 'system-ui', 'monospace']) {
    final loader = FontLoader(family);
    loader.addFont(rootBundle.load('fonts/Roboto-Regular.ttf'));
    await loader.load();
  }
  SemanticsBinding.instance.ensureSemantics();
  final api = FakeApi()
    ..dashboardConfigResult = const DashboardConfigDto(
      quotaProviders: {}, userPrincipalId: '00000000-0000-4000-8000-000000000597')
    ..threadsResult = [makeThread('synthetic-actor', title: 'Synthetic actor')]
    ..onSendChatMessage = (actor, body, session) async {
      throw DashboardApiException(Uri.parse('/api/mesh/actors/$actor/chat'), 409,
        '{"error":"voice session is held by a different principal"}');
    };
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.refreshDashboardConfig();
  await store.refreshThreads();
  store.clickActor('synthetic-actor');
  runApp(MaterialApp(debugShowCheckedModeBanner: false, theme: buildMeshTheme(),
    home: Scaffold(appBar: AppBar(title: const Text('Synthetic typed chat refusal')),
      body: ChatTab(store: store))));
}
