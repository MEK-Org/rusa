/// The browser tab title, and where it comes from.
///
/// `MaterialApp.title` is not cosmetic on web: Flutter wraps the app in a
/// `Title` widget whose `SystemChrome.setApplicationSwitcherDescription` call
/// assigns `document.title` outright as soon as the app boots. So a hardcoded
/// title here silently overwrote whatever the served `index.html` said — both
/// the staging build's "Rusa Staging" and, more to the point, the root actor's
/// configured name that the server now injects (an issue).
///
/// The fix is to make the served shell the single source of truth: `main.dart`
/// reads `document.title` before `runApp` and hands it back to `MaterialApp`, so
/// Flutter re-asserts the title it was given instead of replacing it.
library;

/// Title for a shell that carries none of its own — an `index.html` served
/// before the branding rewrite existed, or a non-web host.
const String defaultDashboardTitle = 'rusa mesh';

/// The title to hand `MaterialApp`, given the document title the shell loaded
/// with. Blank or whitespace-only means "the shell has nothing to say", not
/// "the app should be nameless".
String resolveDashboardTitle(String? documentTitle) {
  final trimmed = documentTitle?.trim() ?? '';
  return trimmed.isEmpty ? defaultDashboardTitle : trimmed;
}
