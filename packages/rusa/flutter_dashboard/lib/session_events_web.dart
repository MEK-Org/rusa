import 'dart:js_interop';
import 'package:web/web.dart' as web;

void requireAuthentication() =>
    web.window.dispatchEvent(web.Event('rusa-auth-required'));
void notifyNavigation() =>
    web.window.dispatchEvent(web.Event('rusa-navigation'));
void logout() => web.window.dispatchEvent(web.Event('rusa-logout'));
bool get authenticationEnabled =>
    web.document.documentElement?.getAttribute('data-rusa-auth') == 'enabled';
String? get profilePhotoUrl =>
    web.document.documentElement?.getAttribute('data-rusa-profile-photo');

/// Owns reconnects so an idle EventSource cannot silently reopen itself.
/// Navigation renews the cookie before reconnecting either mesh or voice streams.
class SessionEventSource {
  SessionEventSource(this.url) {
    _active = ((web.Event _) => _connect()).toJS;
    _idle = ((web.Event _) => _disconnect()).toJS;
    web.window.addEventListener('rusa-session-active', _active);
    web.window.addEventListener('rusa-session-idle', _idle);
    _connect();
  }
  final String url;
  final Map<String, List<web.EventListener>> _listeners = {};
  late final web.EventListener _active;
  late final web.EventListener _idle;
  web.EventSource? _source;

  void _connect() {
    _disconnect();
    if (web.document.documentElement?.getAttribute('data-rusa-session-idle') ==
        'true') {
      return;
    }
    final source = web.EventSource(url);
    source.addEventListener(
      'session_idle',
      ((web.Event _) => _disconnect()).toJS,
    );
    source.addEventListener(
      'auth_required',
      ((web.Event _) {
        _disconnect();
        requireAuthentication();
      }).toJS,
    );
    for (final entry in _listeners.entries) {
      for (final listener in entry.value) {
        source.addEventListener(entry.key, listener);
      }
    }
    _source = source;
  }

  void addEventListener(String type, web.EventListener listener) {
    (_listeners[type] ??= []).add(listener);
    _source?.addEventListener(type, listener);
  }

  void _disconnect() {
    _source?.close();
    _source = null;
  }

  void close() {
    _disconnect();
    web.window.removeEventListener('rusa-session-active', _active);
    web.window.removeEventListener('rusa-session-idle', _idle);
    _listeners.clear();
  }
}
