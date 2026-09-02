import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'avatar_platform.dart';

/// Browser implementation of the `avatar_platform.dart` seam : opens a
/// native `<input type=file>` dialog scoped to PNG (the cache/serve path is
/// PNG-only — see `avatars.ts`'s `uploadAvatar`), and reads the picked file's
/// bytes via `Blob.arrayBuffer()`. Imported only from `main.dart` (the web
/// entrypoint) — everything else stays headless-testable.
class WebAvatarFilePicker implements AvatarFilePicker {
  @override
  Future<PickedAvatarImage?> pickImage() {
    final input = web.HTMLInputElement()
      ..type = 'file'
      ..accept = 'image/png';
    final completer = Completer<PickedAvatarImage?>();

    input.addEventListener(
      'change',
      (web.Event _) {
        final files = input.files;
        final file = (files == null || files.length == 0) ? null : files.item(0);
        if (file == null) {
          if (!completer.isCompleted) completer.complete(null);
          return;
        }
        file.arrayBuffer().toDart.then(
          (buffer) {
            if (!completer.isCompleted) {
              completer.complete(
                PickedAvatarImage(
                  bytes: buffer.toDart.asUint8List(),
                  contentType: file.type,
                ),
              );
            }
          },
          onError: (Object e) {
            if (!completer.isCompleted) completer.completeError(e);
          },
        );
      }.toJS,
    );
    // Modern browsers (Chrome 113+, Firefox) fire 'cancel' when the dialog
    // closes without a selection, so a cancelled pick resolves to null
    // instead of hanging the caller's await forever.
    input.addEventListener(
      'cancel',
      (web.Event _) {
        if (!completer.isCompleted) completer.complete(null);
      }.toJS,
    );
    input.click();
    return completer.future;
  }
}
