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
bool needsCsrf(Uri url) =>
    authenticationEnabled &&
    Uri.base.resolveUri(url).origin == web.window.location.origin;
String? get csrfToken {
  final cookies = web.document.cookie
      .split(';')
      .map((part) => part.trim())
      .where((part) => part.startsWith('__Host-rusa_csrf='))
      .toList();
  return cookies.length == 1
      ? cookies.single.substring('__Host-rusa_csrf='.length)
      : null;
}

/// Owns reconnects so an idle EventSource cannot silently reopen itself.
/// Navigation renews the cookie before reconnecting either mesh or voice streams.
///
/// `session_idle` and `auth_required` are in-band frames on an open stream. The
/// browser's own reconnect after a drop can instead be refused outright (a 401
/// once the session is gone), which only surfaces as `error` with the source
/// closed; that case is settled by asking `/api/auth/session` directly, so a
/// dead stream never waits for the next poll to notice.
///
/// `data-rusa-session-idle` belongs to the login controller (auth-browser.ts):
/// its inactivity timer sets it and a successful renewal clears it. A server
/// `session_idle` frame only disconnects; it is the backstop for a throttled
/// tab whose timer never fired, and the next renewal reconnects as usual.
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
    source.addEventListener(
      'error',
      ((web.Event _) {
        // CONNECTING is a native retry in progress; CLOSED means the server refused
        // the reconnect. Only a 401 turns that refusal into a login prompt.
        if (!authenticationEnabled ||
            _source != source ||
            source.readyState != web.EventSource.CLOSED) {
          return;
        }
        web.window
            .fetch('/api/auth/session'.toJS, web.RequestInit(cache: 'no-store'))
            .toDart
            .then((response) {
              if (response.status == 401) {
                _disconnect();
                requireAuthentication();
              }
            })
            .catchError((Object _) {});
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
