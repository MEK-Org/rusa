/// Viewport thresholds shared by the dashboard chrome. They live in their own
/// (import-free) file so the header, the body and the panels that reflow
/// against them can all name the same number instead of re-spelling it.
library;

/// Below which width (logical px) the dashboard reflows from the desktop
/// side-by-side master-detail to the phone layout: a full-width list that
/// navigates to a full-width detail, with the top navigation moved into a
/// drawer behind the header's hamburger.
const double kNarrowBreakpoint = 700;

/// Below which height (logical px) a viewport counts as *truly short* — a
/// landscape phone, or the geometry the walkie-talkie takes over full screen.
/// At that height the dashboard spends no vertical space on chrome it can do
/// without, and lands on the actor hierarchy rather than the overview.
const double kShortViewportHeight = 500;
