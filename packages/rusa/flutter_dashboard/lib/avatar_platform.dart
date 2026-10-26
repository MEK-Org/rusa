import 'dart:typed_data';

/// Seam for picking a local image file to upload as an avatar . The
/// real implementation is `WebAvatarFilePicker` (browser `<input type=file>`,
/// in `avatar_upload_web.dart`); `DashboardStore` depends only on this
/// interface so it — and its headless tests — never import the web-only
/// `package:web`, mirroring the `QuotaCache`/`WalkieDeps` platform splits.
abstract interface class AvatarFilePicker {
  /// Opens the platform file picker restricted to PNG/JPEG images. Returns
  /// null if the user cancels rather than picks a file.
  Future<PickedAvatarImage?> pickImage();
}

/// A picked image's raw bytes plus the browser-reported MIME type, ready to
/// hand to `DashboardApi.uploadAvatar` after base64-encoding.
class PickedAvatarImage {
  const PickedAvatarImage({required this.bytes, required this.contentType});

  final Uint8List bytes;
  final String contentType;
}
