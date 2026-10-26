import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'io_session_client.dart';

/// Keystore-backed persistence for the server cookies that Android otherwise
/// loses at process death. Values are scoped to the full configured origin;
/// an HTTPS production server and a local development server never share one.
///
/// Versioning makes the stored shape explicit. Malformed or unknown records
/// are discarded rather than treated as a live session.
class SecureIoSessionCredentialStorage implements IoSessionCredentialStorage {
  SecureIoSessionCredentialStorage({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _version = 1;
  static const _prefix = 'rusa.io.session.';

  final FlutterSecureStorage _storage;

  @override
  Future<IoSessionCredentials?> read(Uri origin) async {
    final value = await _storage.read(key: _key(origin));
    if (value == null) return null;
    try {
      final decoded = jsonDecode(value);
      if (decoded is! Map<String, dynamic> ||
          decoded['version'] != _version ||
          decoded['origin'] != _origin(origin)) {
        await delete(origin);
        return null;
      }
      final sessionCookie = decoded['sessionCookie'];
      final csrfToken = decoded['csrfToken'];
      if (sessionCookie is! String && csrfToken is! String) {
        await delete(origin);
        return null;
      }
      return IoSessionCredentials(
        sessionCookie: sessionCookie as String?,
        csrfToken: csrfToken as String?,
      );
    } catch (_) {
      await delete(origin);
      return null;
    }
  }

  @override
  Future<void> write(Uri origin, IoSessionCredentials credentials) =>
      _storage.write(
        key: _key(origin),
        value: jsonEncode({
          'version': _version,
          'origin': _origin(origin),
          'sessionCookie': credentials.sessionCookie,
          'csrfToken': credentials.csrfToken,
        }),
      );

  @override
  Future<void> delete(Uri origin) => _storage.delete(key: _key(origin));

  String _key(Uri origin) =>
      '$_prefix${base64Url.encode(utf8.encode(_origin(origin)))}';

  String _origin(Uri uri) => uri.origin;
}
