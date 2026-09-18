import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';

import 'fakes.dart';

const puck = VoiceConfigDto(provider: 'google', config: {'voiceName': 'Puck'});
const christopher = VoiceConfigDto(
  provider: 'elevenlabs',
  config: {'voiceId': 'synthetic-voice-id-1'},
);
// The UI must pass an unfamiliar provider's document through without special fields.
const futureVoice = VoiceConfigDto(
  provider: 'future',
  config: {
    'speaker': 'one',
    'settings': {'style': 'warm'},
  },
);

Widget _harness(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: Row(
      children: [
        ActorTree(store: store),
        Expanded(child: DetailPanel(store: store)),
      ],
    ),
  ),
);

Future<void> _openInfo(WidgetTester tester) async {
  await tester.tap(find.text('worker-handle'));
  await tester.pump(const Duration(milliseconds: 50));
  await tester.ensureVisible(find.text('Info'));
  await tester.tap(find.text('Info'));
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  test(
    'voice documents round-trip through one API for all providers and null',
    () async {
      final bodies = <Object?>[];
      final api = DashboardApi(
        base: Uri.parse('http://localhost:3000'),
        client: MockClient((request) async {
          expect(request.method, 'PATCH');
          expect(request.url.path, '/api/mesh/actors/worker/voice');
          final body = jsonDecode(request.body);
          bodies.add(body);
          return http.Response(jsonEncode(body), 200);
        }),
      );
      for (final voice in [puck, christopher, futureVoice, null]) {
        expect(await api.updateActorVoice('worker', voice), voice);
      }
      expect(bodies, [
        for (final voice in [puck, christopher, futureVoice, null])
          {'voiceConfig': voice?.toJson()},
      ]);
    },
  );

  test(
    'catalog decoding and selection identity do not depend on provider or key ordering',
    () {
      final voice = SupportedVoiceDto.fromJson({
        'label': 'New voice',
        'providerLabel': 'New provider',
        'voiceConfig': futureVoice.toJson(),
      });
      expect(voice.displayLabel, 'New voice (New provider)');
      expect(
        voice.voiceConfig,
        const VoiceConfigDto(
          provider: 'future',
          config: {
            'settings': {'style': 'warm'},
            'speaker': 'one',
          },
        ),
      );
      expect(SupportedVoiceDto.fromJson('Puck').voiceConfig, puck);
    },
  );

  testWidgets(
    'bordered picker selects mixed providers with generic labels and restores the default',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..supportedVoices = const [
            SupportedVoiceDto(
              label: 'Puck',
              providerLabel: 'Gemini',
              voiceConfig: puck,
            ),
            SupportedVoiceDto(
              label: 'Christopher',
              providerLabel: 'Elevenlabs',
              voiceConfig: christopher,
            ),
            SupportedVoiceDto(
              label: 'New voice',
              providerLabel: 'New provider',
              voiceConfig: futureVoice,
            ),
          ]
          ..threadsResult = [
            makeThread('root', created: 't0'),
            makeThread('worker', parent: 'root', created: 't1'),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await tester.pumpWidget(_harness(store));
        await _openInfo(tester);
        final field = tester.widget<InputDecorator>(
          find.byKey(const ValueKey('voice-selector-field')),
        );
        expect(field.decoration.enabledBorder, isA<OutlineInputBorder>());
        expect(field.decoration.filled, isTrue);
        for (final choice in <(String, VoiceConfigDto?)>[
          ('Puck (Gemini)', puck),
          ('Christopher (Elevenlabs)', christopher),
          ('New voice (New provider)', futureVoice),
          ('Instance default (Gemini)', null),
        ]) {
          await tester.tap(find.byType(DropdownButton<VoiceConfigDto?>));
          await tester.pump(const Duration(milliseconds: 100));
          await tester.tap(find.text(choice.$1).last);
          for (var i = 0; i < 5; i++) {
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(api.actorVoiceUpdates.last, (
            actorId: 'worker',
            voiceConfig: choice.$2,
          ));
          expect(
            tester
                .widget<DropdownButton<VoiceConfigDto?>>(
                  find.byType(DropdownButton<VoiceConfigDto?>),
                )
                .value,
            choice.$2,
          );
        }
        await store.dispose();
      });
    },
  );
}
