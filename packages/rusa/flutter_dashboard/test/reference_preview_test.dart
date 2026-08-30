import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child)));

void main() {
  group('ReferenceDto', () {
    test('parses a resolved reference', () {
      final dto = ReferenceDto.fromJson(const {
        'ref': 'mesh:messages/abc',
        'scheme': 'mesh',
        'title': 'human:operator → root',
        'body': 'A monster-catching JRPG in a cave.',
        'author': 'human:operator',
        'timestamp': '2026-08-30T12:00:00.000Z',
        'url': null,
        'unavailable': null,
      });

      expect(dto.isResolved, true);
      expect(dto.body, 'A monster-catching JRPG in a cave.');
    });

    test('an unresolvable reference is not the same as an empty one', () {
      final dto = ReferenceDto.fromJson(const {
        'ref': 'github:MEK-Org/rusa/issues/33',
        'scheme': 'github',
        'title': 'github:MEK-Org/rusa/issues/33',
        'unavailable': 'tracker not configured',
      });

      expect(dto.isResolved, false);
      expect(dto.unavailable, 'tracker not configured');
    });
  });

  group('ObligationArtifactDto', () {
    test('reads the server shape of artifact plus resolved reference', () {
      final dto = ObligationArtifactDto.fromJson(const {
        'artifact': {
          'ref': 'mesh:messages/abc',
          'label': "Operator's opening ask",
          'attachedBy': 'root',
          'attachedAt': '2026-08-30T12:00:00.000Z',
        },
        'reference': {
          'ref': 'mesh:messages/abc',
          'scheme': 'mesh',
          'title': 'human:operator → root',
          'body': 'the answer',
        },
      });

      expect(dto.ref, 'mesh:messages/abc');
      expect(dto.label, "Operator's opening ask");
      expect(dto.reference?.body, 'the answer');
    });

    test('tolerates an artifact whose reference could not be resolved', () {
      final dto = ObligationArtifactDto.fromJson(const {
        'artifact': {'ref': 'github:MEK-Org/rusa/issues/33'},
        'reference': null,
      });

      expect(dto.ref, 'github:MEK-Org/rusa/issues/33');
      expect(dto.reference, isNull);
    });
  });

  group('ReferencePreview', () {
    testWidgets('shows the cited text and its provenance', (tester) async {
      await tester.pumpWidget(_host(const ReferencePreview(
        reference: ReferenceDto(
          ref: 'mesh:messages/abc',
          scheme: 'mesh',
          title: 'human:operator → root',
          body: 'A monster-catching JRPG in a cave.',
          author: 'human:operator',
        ),
        label: "Operator's answer",
        attachedBy: 'root',
      )));

      expect(find.text('MESH'), findsOneWidget);
      expect(find.text('human:operator → root'), findsOneWidget);
      expect(find.text('A monster-catching JRPG in a cave.'), findsOneWidget);
      expect(find.text("Operator's answer"), findsOneWidget);
      expect(find.text('cited by root'), findsOneWidget);
      // The ref itself stays visible and selectable — a citation you cannot
      // copy is a citation you cannot chase.
      expect(find.text('mesh:messages/abc'), findsOneWidget);
    });

    testWidgets('is only as tall as the text it quotes', (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      Future<double> heightOf(String body) async {
        await tester.pumpWidget(MaterialApp(
          home: Scaffold(
            body: ListView(children: [
              ReferencePreview(
                reference: ReferenceDto(
                  ref: 'mesh:messages/abc',
                  scheme: 'mesh',
                  title: 'human:operator → root',
                  body: body,
                ),
              ),
            ]),
          ),
        ));
        await tester.pumpAndSettle();
        return tester.getSize(find.byType(SelectableText).first).height;
      }

      final oneLine = await heightOf('Can you help me plan it out?');
      final fourLines = await heightOf(List.filled(4, 'line').join('\n'));

      // Regression guard. SelectableText wraps an EditableText, which sizes to
      // `maxLines` rather than to its content — passing one made a single-line
      // citation render eight lines tall. Height must track the text.
      expect(oneLine, lessThan(30));
      expect(fourLines, greaterThan(oneLine * 3));
    });

    testWidgets('says why it could not expand, rather than showing nothing', (tester) async {
      await tester.pumpWidget(_host(const ReferencePreview(
        reference: ReferenceDto(
          ref: 'github:MEK-Org/rusa/issues/33',
          scheme: 'github',
          title: 'github:MEK-Org/rusa/issues/33',
          unavailable: 'Not resolvable yet — only mesh chat is read back so far.',
        ),
      )));

      expect(find.text('GITHUB'), findsOneWidget);
      expect(
        find.text('Not resolvable yet — only mesh chat is read back so far.'),
        findsOneWidget,
      );
      expect(find.text('No attached contents.'), findsNothing);
    });
  });
}
