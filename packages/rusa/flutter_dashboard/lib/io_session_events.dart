import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'io_session.dart';
import 'io_session_client.dart';
import 'session.dart';

/// Device counterpart of the web `SessionEventSource`: one Server-Sent Events
/// URL held open over chunked HTTP for as long as the session is active.
///
/// Each connection owns a fresh [http.Client] created by the factory so a
/// reconnect never reuses a closed one. The default factory builds an
/// [IoSessionClient] sharing the session's cookie jar (Origin + cookies are
/// its job, not this class's); tests inject a factory returning their mock.
///
/// Reconnect policy mirrors the browser: transport drops and non-401 refusals
/// retry on a timer, while `session_idle`, `auth_required` and `401` close the
/// stream and wait for the session instead of blind reconnects. An idle
/// session closes the stream and becoming active again (visit) reopens it.
class IoSessionEventSource {
  IoSessionEventSource({
    required this.url,
    required this.baseUrl,
    required DashboardSession session,
    required void Function(String event, String data) onEvent,
    VoidCallback? onOpen,
    VoidCallback? onError,
    http.Client Function()? clientFactory,
  }) : _session = session,
       _onEvent = onEvent,
       _onOpen = onOpen,
       _onError = onError,
       _clientFactory = clientFactory {
    _session.addListener(_onSessionChanged);
    _wasIdle = _session.isIdle;
    _connect();
  }

  final Uri url;
  final Uri baseUrl;
  final DashboardSession _session;
  final void Function(String event, String data) _onEvent;
  final VoidCallback? _onOpen;
  final VoidCallback? _onError;
  final http.Client Function()? _clientFactory;

  http.Client? _activeStreamClient;
  StreamSubscription<String>? _lineSubscription;
  Timer? _reconnectTimer;
  bool _closed = false;
  late bool _wasIdle;

  void _onSessionChanged() {
    final isIdle = _session.isIdle;
    if (isIdle == _wasIdle) return;
    _wasIdle = isIdle;
    if (isIdle) {
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      _closeActiveStream();
    } else {
      _connect();
    }
  }

  void _connect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _closeActiveStream();
    if (_closed || _session.isIdle) return;
    unawaited(_openStream());
  }

  void _closeActiveStream() {
    _lineSubscription?.cancel();
    _lineSubscription = null;
    _activeStreamClient?.close();
    _activeStreamClient = null;
  }

  http.Client _newConnectionClient() {
    final factory = _clientFactory;
    if (factory != null) return factory();
    final session = _session;
    if (session is IoDashboardSession) {
      return IoSessionClient(baseUrl: baseUrl, cookieJar: session.cookieJar);
    }
    return http.Client();
  }

  /// A dead session is settled by requireAuthentication, not by retrying: the
  /// next connect (selection change or re-login) reopens the stream.
  void _requireAuthentication() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _closeActiveStream();
    unawaited(_session.requireAuthentication());
  }

  Future<void> _openStream() async {
    if (_closed || _session.isIdle) return;

    final client = _newConnectionClient();
    _activeStreamClient = client;

    try {
      final request = http.Request('GET', url);
      request.headers['Accept'] = 'text/event-stream';
      request.headers['Cache-Control'] = 'no-cache';

      final response = await client.send(request);

      if (_closed || _activeStreamClient != client) {
        client.close();
        return;
      }

      if (response.statusCode == 401) {
        _requireAuthentication();
        return;
      }

      if (response.statusCode != 200) {
        _scheduleReconnect();
        return;
      }

      _onOpen?.call();

      String? currentEvent;
      final currentDataLines = <String>[];

      _lineSubscription = response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
            (line) {
              final trimmed = line.trim();
              if (trimmed.isEmpty) {
                // Empty line marks end of event
                if (currentEvent != null && currentDataLines.isNotEmpty) {
                  _dispatch(currentEvent!, currentDataLines.join('\n'));
                }
                currentEvent = null;
                currentDataLines.clear();
                return;
              }

              if (trimmed.startsWith(':')) {
                // Heartbeat / comment frame, ignore
                return;
              }

              if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.substring('event:'.length).trim();
              } else if (trimmed.startsWith('data:')) {
                currentDataLines.add(trimmed.substring('data:'.length).trim());
              }
            },
            onError: (_) => _scheduleReconnect(),
            onDone: _scheduleReconnect,
            cancelOnError: true,
          );
    } catch (_) {
      if (_closed || _activeStreamClient != client) {
        client.close();
        return;
      }
      _scheduleReconnect();
    }
  }

  void _dispatch(String event, String data) {
    switch (event) {
      case 'session_idle':
        // The session listener closes the stream synchronously; no reconnect.
        _session.idleFromServer();
      case 'auth_required':
        // Same as the web transport: disconnect and prompt, never retry blind.
        _requireAuthentication();
      default:
        try {
          _onEvent(event, data);
        } catch (_) {
          // Ignore a malformed frame rather than teardown
        }
    }
  }

  void _scheduleReconnect() {
    if (_closed) return;
    _closeActiveStream();
    _onError?.call();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 2), () {
      if (!_closed) _openStream();
    });
  }

  void close() {
    _closed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _session.removeListener(_onSessionChanged);
    _closeActiveStream();
  }
}
