import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/foundation.dart';
import 'package:web/web.dart' as web;

import 'session.dart';

DashboardSession? _session;
web.EventListener? _visibilityListener;
web.EventListener? _popStateListener;

/// The web entrypoint installs the one session owner before it mounts a page.
/// URL changes, API failures, and SSE events call it directly rather than
/// translating auth state through DOM custom events.
void installDashboardSession(DashboardSession session) {
  if (identical(_session, session)) return;
  disposeDashboardSession(_session);
  _session = session;
  final visibilityListener = ((web.Event _) {
    if (web.document.visibilityState == 'visible') unawaited(session.visit());
  }).toJS;
  final popStateListener = ((web.Event _) => unawaited(session.visit())).toJS;
  _visibilityListener = visibilityListener;
  _popStateListener = popStateListener;
  web.document.addEventListener('visibilitychange', visibilityListener);
  web.window.addEventListener('popstate', popStateListener);
}

/// Removes browser visit hooks with the session that installed them.
void disposeDashboardSession(DashboardSession? session) {
  if (session == null || !identical(_session, session)) return;
  if (_visibilityListener case final listener?) {
    web.document.removeEventListener('visibilitychange', listener);
  }
  if (_popStateListener case final listener?) {
    web.window.removeEventListener('popstate', listener);
  }
  _visibilityListener = null;
  _popStateListener = null;
  _session = null;
}

void requireAuthentication() => _session?.requireAuthentication();
void notifyNavigation() => _session?.visit();
Future<void> logout() => _session?.signOut() ?? Future.value();
bool get authenticationEnabled => _session?.authenticationEnabled ?? false;
String? get profilePhotoUrl => _session?.profilePhotoUrl;

/// Owns reconnects so an idle EventSource cannot silently reopen itself.
/// Navigation renews the cookie before reconnecting either mesh or voice streams.
///
/// `session_idle` and `auth_required` are in-band frames on an open stream. The
/// browser's own reconnect after a drop can instead be refused outright (a 401
/// once the session is gone), which only surfaces as `error` with the source
/// closed; that case is settled by asking `/api/auth/session` directly, so a
/// dead stream never waits for the next poll to notice.
///
/// A server `session_idle` frame also marks the controller idle. This covers a
/// throttled tab whose local inactivity timer did not run: a later visit then
/// changes the controller back to active and reconnects every stream.
class SessionEventSource {
  SessionEventSource(this.url) {
    _sessionListener = _onSessionChanged;
    _session?.addListener(_sessionListener);
    _connect();
  }
  final String url;
  final Map<String, List<web.EventListener>> _listeners = {};
  late final VoidCallback _sessionListener;
  web.EventSource? _source;

  void _onSessionChanged() {
    if (_session?.isIdle ?? false) {
      _disconnect();
    } else {
      _connect();
    }
  }

  void _connect() {
    _disconnect();
    if (_session?.isIdle ?? false) {
      return;
    }
    final source = web.EventSource(url);
    source.addEventListener(
      'session_idle',
      ((web.Event _) {
        _session?.idleFromServer();
        _disconnect();
      }).toJS,
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
    _session?.removeListener(_sessionListener);
    _listeners.clear();
  }
}
