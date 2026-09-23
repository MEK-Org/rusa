/**
 * Synthetic corpus for the #533 shadow classifier.
 *
 * Every id and body here is invented. Real operational content never enters a
 * public fixture, and the classifier itself only ever sees ids — the bodies
 * exist so a fake client can make a decision for a *reason* rather than by
 * matching a hardcoded id, which is the only way a fixture can tell a working
 * decision apart from a lucky one.
 *
 * Three shapes, because they fail differently:
 *
 * - **Clear.** One candidate the arriving item plainly bears on. If a
 *   classifier cannot interrupt here it is useless.
 * - **Ambiguous.** Several candidates it plausibly bears on and none it
 *   plainly does. This is where a confident wrong answer costs a false
 *   preemption, so the policy's job is to be *unconfident*, not clever.
 * - **Scale.** One real match buried in a large distractor set, which is what
 *   an actor holding a long unhandled queue actually looks like. Ranking that
 *   works at three candidates can collapse at sixty.
 */

/** One synthetic inbox row: a stable id and the body a fake client reasons over. */
export interface FixtureEntry {
  id: string;
  body: string;
}

export interface ResponsiveInterruptionFixture {
  /** What the fixture is for, quoted into test names. */
  name: string;
  incoming: FixtureEntry;
  candidates: readonly FixtureEntry[];
  /**
   * The ids a correct decision bears on, empty when nothing in the candidate
   * set is a real match. Not fed to the classifier — it is what the fixture
   * asserts against.
   */
  trueMatchIds: readonly string[];
}

/** One candidate the arriving item unmistakably supersedes. */
export const CLEAR_MATCH_FIXTURE: ResponsiveInterruptionFixture = {
  name: "one clear match",
  incoming: {
    id: "incoming-clear",
    body: "Stop the migration rollout on shard 4 — the backfill script is wrong.",
  },
  candidates: [
    { id: "selected-migration", body: "Run the shard 4 migration backfill and report row counts." },
    { id: "selected-docs", body: "Draft the onboarding page for the new dashboard." },
    { id: "selected-triage", body: "Triage yesterday's flaky test reports." },
  ],
  trueMatchIds: ["selected-migration"],
};

/**
 * Three candidates that all touch the same subsystem and none that the
 * arriving item clearly supersedes. A classifier that interrupts here is
 * guessing; the fixture exists to catch confident guessing.
 */
export const AMBIGUOUS_FIXTURE: ResponsiveInterruptionFixture = {
  name: "several plausible matches",
  incoming: {
    id: "incoming-ambiguous",
    body: "The cache layer is behaving oddly in staging — worth a look at some point.",
  },
  candidates: [
    { id: "selected-cache-metrics", body: "Add hit-rate metrics to the cache layer." },
    { id: "selected-cache-evict", body: "Tune the cache eviction policy for staging." },
    { id: "selected-cache-docs", body: "Document the cache layer's invalidation rules." },
    { id: "selected-unrelated", body: "Rotate the deploy signing key." },
  ],
  trueMatchIds: [],
};

/** How many distractors the scale fixture buries its one real match in. */
const SCALE_DISTRACTORS = 60;

/**
 * One real match inside a large candidate set. The distractors are
 * deliberately *topical* rather than noise — a set of unrelated one-liners
 * would make ranking look good for the wrong reason.
 */
export const SCALE_FIXTURE: ResponsiveInterruptionFixture = {
  name: "a large distractor set",
  incoming: {
    id: "incoming-scale",
    body: "Cancel the quota coordinator cutover — the staging soak found a write stall.",
  },
  candidates: [
    ...Array.from({ length: SCALE_DISTRACTORS / 2 }, (_, i) => ({
      id: `pending-review-${i}`,
      body: `Review pull request ${100 + i} touching the dashboard quota rings.`,
    })),
    { id: "pending-cutover", body: "Run the quota coordinator cutover once the soak is clean." },
    ...Array.from({ length: SCALE_DISTRACTORS / 2 }, (_, i) => ({
      id: `pending-triage-${i}`,
      body: `Triage quota pacing alert ${i} from the overnight window.`,
    })),
  ],
  trueMatchIds: ["pending-cutover"],
};

export const RESPONSIVE_INTERRUPTION_FIXTURES = [
  CLEAR_MATCH_FIXTURE,
  AMBIGUOUS_FIXTURE,
  SCALE_FIXTURE,
] as const;
