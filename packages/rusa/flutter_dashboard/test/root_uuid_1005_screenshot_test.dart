import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'fakes.dart';
import 'screenshot_support.dart';

const _uuid = 'f42e93fb-94c7-4c2a-bb16-7161b3a9d346';
const _handle = 'ember-familiar';
const _charter = 'Maintain the synthetic fixture mesh.';

void main() {
  setUpAll(loadFonts);
  for (final phase in ['before', 'after']) {
    for (final mobile in [false, true]) {
      testWidgets('root UUID $phase ${mobile ? "phone" : "wide"}', (
        tester,
      ) async {
        await tester.runAsync(() async {
          final id = phase == 'before' ? 'root' : _uuid;
          final ids = [id, '11111111-1111-4111-8111-111111111111'];
          HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
          addTearDown(() => HttpOverrides.global = null);
          tester.view
            ..physicalSize = mobile
                ? const Size(390, 844)
                : const Size(1360, 840)
            ..devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          final api = FakeApi()
            ..threadsResult = [
              ThreadDto(
                id: id,
                handle: _handle,
                parentId: null,
                status: 'active',
                provider: 'codex',
                model: 'gpt-6.1-sol',
                charterPreview: _charter,
                title: _charter,
                createdAt: '2026-01-01T00:00:00Z',
                runState: RunState.idle,
              ),
              makeThread(ids[1], parent: id),
            ]
            ..charters[id] = _charter;
          final store = DashboardStore(api: api, stream: FakeStream());
          addTearDown(store.dispose);
          await store.init();
          store.clickActor(id);
          final key = GlobalKey();
          final detail = DetailPanel(store: store, narrow: mobile);
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: Scaffold(
                body: RepaintBoundary(
                  key: key,
                  child: mobile
                      ? Column(
                          children: [
                            MeshHeader(
                              store: store,
                              selected: DashboardView.actors,
                              detailActor: api.threadsResult.first,
                              onBack: () {},
                              onSelect: (_) {},
                            ),
                            Expanded(child: detail),
                          ],
                        )
                      : Row(
                          children: [
                            SizedBox(
                              width: 320,
                              child: ActorTree(store: store),
                            ),
                            Expanded(child: detail),
                          ],
                        ),
                ),
              ),
            ),
          );
          await settleImages(tester, portraitUrls(ids));
          await tester.tap(find.text('Info'));
          for (var i = 0; i < 10; i++) {
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(find.text(_handle), findsWidgets);
          if (!mobile) expect(find.text(id), findsWidgets);
          expect(find.text('Charter'), findsOneWidget);
          await captureBoundary(
            key,
            '${Directory.current.path}/screenshots/1005_root_uuid_${mobile ? "phone" : "wide"}_$phase.png',
          );
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
        });
      });
    }
  }
}
