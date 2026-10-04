// ignore_for_file: invalid_use_of_protected_member
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_tab.dart';
import 'fakes.dart';
import 'screenshot_support.dart';

void main() {
  setUpAll(loadFonts);
  for (final viewport in {'wide': const Size(1180, 820), 'narrow': const Size(390, 844)}.entries) {
    for (final state in ['current', 'reload']) {
      testWidgets('routed reply ${viewport.key} $state', (tester) async {
        final api = FakeApi()..threadsResult = [makeThread('origin', title: 'Original conversation'), makeThread('peer', title: 'Responding colleague')];
        if (state == 'reload') api.chatPages = [ChatPage(chat: [makeChat('routed-chat', sender: 'peer', body: 'Synthetic delayed completion: the requested fixture is repaired.')], nextCursor: null)];
        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);

        await store.init();
        store.clickActor('origin');
        await tester.pump();
        final key = GlobalKey();
        await tester.binding.setSurfaceSize(viewport.value);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(MaterialApp(debugShowCheckedModeBanner: false, theme: buildMeshTheme(),
          home: RepaintBoundary(key: key, child: Scaffold(body: ChatTab(store: store)))));
        await tester.pumpAndSettle();
        if (state == 'current') {
          stream.meshCtrl.add(makeEvent('routed-sent', 'message_sent', actor: 'peer', body: 'Synthetic delayed completion: the requested fixture is repaired.',
            payload: '{"messageId":"routed-chat","to":"human:operator","originalActorId":"origin","replyInput":{"actorId":"peer","entryId":"accepted"}}'));
          stream.meshCtrl.add(makeEvent('routed-received', 'message_received', actor: 'human:operator', body: 'Synthetic delayed completion: the requested fixture is repaired.',
            payload: '{"messageId":"routed-chat","from":"peer"}'));
          await tester.pumpAndSettle();
        }
        expect(store.operatorChat.value.chat.length, 1);
        expect(store.operatorChat.value.chat.single.senderId, 'peer');
        expect(find.textContaining('Synthetic delayed completion'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        void repaint(RenderObject object) {
          object.visitChildren(repaint);
          object.markNeedsPaint();
        }
        repaint(boundary);
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pumpAndSettle();
        void rebuildScene(Layer layer) {
          if (layer is ContainerLayer) {
            for (Layer? child = layer.firstChild; child != null; child = child.nextSibling) {
              rebuildScene(child);
            }
          }
          layer.engineLayer = null;
          if (!layer.alwaysNeedsAddToScene) layer.markNeedsAddToScene();
        }
        rebuildScene(boundary.layer!);
        final outDir = Platform.environment['RUSA_875_SCREENSHOTS'];
        if (outDir != null) {
          await tester.runAsync(
            () async {
              final image = boundary.toImageSync(pixelRatio: 2.0);
              final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
              final file = File('$outDir/${viewport.key}-$state.png')..createSync(recursive: true);
              file.writeAsBytesSync(bytes);
              image.dispose();
            },
          );
        }
        await tester.pumpWidget(const SizedBox.shrink());
        store.dispose();
        await tester.pump();
      });
    }
  }
}
