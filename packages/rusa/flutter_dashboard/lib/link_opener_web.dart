import 'package:web/web.dart' as web;

/// Opens [url] in a new browser tab, the way the reference link button does.
void openInNewTab(String url) {
  web.window.open(url, '_blank');
}
