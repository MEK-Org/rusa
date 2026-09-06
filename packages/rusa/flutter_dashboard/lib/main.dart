import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import 'api.dart';
import 'avatar_upload_web.dart';
import 'dashboard_title.dart';
import 'iu/iu_reports_view.dart';
import 'iu/iu_tree_view.dart';
import 'sse.dart';
import 'store.dart';
import 'theme.dart';
import 'voice_web.dart';
import 'web_actor_hierarchy_cache.dart';
import 'web_quota_cache.dart';
import 'web_tree_preferences_cache.dart';
import 'widgets/dashboard_body.dart';

/// The live actor-mesh viewer dashboard (an issue). Reads the PR2 Data API +
/// SSE stream and renders the locked V1.4.0 design: an alive-actor tree on the
/// left and the selected actor's Events / Live Output on the right.
void main() {
  // Read the served shell's title before the first frame — see
  // `dashboard_title.dart` for why MaterialApp would otherwise overwrite it.
  runApp(RusaDashboardApp(title: resolveDashboardTitle(web.document.title)));
}

class RusaDashboardApp extends StatelessWidget {
  const RusaDashboardApp({super.key, this.title = defaultDashboardTitle});

  /// Browser tab title; the served `index.html`'s, branded with this instance's
  /// configured root actor name when one is set.
  final String title;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: title,
      debugShowCheckedModeBanner: false,
      theme: buildMeshTheme(),
      home: const DashboardPage(),
    );
  }
}

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  late final DashboardApi _api;
  late final DashboardStore _store;

  @override
  void initState() {
    super.initState();
    _api = DashboardApi();
    _store = DashboardStore(
      api: _api,
      stream: WebEventSourceStream(),
      quotaCache: WebQuotaCache(),
      treePreferencesCache: WebTreePreferencesCache(),
      actorHierarchyCache: WebActorHierarchyCache(),
      walkie: webWalkieDeps(_api),
      avatarFilePicker: WebAvatarFilePicker(),
    );
    // Opens the SSE stream before the initial /threads fetch (seam-safe).
    _store.init();
  }

  @override
  void dispose() {
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: Column(
        children: [
          // The header nav (inside DashboardBody) switches between the Actors
          // dashboard and the IU route; within IU, its own switch picks the
          // node or the report sub-view . Both IU bodies are injected
          // here — the web entrypoint — so DashboardBody stays free of the
          // web-only glass-goals imports and renders headlessly in the
          // screenshot harness.
          Expanded(
            child: DashboardBody(
              store: _store,
              understandingBuilder: (_) => const IuTreeBody(),
              reportsBuilder: (_) => IuReportsBody(store: _store),
            ),
          ),
          _ErrorBar(store: _store),
        ],
      ),
    );
  }
}

/// A thin footer that surfaces the latest API/stream error, if any.
class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.store});
  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < kNarrowBreakpoint) {
      return const SizedBox.shrink();
    }
    return StreamBuilder<String?>(
      stream: store.error,
      builder: (_, snap) {
        final err = snap.data;
        if (err == null) return const SizedBox.shrink();
        return Container(
          width: double.infinity,
          color: const Color(0x33EF4444),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Text(
            err,
            style: const TextStyle(color: Color(0xFFEF4444), fontSize: 12),
          ),
        );
      },
    );
  }
}
