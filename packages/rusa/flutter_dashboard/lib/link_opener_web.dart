import 'package:web/web.dart' as web;

/// Opens [url] in a new browser tab, the way the reference link button does.
/// `noopener,noreferrer` keeps the opened page from reaching back into this
/// one via `window.opener` — `window.open` doesn't withhold that by default
/// the way a bare `<a target="_blank">` now does.
void openInNewTab(String url) {
  web.window.open(url, '_blank', 'noopener,noreferrer');
}
