import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';

import 'avatar_platform.dart';

/// Device implementation of the `avatar_platform.dart` seam: the system
/// document picker (Android's `ACTION_OPEN_DOCUMENT`, via `file_selector`),
/// restricted to PNG as the browser's `accept` is, since the cache/serve path
/// is PNG-only. Imported only from the IO bootstrap.
class IoAvatarFilePicker implements AvatarFilePicker {
  const IoAvatarFilePicker();

  static const _png = XTypeGroup(
    label: 'PNG',
    extensions: ['png'],
    mimeTypes: ['image/png'],
  );

  @override
  Future<PickedAvatarImage?> pickImage() async {
    final file = await openFile(acceptedTypeGroups: const [_png]);
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    return PickedAvatarImage(
      bytes: bytes,
      // A document provider may report no type; the store still rejects
      // non-PNG and the server re-verifies the signature either way.
      contentType: file.mimeType ?? (_isPng(bytes) ? 'image/png' : ''),
    );
  }
}

const _pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

bool _isPng(Uint8List bytes) {
  if (bytes.length < _pngSignature.length) return false;
  for (var i = 0; i < _pngSignature.length; i++) {
    if (bytes[i] != _pngSignature[i]) return false;
  }
  return true;
}
