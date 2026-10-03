import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/events_tab.dart';
import 'fakes.dart';

class PromptApi extends FakeApi {
  final bool unavailable;
  PromptApi(this.unavailable);
  Future<Map<String, dynamic>?> fetchRunPrompt(String runId) async {
    if (unavailable) return null;
    return {
      'provider': 'antigravity',
      'prompt': '# Worker actor\n\nYou are a worker in a synthetic mesh.\n\n'
          '## Your charter\n\nRepair the sample test fixture and report the observed result.\n\n'
          '## Antigravity command discipline\n\nKeep each command within the synthetic workspace.\n',
    };
  }
}
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  for (final family in ['Roboto', 'system-ui', 'monospace']) {
    final loader = FontLoader(family);
    loader.addFont(rootBundle.load('fonts/Roboto-Regular.ttf'));
    await loader.load();
  }
  SemanticsBinding.instance.ensureSemantics();
  final api = PromptApi(Uri.base.queryParameters['unavailable'] == 'true')
    ..threadsResult = [makeThread('fixture-actor')]
    ..eventPages = [EventPage(events: [makeEvent('fixture-start', 'run_start',
      actor: 'fixture-actor',
      payload: '{"runId":"fixture-run","provider":"antigravity","model":"fixture-model"}')], nextCursor: null)];
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.refreshThreads();
  store.clickActor('fixture-actor');
  runApp(MaterialApp(debugShowCheckedModeBanner: false, theme: buildMeshTheme(),
    home: Scaffold(body: EventsTab(store: store))));
}
