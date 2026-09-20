import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/foundation.dart';
import 'package:web/web.dart' as web;

import 'session.dart';

/// Browser visit hooks are owned by the mounted dashboard session. Keeping
/// them instance-scoped avoids hidden global state between dashboard mounts.
class DashboardSessionBrowserHooks {
  DashboardSessionBrowserHooks(this.session) {
    _visibilityListener = ((web.Event _) {
      if (web.document.visibilityState == 'visible') unawaited(session.visit());
    }).toJS;
    _popStateListener = ((web.Event _) => unawaited(session.visit())).toJS;
    web.document.addEventListener('visibilitychange', _visibilityListener);
    web.window.addEventListener('popstate', _popStateListener);
  }

  final DashboardSession session;
  late final web.EventListener _visibilityListener;
  late final web.EventListener _popStateListener;

  void dispose() {
    web.document.removeEventListener('visibilitychange', _visibilityListener);
    web.window.removeEventListener('popstate', _popStateListener);
  }
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
/// A server `session_idle` frame also marks the controller idle. This covers a
/// throttled tab whose local inactivity timer did not run: a later visit then
/// changes the controller back to active and reconnects every stream.
class SessionEventSource {
  SessionEventSource(this.url, this.session) {
    _sessionListener = _onSessionChanged;
    session.addListener(_sessionListener);
    _wasIdle = session.isIdle;
    _connect();
  }
  final String url;
  final DashboardSession session;
  final Map<String, List<web.EventListener>> _listeners = {};
  late final VoidCallback _sessionListener;
  web.EventSource? _source;
  late bool _wasIdle;

  void _onSessionChanged() {
    final isIdle = session.isIdle;
    if (isIdle == _wasIdle) return;
    _wasIdle = isIdle;
    if (isIdle) {
      _disconnect();
    } else {
      _connect();
    }
  }

  void _connect() {
    _disconnect();
    if (session.isIdle) {
      return;
    }
    final source = web.EventSource(url);
    source.addEventListener(
      'session_idle',
      ((web.Event _) {
        session.idleFromServer();
        _disconnect();
      }).toJS,
    );
    source.addEventListener(
      'auth_required',
      ((web.Event _) {
        _disconnect();
        unawaited(session.requireAuthentication());
      }).toJS,
    );
    source.addEventListener(
      'error',
      ((web.Event _) {
        // CONNECTING is a native retry in progress; CLOSED means the server refused
        // the reconnect. Only a 401 turns that refusal into a login prompt.
        if (_source != source || source.readyState != web.EventSource.CLOSED) {
          return;
        }
        web.window
            .fetch('/api/auth/session'.toJS, web.RequestInit(cache: 'no-store'))
            .toDart
            .then((response) {
              if (response.status == 401) {
                _disconnect();
                unawaited(session.requireAuthentication());
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
    session.removeListener(_sessionListener);
    _listeners.clear();
  }
}
