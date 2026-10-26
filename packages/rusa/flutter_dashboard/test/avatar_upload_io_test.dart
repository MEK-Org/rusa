import 'dart:typed_data';

import 'package:file_selector_android/file_selector_android.dart';
// The host API's codec and reply types are what the Android plugin encodes;
// replying with them is how this test stands in for the native side.
// ignore: implementation_imports
import 'package:file_selector_android/src/file_selector_api.g.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rusa_dashboard/avatar_upload_io.dart';

const _openFile =
    'dev.flutter.pigeon.file_selector_android.FileSelectorApi.openFile';

final _png = Uint8List.fromList([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, //
]);

/// Answers the Android plugin's openFile channel the way the native side
/// would, recording the type filter it was asked for.
List<FileTypes> _answerOpenFile(FileResponse? reply) {
  final requests = <FileTypes>[];
  const codec = FileSelectorApi.pigeonChannelCodec;
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMessageHandler(_openFile, (message) async {
        final args = codec.decodeMessage(message)! as List<Object?>;
        requests.add(args[1]! as FileTypes);
        return codec.encodeMessage(<Object?>[reply]);
      });
  return requests;
}

FileResponse _response({String? mimeType, Uint8List? bytes}) {
  final data = bytes ?? _png;
  return FileResponse(
    path: 'content://synthetic/document/1',
    mimeType: mimeType,
    name: 'avatar.png',
    size: data.length,
    bytes: data,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Crosses the real Dart half of file_selector_android down to its platform
  // channel, so the picker is proven to ask Android for PNG documents only.
  setUp(FileSelectorAndroid.registerWith);

  test('picks a PNG document through the Android document picker', () async {
    final requests = _answerOpenFile(_response(mimeType: 'image/png'));

    final picked = await const IoAvatarFilePicker().pickImage();

    expect(picked!.bytes, _png);
    expect(picked.contentType, 'image/png');
    expect(requests.single.mimeTypes, ['image/png']);
  });

  test('a cancelled pick returns null', () async {
    _answerOpenFile(null);

    expect(await const IoAvatarFilePicker().pickImage(), isNull);
  });

  test('a provider reporting no type is typed by the PNG signature', () async {
    _answerOpenFile(_response());
    expect(
      (await const IoAvatarFilePicker().pickImage())!.contentType,
      'image/png',
    );

    _answerOpenFile(_response(bytes: Uint8List.fromList([0xff, 0xd8, 0xff])));
    expect((await const IoAvatarFilePicker().pickImage())!.contentType, '');
  });
}
