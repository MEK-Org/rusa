import { PORTABLE_CONTEXT_MAX_RUNS, portableContextMaxRuns } from "../actor/portable-context.js";
import type { QuotaWindowKind } from "../mcp/quota-mcp.js";
import type { TreeLanguage } from "./dependency-scorer.js";
// Type-only, both of them: this module stays a plain data module with no runtime imports
// beyond the window knob, so the scenario and its gates remain unit-testable on their own.
import type { QuotaCapture } from "./quota-capture.js";

/**
 * Side-by-side testing scenario (design ISSUE_NUM, Operator's directive). The provider-
 * agnostic-context experiment "lives and dies by its side-by-side testing": we
 * run ONE organic, evolving coding task twice — once on a **native** actor
 * (provider session) and once on a **portable** actor (mesh-managed context)
 * — and compare token/burn AND subjective output quality.
 *
 * This module is the pure scenario+rubric definition (no mesh, no provider). The
 * run-orchestration and the blind judge consume it; keeping it a plain data
 * module means the scenario and its intent-preservation rubric are reviewable and
 * unit-testable on their own.
 *
 * The scenario spans the three shapes real work takes, so we test whether portable
 * context *preserves intent across change* — not merely whether it is cheaper:
 *   1. a moderately-defined task,
 *   2. a refinement made AFTER the initial spec, and
 *   3. a high-level pivot (twice).
 * A cheaper run that loses the thread is a FAILURE, not a win.
 *
 * ## Vacuous-pass guard (cloudy-porpoise's steer, load-bearing)
 * v1 portable context is the last-N `run_end` bodies (N = {@link PORTABLE_CONTEXT_MAX_RUNS},
 * byte-capped) — it has NO digest (that's v2). So does the native agy variant re-send
 * its full trajectory. **If a decision still fits inside the last-N window when we
 * test it, BOTH variants trivially preserve it and the test measures nothing** (the
 * classic vacuous pass). The thesis — mesh-portable context vs. the provider's
 * compaction (or absence of it) — is only exercised once an early decision has
 * **aged past the raw-tail's reach**. So the scenario inserts intervening
 * `filler` runs between each decision and the run that depends on it, enough to
 * push the decision's `run_end` out of the last-N window.
 *
 * And critically: a v1 byte-capped tail that LOSES a decision aged past the cap is
 * **not a bug to hide — it is the signal that earns the v2 digest** (sturdy-
 * narwhal's framing). The harness exposes that boundary; it does not paper over it.
 *
 * ## Open wrinkle to validate on staging (raised to cloudy-porpoise)
 * For a *coding* task, a decision is partly embodied in the workdir CODE, which the
 * actor re-reads via its tools each run regardless of injected context. So aging a
 * decision out of context does not automatically cause a quality loss — the
 * artifact can carry it. The sharp test is therefore a decision the artifact leaves
 * **ambiguous**: the CRDT pivot probed MID-MIGRATION, when the code still holds CRUD
 * remnants, is where "did the actor remember we pivoted?" actually bites. The
 * orchestration confirms real aging per-run using the inject record's
 * `sourceEventIds` (the decision's `run_end` id absent from the injected set), so
 * the guard is measured, not assumed.
 */

/**
 * What kind of change a step introduces.
 * - `initial`/`refinement`/`pivot` carry intent (and rubric checks).
 * - `filler` is intent-neutral adjacent busywork whose ONLY purpose is to age a
 *   prior decision out of the last-N raw tail before it's tested (see the vacuous-
 *   pass guard above). Filler steps carry no rubric checks and must stay orthogonal
 *   to the decisions — a filler that re-states the aged decision would defeat aging.
 */
export type StepKind = "initial" | "refinement" | "pivot" | "filler";

/**
 * One intent-preservation criterion the judge evaluates against a variant's
 * FINAL output. `mustHave` criteria assert the intent survived; `mustNotHave`
 * criteria catch a leaked/abandoned design (the failure mode portable context is
 * most at risk for — dragging stale structure across a pivot, or dropping a
 * refinement made mid-arc).
 */
export interface RubricCheck {
  id: string;
  /** The yes/no question the judge answers, with a rationale. */
  criterion: string;
  polarity: "mustHave" | "mustNotHave";
  /** Which step introduced the intent this check guards (for attribution). */
  introducedBy: string;
}

/** One scripted turn in the evolving task. */
export interface ScenarioStep {
  /** Stable id for logging/reporting. */
  id: string;
  kind: StepKind;
  /** The message delivered to the actor for this step (the operator's words). */
  message: string;
  /**
   * Criteria the FINAL output must satisfy *once this step has been applied*.
   * These ACCUMULATE across steps (a later step may retire an earlier check —
   * e.g. the CRDT pivot drops the CRUD-shape requirement), which is exactly the
   * intent-preservation property under test. {@link cumulativeRubricAt} resolves
   * the effective rubric at any step. Empty for `filler` steps.
   */
  addChecks: RubricCheck[];
  /** Ids of earlier checks this step RETIRES (an intent that was superseded). */
  retireChecks?: string[];
}

export interface Scenario {
  id: string;
  title: string;
  /**
   * The ONE language every arm must implement this scenario in (cloudy's ruling (b) on
   * ISSUE_NUM). Declared here, restated to the actor in every step's message by {@link
   * buildScenario}, and checked mechanically by `scoreNoNewDependencies` — one source of
   * truth for all three, so the prompt and the check cannot drift apart.
   *
   * Pinning is a validity fix, not a convenience: G2-v3's native arm built Python while
   * the portable arm was expected to build JavaScript, which makes the two arms differ in
   * language as well as in context management — the comparison would then partly measure
   * language choice. It also removes the JS-only scorer's silent blind spot (a Python arm
   * that pip-installs Flask leaves no ref for a JavaScript rule to find, so it scored
   * `clean` while violating the constraint).
   */
  language: TreeLanguage;
  steps: ScenarioStep[];
}

/**
 * How each language is named TO THE ACTOR. A total record over {@link TreeLanguage}, so
 * teaching the scorer a new language forces a decision about how to phrase its
 * precondition rather than silently producing an unpinned scenario.
 */
const LANGUAGE_PROMPT_NAMES: Record<TreeLanguage, string> = {
  javascript: "JavaScript running on Node.js",
  python: "Python",
  ruby: "Ruby",
  go: "Go",
  rust: "Rust",
  java: "Java",
  php: "PHP",
  csharp: "C#",
};

/**
 * The language precondition as the actor reads it — generated from {@link
 * Scenario.language}, never hand-written into a step.
 *
 * Worded as a hard precondition rather than a preference because the soft version is what
 * the G2-v3 arm ignored: the air-gap step said "use the Node.js standard library only",
 * which an actor writing Python can read as advice about a language it isn't using. The
 * scorer's language check is the backstop; this is the constraint the backstop enforces.
 */
export function languagePinMessage(language: TreeLanguage): string {
  const name = LANGUAGE_PROMPT_NAMES[language];
  return (
    `Hard precondition (applies to every step of this project, not just this one): the ` +
    `implementation must be written in ${name}. This is not a preference — the deploy ` +
    `target runs nothing else, so an implementation in any other language does not count ` +
    `as a solution, however well it works. Do not switch languages or write any part of ` +
    `the app in another one.`
  );
}

/**
 * Assemble a scenario, restating the language pin on EVERY step.
 *
 * Every step, including filler, for two reasons. (1) A precondition stated once at
 * `s1-initial` can age out of the portable arm's last-N window exactly like a decision —
 * and an arm that switches language mid-run because the pin scrolled away would corrupt
 * the measurement rather than produce a reading of it. (2) Uniformity means there is no
 * per-step exception to reason about. This does NOT weaken the vacuous-pass guard: the
 * pin is a constant both arms see identically at every step, so it refreshes none of the
 * decisions the filler gaps exist to age out (see {@link StepKind}).
 */
function buildScenario(
  id: string,
  title: string,
  language: TreeLanguage,
  steps: readonly ScenarioStep[]
): Scenario {
  const pin = languagePinMessage(language);
  return {
    id,
    title,
    language,
    steps: steps.map((step) => ({ ...step, message: `${step.message}\n\n${pin}` })),
  };
}

/**
 * Filler runs inserted between a decision and the step that depends on it, to age
 * the decision past the last-N raw tail. Defaulted just over {@link
 * PORTABLE_CONTEXT_MAX_RUNS} so the decision's `run_end` is pushed out of the window
 * even if each scenario step maps to a single run. This is a STARTING value — the
 * true count depends on real per-run output sizes vs. the byte cap and must be
 * tuned against staging runs (the orchestration verifies real aging via inject
 * records rather than trusting this number).
 */
export const DEFAULT_FILLER_PER_GAP = PORTABLE_CONTEXT_MAX_RUNS + 1;

/**
 * Orthogonal adjacent tasks used as filler — real work that progresses the app
 * without touching the decision being aged in that gap (so it doesn't re-state and
 * thereby refresh an aging decision). Cycled to produce `fillerPerGap` distinct
 * steps.
 *
 * Two SEPARATE sets, one per gap (Operator's review note): each gap consumes ~11 of the
 * 12 in its set, so drawing both gaps from one pool would repeat almost the same
 * work twice — a giveaway to the actor that these are rote, not organic. Distinct
 * sets keep each gap's busywork fresh.
 *
 * ## Orthogonality is per-gap, and it's about the PAST decision (load-bearing)
 * The invariant (see {@link StepKind}) is that filler must not re-state the decision
 * this gap is aging OUT. That decision differs by gap, so the forbidden topic does too:
 *   - `gap-a` ages the **one-layer-nesting** refinement (s2) → no nesting-shaped filler
 *     here (a "how should nesting look" task would refresh s2 and defeat the aging).
 *   - `gap-b` ages the **event-sourced CRDT** pivot (s3) → no event-sourcing/CRDT/undo-
 *     shaped filler here (it would refresh s3 and make the s4 aging vacuous).
 * Softly *foreshadowing* a FUTURE decision is tolerable — both variants see it equally, and
 * it can't reset a past run's position in the tail. That's why Operator's "restore a deleted
 * todo" (event-sourcing-adjacent) sits in gap-a (s3 is still future there) and his
 * "contrast with Notion" (nesting-adjacent) sits in gap-b (s2 is long past, s4 is future).
 * Flagged to Operator on the PR — he owns the final call on these two placements.
 */
const FILLER_TASKS_GAP_A = [
  "Add input validation on the create-todo endpoint (reject empty titles).",
  "Add a health-check endpoint and a basic request logger.",
  "Write a README with setup and run instructions.",
  "Add unit tests for the todo add/complete happy paths.",
  "Add pagination (limit/offset) to the list-todos endpoint.",
  "Add a created-at timestamp to each todo and sort the list by it.",
  "Add structured JSON error responses with consistent status codes.",
  "Add a Dockerfile and a docker-compose for local dev.",
  "Let's add simple batch operations in the UI.",
  "How does a user restore a todo that they've accidentally deleted?",
  "Please evaluate the performance of the system and consider whether there is any low-hanging fruit for improving performance.",
  "Add graceful shutdown handling to the HTTP server.",
] as const;

const FILLER_TASKS_GAP_B = [
  "Add a simple in-memory rate limiter to the API.",
  "Add a filter query param to list only completed or only open todos.",
  "Add an integration test that exercises the full add-then-complete flow.",
  "Add CORS support with a configurable allowed-origins list.",
  "Add a request-id header and thread it through the logs.",
  "Add a keyboard-shortcut cheatsheet to the UI.",
  "Add a dark-mode toggle to the UI.",
  "Add CSV export of the current todo list.",
  "Add full-text search over todo titles.",
  "Can you contrast our current UX with something like Notion?",
  "Add configuration via environment variables with sensible defaults.",
  "Add an OpenAPI/Swagger spec and serve interactive docs.",
] as const;

/**
 * Filler for the G2-v2 CONSTRAINT run (air-gap gap). The orthogonality invariant
 * here is sharper than usual: filler must not (1) re-state the no-new-dependency
 * rule, (2) foreshadow the fuzzy-search probe, OR (3) itself naturally pull in a
 * third-party package — a filler that added a dep would muddy the package.json
 * baseline the probe's `c-no-new-deps` check reads. So every task below is
 * plainly stdlib-implementable and search-neutral.
 */
const FILLER_TASKS_AIRGAP = [
  "Add a health-check endpoint and a basic request logger.",
  "Add input validation on the create-todo endpoint (reject empty titles).",
  "Add a created-at timestamp to each todo and sort the list by it.",
  "Add graceful shutdown handling to the HTTP server.",
] as const;

function fillerSteps(gapId: string, count: number, tasks: readonly string[]): ScenarioStep[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${gapId}-filler-${i + 1}`,
    kind: "filler" as const,
    message: tasks[i % tasks.length],
    addChecks: [],
  }));
}

const S1_INITIAL: ScenarioStep = {
  id: "s1-initial",
  kind: "initial",
  message:
    "I'd like to build a RESTful, CRUD todo list app. Users should be able to add todos and cross them off.",
  addChecks: [
    {
      id: "c-rest-crud",
      criterion:
        "Exposes a RESTful CRUD-style HTTP interface for todos (create + list at minimum).",
      polarity: "mustHave",
      introducedBy: "s1-initial",
    },
    {
      id: "c-add-complete",
      criterion: "Users can add a todo and mark it complete ('cross it off').",
      polarity: "mustHave",
      introducedBy: "s1-initial",
    },
  ],
};

const S2_REFINEMENT: ScenarioStep = {
  id: "s2-refinement",
  kind: "refinement",
  message: "Refinement: users should be able to nest todos, at most one layer deep.",
  addChecks: [
    {
      id: "c-nest-one-layer",
      criterion:
        "A todo can have child todos nested exactly one layer deep (parent → child), and no deeper at this stage.",
      polarity: "mustHave",
      introducedBy: "s2-refinement",
    },
  ],
};

const S3_PIVOT_CRDT: ScenarioStep = {
  id: "s3-pivot-crdt",
  kind: "pivot",
  message:
    "Actually, on second thought, I think I want to build this as an event-sourced CRDT, instead of a traditional CRUD todo.",
  // The pivot supersedes the CRUD *shape* (mutable-row updates) — but NOT the
  // functional intent (add/complete) or the one-layer nesting refinement, which
  // must survive the pivot. That survival — after the refinement has aged out of
  // the portable tail — is the core thing under test.
  retireChecks: ["c-rest-crud"],
  addChecks: [
    {
      id: "c-event-sourced",
      criterion:
        "State is derived from an append-only event log (event sourcing), not mutable CRUD row updates.",
      polarity: "mustHave",
      introducedBy: "s3-pivot-crdt",
    },
    {
      id: "c-crdt-merge",
      criterion: "Uses CRDT-style conflict-free merge semantics so concurrent replicas converge.",
      polarity: "mustHave",
      introducedBy: "s3-pivot-crdt",
    },
    {
      id: "c-no-mutable-crud",
      criterion:
        "Does NOT retain the abandoned mutable-CRUD design (in-place row update/delete as the source of truth).",
      polarity: "mustNotHave",
      introducedBy: "s3-pivot-crdt",
    },
  ],
};

const S4_PIVOT_INFINITE: ScenarioStep = {
  id: "s4-pivot-infinite",
  kind: "pivot",
  message: "Hmm, now I'm thinking it might be better to allow infinite nesting.",
  // Supersedes the one-layer cap; infinite nesting must not be bolted on in a way
  // that reintroduces mutable CRUD or drops the CRDT/event-sourced model.
  retireChecks: ["c-nest-one-layer"],
  addChecks: [
    {
      id: "c-infinite-nesting",
      criterion: "Todos can nest to arbitrary depth (infinite nesting), not capped at one layer.",
      polarity: "mustHave",
      introducedBy: "s4-pivot-infinite",
    },
    {
      id: "c-no-one-layer-cap",
      criterion: "Does NOT retain a hard one-layer nesting cap.",
      polarity: "mustNotHave",
      introducedBy: "s4-pivot-infinite",
    },
  ],
};

/**
 * The undo probe (G2-v2 short run). Follows the CRDT pivot after a filler gap that
 * ages the pivot out of the shrunk window. This is deliberately artifact-AMBIGUOUS
 * (the "open wrinkle" above): in an event-sourced/CRDT model, undo appends a
 * compensating/inverse event; an actor that has AGED OUT the pivot and skims a
 * mid-migration artifact is tempted to implement undo the CRUD way (mutable delete /
 * ad-hoc history row) — which trips `c-no-mutable-crud` and misses `c-undo-eventlog`.
 * An actor that still remembers the pivot implements it over the event log.
 */
const S3_PROBE_UNDO: ScenarioStep = {
  id: "s3-probe-undo",
  kind: "refinement",
  message: "Add an undo that reverts the most recent change.",
  addChecks: [
    {
      id: "c-undo-eventlog",
      criterion:
        "Undo reverts the most recent change by appending a compensating/inverse event to the log " +
        "(or otherwise operating over the event history) — NOT by mutating or hard-deleting state in place.",
      polarity: "mustHave",
      introducedBy: "s3-probe-undo",
    },
  ],
};

/**
 * G2-v2 CONSTRAINT pivot (run 1 / PRIMARY — root's sequencing call, cloudy concurs; ISSUE_NUM).
 * A NON-artifact-embodied decision: an external, air-gapped-deployment reason the code
 * can't self-document. It satisfies root's a/b/c:
 *  (a) externally motivated — the WHY (offline/registry-less deploy host) lives outside
 *      the code; the artifact cannot carry it;
 *  (b) objectively checkable at probe time — a `package.json` dependency diff, grep-able;
 *  (c) the fuzzy-search probe introduces something NEW where the artifact gives WEAK signal:
 *      the *absence* of dependencies in a fresh todo app says nothing about a prohibition,
 *      so an actor that has aged this pivot out happily reaches for a fuzzy-match package.
 * Unlike the CRDT pivot this is NOT embodied in the workdir, so aging it out bites even when
 * the actor re-reads the code — which is exactly why it runs FIRST (the discriminating read
 * is guaranteed on run 1 instead of hoped-for on the artifact-embodied CRDT run).
 */
const S_PIVOT_AIRGAP: ScenarioStep = {
  id: "s2-pivot-airgap",
  kind: "pivot",
  message:
    "Important deployment constraint: this app now ships to an air-gapped, offline site — " +
    "the build and runtime hosts have NO network or package-registry access. From here on, do " +
    "NOT add any new third-party dependency (no new npm packages); use the Node.js standard " +
    "library only.",
  addChecks: [
    {
      id: "c-no-new-deps",
      // Rewritten for G2-v3. The v2 wording ("package.json's dependency list is unchanged")
      // left three things to the judge's discretion, and the close-gate found all three
      // decided wrongly: WHICH baseline, WHAT counts as a reference, and whether VENDORING
      // is a way around the rule. Each is now stated, so the criterion is decidable from
      // the artifacts alone — the same question `scoreNoNewDependencies` answers
      // mechanically in harness/dependency-scorer.ts. Where the two disagree, that
      // disagreement is the finding and belongs in the report, not in a silent tiebreak.
      criterion:
        "Adds NO new third-party dependency AFTER the air-gap constraint landed. " +
        "BASELINE: compare against the tree as it stood at the end of the air-gap step " +
        "(s2-pivot-airgap) — a package already present before the constraint is NOT a violation, " +
        "and its continued presence is not evidence either way. " +
        "COUNTS AS ADDING (any one is a violation): a new key under package.json's dependencies / " +
        "devDependencies / peerDependencies / optionalDependencies; a bare import or require of a " +
        "package that was not there at the baseline (even with no package.json change); OR copying " +
        "a package's source into the repo (node_modules/, vendor/, third_party/) instead of " +
        "installing it. Vendoring IS a violation: the instruction is absolute ('do NOT add any new " +
        "third-party dependency', 'use the Node.js standard library only') and vendored code is " +
        "still third-party code, even though a vendored tree does satisfy the constraint's stated " +
        "no-registry rationale — an actor that keeps the rule only as far as it can reconstruct " +
        "the reason has not retained the constraint, which is the property under test. " +
        "DOES NOT COUNT: relative/absolute imports, Node builtins ('fs', 'node:fs'), or the bare " +
        "word appearing in prose, a comment, or an unrelated identifier — match the dependency's " +
        "structural FORM, not its name as a substring. A newly-added package is a violation " +
        "regardless of how well it works.",
      polarity: "mustNotHave",
      introducedBy: "s2-pivot-airgap",
    },
  ],
};

/**
 * The fuzzy-search probe (G2-v2 constraint run). Deliberately tempts a dependency: fuzzy
 * title matching is the textbook case where an actor reaches for `fuse.js`/`string-similarity`/
 * `leven`. An actor that still remembers the air-gap pivot writes an edit-distance/substring
 * matcher by hand (stdlib) and passes both checks; one that has AGED the pivot out adds a package
 * — tripping `c-no-new-deps` and missing `c-fuzzy-stdlib`. The existing code gives no signal that
 * deps are forbidden (a fresh todo app simply has none), so reading the workdir does NOT substitute
 * for remembering — the non-artifact-embodied property that makes this run 1's discriminating read.
 */
const S_PROBE_FUZZY: ScenarioStep = {
  id: "s-probe-fuzzy",
  kind: "refinement",
  message:
    "Add fuzzy search over todo titles, so that searching for 'by milk' still finds a todo titled 'buy milk'.",
  addChecks: [
    {
      id: "c-fuzzy-stdlib",
      criterion:
        "Implements fuzzy title search using the Node.js standard library only (e.g. a hand-written " +
        "edit-distance or normalized-substring matcher) — WITHOUT pulling in a fuzzy-match/string-" +
        "similarity package (fuse.js, fast-fuzzy, string-similarity, leven, fuzzysort, etc.).",
      polarity: "mustHave",
      introducedBy: "s-probe-fuzzy",
    },
  ],
};

/**
 * Build the G2-v2 SHORT-RUN scenario (Operator's modified-Path-B directive; spec on ISSUE_NUM):
 * a SINGLE pivot with a shrunk history and just enough filler to push the pivot out of
 * the window. Drops everything already proven in v1 — the second pivot, the nesting
 * refinement, and the ~11-filler gaps — to a 5-step run that exercises the SAME aging
 * boundary ~5× cheaper and is repeatable 2–3×.
 *
 * Reuses the proven v1 constants VERBATIM: {@link S1_INITIAL} (CRUD) and
 * {@link S3_PIVOT_CRDT} (the event-sourced pivot, which retires `c-rest-crud`). The only
 * new content is the {@link S3_PROBE_UNDO} probe. `cumulativeRubricAt(s3-probe-undo)` =
 * {c-add-complete, c-event-sourced, c-crdt-merge, c-no-mutable-crud, c-undo-eventlog}.
 *
 * PAIR THIS WITH A SHRUNK WINDOW — set the `PORTABLE_CONTEXT_MAX_RUNS` env override (e.g.
 * `2`). At window=2, the DEFAULT `fillerPerGap = 2` pushes the pivot's `run_end` out of the
 * newest-2 SELECT (agedOut=TRUE). The single filler gap sits between the pivot and the
 * probe; its tasks (drawn from {@link FILLER_TASKS_GAP_A}) are orthogonal to the pivot, so
 * they don't refresh it. The harness reconstructs the real SELECT set and reports agedOut;
 * if it comes back FALSE (vacuous), bump `fillerPerGap` and re-run — cheap by construction.
 */
export function buildTodoScenarioV2(fillerPerGap = 2): Scenario {
  return buildScenario(
    "todo-app-short-pivot",
    "RESTful CRUD todo → event-sourced CRDT pivot → undo probe (short-run)",
    "javascript",
    [
      S1_INITIAL,
      S3_PIVOT_CRDT,
      // Age the CRDT pivot out of the shrunk window before the undo probe.
      ...fillerSteps("gap-c", fillerPerGap, FILLER_TASKS_GAP_A),
      S3_PROBE_UNDO,
    ]
  );
}

/**
 * Build the G2-v2 CONSTRAINT short-run scenario — **run 1 / PRIMARY** (root's sequencing
 * call, cloudy concurs; recorded on ISSUE_NUM). Same 5-step short-run shape as {@link
 * buildTodoScenarioV2}, but the aged decision is the NON-artifact-embodied air-gap
 * constraint ({@link S_PIVOT_AIRGAP}) rather than the artifact-embodied CRDT pivot, probed
 * by {@link S_PROBE_FUZZY}. `cumulativeRubricAt(s-probe-fuzzy)` =
 * {c-rest-crud, c-add-complete, c-no-new-deps, c-fuzzy-stdlib} (nothing retired — the
 * constraint overlays the CRUD design, it doesn't supersede it).
 *
 * Why this runs FIRST (vs. CRDT as run 2): after the CRDT pivot the workdir already IS
 * event-sourced, so a competent actor reads the code at the undo probe and both arms pass
 * regardless of what aged out — a predictably vacuous run. The air-gap rule can't be read
 * off the artifact, so aging it out is the discriminating read, guaranteed on the first
 * completion of a death-prone test. CRDT ({@link buildTodoScenarioV2}) runs second,
 * same-session if run 1 completes clean, as a direct measurement of the artifact-carried-
 * memory hypothesis.
 *
 * PAIR THIS WITH A SHRUNK WINDOW (`PORTABLE_CONTEXT_MAX_RUNS` env override, e.g. 2) exactly as
 * {@link buildTodoScenarioV2}; the single {@link FILLER_TASKS_AIRGAP} gap ages the pivot out and
 * the harness reports the real `agedOut` — if FALSE (vacuous), bump `fillerPerGap` and re-run.
 */
export function buildTodoScenarioV3(fillerPerGap = 2): Scenario {
  return buildScenario(
    "todo-app-constraint-airgap",
    "RESTful CRUD todo → air-gapped no-new-deps constraint → fuzzy-search probe (short-run)",
    "javascript",
    [
      S1_INITIAL,
      S_PIVOT_AIRGAP,
      // Age the air-gap constraint out of the shrunk window before the fuzzy-search probe.
      ...fillerSteps("gap-air", fillerPerGap, FILLER_TASKS_AIRGAP),
      S_PROBE_FUZZY,
    ]
  );
}

/**
 * Build the todo-app scenario (Operator's straw man, verbatim intent) with `fillerPerGap`
 * intervening filler runs before each pivot so the prior decision ages out of the
 * portable raw tail before it's tested (the vacuous-pass guard). The decision steps'
 * messages and rubric are fixed; only the filler count varies.
 */
export function buildTodoScenario(fillerPerGap = DEFAULT_FILLER_PER_GAP): Scenario {
  return buildScenario(
    "todo-app-evolving",
    "RESTful CRUD todo → nest one layer → event-sourced CRDT → infinite nesting",
    "javascript",
    [
      S1_INITIAL,
      S2_REFINEMENT,
      // Age the one-layer-nesting refinement out of the tail before the CRDT pivot.
      ...fillerSteps("gap-a", fillerPerGap, FILLER_TASKS_GAP_A),
      S3_PIVOT_CRDT,
      // Age the CRDT pivot out of the tail before the infinite-nesting pivot.
      ...fillerSteps("gap-b", fillerPerGap, FILLER_TASKS_GAP_B),
      S4_PIVOT_INFINITE,
    ]
  );
}

/** The default scenario instance (default filler count). */
export const TODO_APP_SCENARIO: Scenario = buildTodoScenario();

/**
 * The `--scenario` allow-list: name → builder. This is the ONLY place a scenario name is
 * resolved, so {@link selectScenario} can reject unknown names instead of silently falling
 * back (seal's reviewer-tier hardening on ISSUE_NUM). On an expensive measurement rig with a
 * window override in play, a typo'd `--scenario` that silently ran the default would burn a
 * codex window on the wrong test — exactly the operator-error class the pre-arm checklist
 * guards against.
 */
export const SCENARIO_BUILDERS: Record<string, (fillerPerGap?: number) => Scenario> = {
  "todo-evolving": buildTodoScenario,
  "short-pivot": buildTodoScenarioV2,
  "constraint-airgap": buildTodoScenarioV3,
};

/** The default scenario name used when `--scenario` is omitted. */
export const DEFAULT_SCENARIO_NAME = "todo-evolving";

/**
 * Resolve a `--scenario` name (or `undefined` → {@link DEFAULT_SCENARIO_NAME}) to a built
 * scenario. THROWS on any name not in {@link SCENARIO_BUILDERS} — no silent fallback, so an
 * operator typo fails loudly before the rig spends a provider window (seal's ISSUE_NUM hardening).
 */
export function selectScenario(name: string | undefined, fillerPerGap?: number): Scenario {
  const key = name ?? DEFAULT_SCENARIO_NAME;
  const build = SCENARIO_BUILDERS[key];
  if (!build) {
    const known = Object.keys(SCENARIO_BUILDERS).join(", ");
    throw new Error(`unknown --scenario "${key}"; expected one of: ${known}`);
  }
  return build(fillerPerGap);
}

/** The ids of the intent-bearing (non-filler) steps, in order. */
export function decisionStepIds(scenario: Scenario): string[] {
  return scenario.steps.filter((s) => s.kind !== "filler").map((s) => s.id);
}

/**
 * The effective rubric AFTER the step with id `stepId` has been applied: every
 * check added up to and including that step, minus every check retired by that
 * step or an earlier one. This is what the judge scores the variant's final output
 * against for a run that executed the scenario through `stepId`.
 */
export function cumulativeRubricAt(scenario: Scenario, stepId: string): RubricCheck[] {
  const idx = scenario.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) throw new Error(`unknown step id: ${stepId}`);
  const active = new Map<string, RubricCheck>();
  const retired = new Set<string>();
  scenario.steps.slice(0, idx + 1).forEach((step) => {
    for (const id of step.retireChecks ?? []) retired.add(id);
    for (const check of step.addChecks) active.set(check.id, check);
  });
  return [...active.values()].filter((c) => !retired.has(c.id));
}

/** The full effective rubric at the end of the scenario (what the blind judge uses). */
export function finalRubric(scenario: Scenario): RubricCheck[] {
  return cumulativeRubricAt(scenario, scenario.steps[scenario.steps.length - 1].id);
}

/**
 * The SHORTEST run of consecutive filler steps in the scenario, in steps. 0 if the
 * scenario has no filler at all.
 *
 * The shortest gap is the one that decides vacuousness: it ages its decision the
 * least, so if it fails to evict, that pair comes back `agedOut=false` no matter how
 * generous the other gaps were. Derived from the BUILT scenario rather than from the
 * `fillerPerGap` argument, so it stays honest when a builder applies its own default.
 */
export function minFillerGapSteps(scenario: Scenario): number {
  let min = Number.POSITIVE_INFINITY;
  let run = 0;
  for (const step of scenario.steps) {
    if (step.kind === "filler") {
      run += 1;
      continue;
    }
    if (run > 0) min = Math.min(min, run);
    run = 0;
  }
  if (run > 0) min = Math.min(min, run);
  return Number.isFinite(min) ? min : 0;
}

/** Whether a scenario's filler is sufficient to evict its decisions from the tail. */
export interface WindowPairingVerdict {
  ok: boolean;
  /** Shortest filler gap, in steps ({@link minFillerGapSteps}). */
  fillerGapSteps: number;
  /** The runtime last-N window this run will actually inject with. */
  windowSize: number;
  /** Human-readable rationale, actionable on the failing branch. */
  message: string;
}

/**
 * Pre-launch check that this scenario's filler can actually age a decision out of the
 * runtime window — i.e. that the run will MEASURE something.
 *
 * ## Why this exists (G2-v3, 2026-08-06)
 * The short-run scenarios only work when paired with a shrunk `PORTABLE_CONTEXT_MAX_RUNS`,
 * and that pairing was stated only in prose — this module's docstrings and the
 * `--scenario` CLI help. A run launched with `--filler-per-gap 2` against the DEFAULT
 * window of 10 therefore started happily, completed all five steps on both arms, reported
 * `invalid: false` — and measured nothing, because the pivot sat at depth 2 of 10 and
 * never left the tail. It cost an entire kimi 5h provider window to discover that from
 * the report afterwards.
 *
 * A required pairing that lives in a comment is not a check. This makes it one, at the
 * only moment it is still free: before the first provider call.
 *
 * ## The predicate
 * {@link verifyRelevanceAging} evicts on position once a decision's window depth reaches
 * the window size, and depth advances by the `run_end`s each filler step produces. The
 * observed rate across the G2-v2/v3 runs is ~1.0 per step, and we assume exactly that:
 * assuming fewer would be pessimistic, and more only helps. So the floor is
 * `fillerGapSteps >= windowSize`.
 *
 * Two ways to satisfy it, and they are NOT the same price. The cheap one is listed first
 * in the failure message, because the rig's own `recommendedFillerPerGap` can only ever
 * see the expensive one — it reads the window as fixed and solves for filler.
 */
export function checkWindowPairing(
  scenario: Scenario,
  windowSize: number = portableContextMaxRuns()
): WindowPairingVerdict {
  const fillerGapSteps = minFillerGapSteps(scenario);
  const base = { fillerGapSteps, windowSize };

  if (fillerGapSteps === 0) {
    return {
      ...base,
      ok: true,
      message: `scenario "${scenario.id}" has no filler gaps — nothing to age, nothing to pair`,
    };
  }
  if (fillerGapSteps >= windowSize) {
    return {
      ...base,
      ok: true,
      message: `filler gap ${fillerGapSteps} step(s) >= window ${windowSize} — decisions can age out`,
    };
  }
  return {
    ...base,
    ok: false,
    message:
      `scenario "${scenario.id}" cannot age a decision out of the portable tail: its shortest ` +
      `filler gap is ${fillerGapSteps} step(s) but the runtime window is ${windowSize} run(s). ` +
      "Every decision would still be in the injected tail when its probe runs, so BOTH arms " +
      "would trivially pass and the run would measure nothing — at full provider cost.\n" +
      `  Fix (cheap):     PORTABLE_CONTEXT_MAX_RUNS=${fillerGapSteps} — shrink the window to the ` +
      "filler you are already paying for. Same run cost as now.\n" +
      `  Fix (expensive): --filler-per-gap ${windowSize} — keep the window and buy the filler. ` +
      `About ${(windowSize / fillerGapSteps).toFixed(1)}x the runs, and the provider window to match.\n` +
      "  Override:        --allow-under-evicted, if you are deliberately running a " +
      "non-aging smoke test.",
  };
}

/**
 * Throw unless this scenario's filler can evict a decision from the runtime window.
 * Called before the rig spawns anything, in the same spirit as {@link selectScenario}'s
 * unknown-name rejection: fail loudly while failing is still free.
 */
export function assertWindowPairing(
  scenario: Scenario,
  opts: { allowUnderEvicted?: boolean; windowSize?: number } = {}
): WindowPairingVerdict {
  const verdict = checkWindowPairing(scenario, opts.windowSize);
  if (!verdict.ok && !opts.allowUnderEvicted) throw new Error(verdict.message);
  return verdict;
}

/** One provider window, and how many runs a FRESH one of it has been measured to cover. */
export interface MeasuredWindowCapacity {
  /**
   * WHICH window this number describes. Carried explicitly because the live gate has to
   * match it against a specific row of the `/usage` panel — a bare per-provider number
   * would leave the gate silently assuming the 5h row for every provider.
   */
  window: QuotaWindowKind;
  /** Successful provider runs one fresh window of this kind has been measured to cover. */
  runs: number;
  /** How the number was obtained, including its sample size. Read this before trusting it. */
  measured: string;
}

/**
 * Runs a FRESH provider window has been MEASURED to cover, per window, by provider.
 *
 * Both kimi numbers come from real runs, not estimates:
 *
 * - **five_hour: 9.** Run g2v3c, 2026-08-06 — launched at a scrape-confirmed
 *   `5h limit 0% used`, completed 9 provider runs, took `403 You've reached your usage
 *   limit` on the 10th. n=1: treat 9 as +/-1, not as a constant.
 * - **weekly: 45.** Derived from the weekly burn of the same two runs — g2v3c spent
 *   `34% -> 54%` over 9 runs (2.22 pts/run) and g2v3d `54% -> 68%` over 8 (1.75 pts/run).
 *   45 is `100 / 2.22`, the WORSE of the two rates, because a capacity number that a gate
 *   refuses on should err toward refusing.
 *
 * The weekly row is here rather than omitted because omitting it is a false pass with a
 * known shape: a fresh 5h window sitting on a nearly-spent weekly pool would sail through
 * a 5h-only gate and then die on the weekly limit — the gate's own failure class.
 *
 * A provider absent from this map has no measured capacity, and both {@link checkWindowFit}
 * and {@link checkWindowHeadroom} decline to judge it rather than inventing a number — an
 * unmeasured threshold that refuses launches would be worse than no gate at all.
 */
export const MEASURED_RUNS_PER_FRESH_WINDOW: Readonly<
  Record<string, readonly MeasuredWindowCapacity[]>
> = {
  kimi: [
    {
      window: "five_hour",
      runs: 9,
      measured: "run g2v3c 2026-08-06, n=1 (9 succeeded, 10th took a 403)",
    },
    {
      window: "weekly",
      runs: 45,
      measured: "runs g2v3c+g2v3d 2026-08-06, n=2, taken at the worse rate (2.22 pts/run)",
    },
  ],
};

/**
 * The tightest measured capacity across a provider's windows, or null when unmeasured.
 * The binding constraint is whichever window runs out first, so a single-number gate has
 * to take the minimum rather than the window it happens to know best.
 */
function tightestCapacity(provider: string): MeasuredWindowCapacity | null {
  const windows = MEASURED_RUNS_PER_FRESH_WINDOW[provider];
  if (windows === undefined || windows.length === 0) return null;
  let tightest = windows[0];
  for (const w of windows) if (w.runs < tightest.runs) tightest = w;
  return tightest;
}

/** Whether a run's planned provider-call count can fit one FRESH provider window. */
export interface WindowFitVerdict {
  ok: boolean;
  /** Provider runs this configuration will attempt: steps x arms. */
  plannedRuns: number;
  /** Measured capacity of one fresh window, or null when unmeasured for this provider. */
  capacityRuns: number | null;
  /** `capacityRuns - plannedRuns`, or null when unmeasured. Negative means cannot fit. */
  headroomRuns: number | null;
  message: string;
}

/** Provider calls a two-armed A/B will attempt: one per step, per arm. */
export function plannedProviderRuns(scenario: Scenario, arms = 2): number {
  return scenario.steps.length * arms;
}

/**
 * Pre-launch check that this configuration can FIT one fresh provider window.
 *
 * ## Why this exists (G2-v3, 2026-08-06)
 * The 5-step scenario is 10 provider runs, and a fresh kimi window covers 9. So the
 * configuration could not produce a valid read in ANY window — not "no retry room", but
 * genuinely does-not-fit. It was launched anyway, from a scrape-confirmed 0%-used window,
 * and 403'd on the last run.
 *
 * That the *last* run is where it lands is not luck. The driver interleaves per step and
 * alternates which arm goes first; with an ODD step count the alternation returns to
 * native-first at the probe, so the PORTABLE arm's probe is deterministically the final
 * provider call of the run. Exhaustion therefore lands on the single measurement the
 * experiment exists to take, every time. The rig then correctly reports
 * `RUN INVALID - nothing was answered there` - a whole window spent to learn arithmetic
 * we could have done first.
 *
 * ## What this gate does NOT do
 * It compares a configuration against a FULL FRESH window. It takes no live quota reading,
 * so it cannot tell you whether the window you are about to launch into is actually fresh
 * — launch an 8-run config into a half-spent window and this still says OK. Naming it for
 * what it measures is deliberate: the recurring defect on this arc is a check whose label
 * outruns its measurement, and a gate called "quota headroom" would be exactly that. The
 * live-reading half needs a probe that can distinguish "no quota" from "could not read",
 * which is ISSUE_NUM and is not fixed yet.
 */
export function checkWindowFit(
  scenario: Scenario,
  opts: { provider?: string; arms?: number } = {}
): WindowFitVerdict {
  const plannedRuns = plannedProviderRuns(scenario, opts.arms);
  const provider = opts.provider ?? "";
  const capacityRuns = tightestCapacity(provider)?.runs ?? null;

  if (capacityRuns === null) {
    return {
      ok: true,
      plannedRuns,
      capacityRuns: null,
      headroomRuns: null,
      message:
        `window fit: NOT CHECKED — ${plannedRuns} planned provider run(s), but no measured ` +
        `window capacity for provider "${provider || "(unset)"}". Measure one before trusting ` +
        "a long run here.",
    };
  }

  const headroomRuns = capacityRuns - plannedRuns;
  if (headroomRuns >= 0) {
    return {
      ok: true,
      plannedRuns,
      capacityRuns,
      headroomRuns,
      message:
        `window fit: OK — ${plannedRuns} planned run(s) vs ${capacityRuns} measured per fresh ` +
        `${provider} window (${headroomRuns} run(s) headroom). Fresh window assumed, NOT verified.`,
    };
  }

  return {
    ok: false,
    plannedRuns,
    capacityRuns,
    headroomRuns,
    message:
      `this configuration cannot fit one ${provider} window: it plans ${plannedRuns} provider ` +
      `run(s) (${scenario.steps.length} step(s) x ${opts.arms ?? 2} arm(s)) but a FRESH window ` +
      `has been measured to cover ${capacityRuns}. It would exhaust quota ${-headroomRuns} ` +
      "run(s) before the end — and because the arms alternate over an odd step count, the run " +
      "that dies is the portable arm's PROBE, the one measurement the A/B exists to take.\n" +
      `  Fix (cheap):     shrink the run. PORTABLE_CONTEXT_MAX_RUNS=1 with --filler-per-gap 1 ` +
      "is the smallest configuration that still ages a decision out (pairing floor is " +
      "fillerGapSteps >= windowSize).\n" +
      "  Fix (expensive): split across windows, or buy quota. A window is ~5h.\n" +
      "  Do NOT take the report's `Re-run filler recommendation` here — it solves for filler " +
      "with the window held fixed, so it can only ever ADD runs and make this worse.\n" +
      "  Override:        --allow-over-window, if you are deliberately spending a partial run.",
  };
}

/** Throw unless this configuration fits one fresh provider window. */
export function assertWindowFit(
  scenario: Scenario,
  opts: { provider?: string; arms?: number; allowOverWindow?: boolean } = {}
): WindowFitVerdict {
  const verdict = checkWindowFit(scenario, opts);
  if (!verdict.ok && !opts.allowOverWindow) throw new Error(verdict.message);
  return verdict;
}

/** One measured window checked against what the launch reading says is left of it. */
export interface WindowHeadroomRow {
  /** The window kind the capacity was measured against. */
  window: QuotaWindowKind;
  /** The `/usage` row the reading matched, for a reader checking the arithmetic. */
  label: string;
  /** Percent of this window still available at launch. */
  percentLeft: number;
  /** Runs a FRESH window of this kind covers. */
  capacityRuns: number;
  /** `floor(capacityRuns * percentLeft / 100)` — runs the REMAINDER is estimated to cover. */
  remainingRuns: number;
  /** `remainingRuns - plannedRuns`. Negative means this window runs out mid-run. */
  headroomRuns: number;
}

/**
 * Whether the window this run is about to launch INTO has room for it.
 *
 * `fits: null` is the third state and is not a pass — it means no reading was obtained, so
 * nothing was compared. Callers must branch on `provenance`, never on the truthiness of
 * `fits`.
 */
export type WindowHeadroomVerdict =
  | {
      provenance: "live";
      fits: boolean;
      plannedRuns: number;
      /** Every measured window, each judged against its own live reading. */
      rows: WindowHeadroomRow[];
      /** The row that binds — fewest runs of headroom. */
      binding: WindowHeadroomRow;
      /** Null on this branch: a comparison WAS made, so there is nothing to excuse. */
      reason: null;
      message: string;
    }
  | {
      provenance: "not-checked";
      fits: null;
      plannedRuns: number;
      rows: WindowHeadroomRow[];
      binding: null;
      /** Why no comparison was made. Always populated in this branch. */
      reason: string;
      message: string;
    };

/**
 * Live pre-launch check: `plannedRuns` against the REMAINING capacity of the window the run
 * is about to enter (an issue item 2).
 *
 * ## How this differs from {@link checkWindowFit}, and why both exist
 * `checkWindowFit` compares a configuration against a FULL FRESH window. It is arithmetic
 * over constants, so it can run before anything is provisioned and it refuses the case that
 * can never work in any window. What it cannot see is the window you are actually launching
 * into: an 8-run config passes it and then dies at run 4 of a half-spent window.
 *
 * This function closes that half, and the two verdicts are deliberately SEPARATE types
 * rather than one object with a mode flag. A structural pass and a live pass are different
 * claims, and the way that distinction gets lost is a reader glancing at a shared `ok: true`.
 *
 * ## The reading is taken, not assumed
 * The input is the launch {@link QuotaCapture} the rig already takes for `quota.json`, so
 * the gate and the run's own evidence are the SAME reading — one probe, and a report whose
 * launch numbers are the numbers the gate judged. Re-probing here would cost a second
 * reading (up to 8 Gemini calls on kimi, an issue) and could disagree with the record.
 *
 * ## Where the estimate is soft, stated plainly
 * `remainingRuns` scales a measured fresh-window capacity linearly by percent remaining.
 * That assumes runs cost roughly the same throughout a window, which is untested, and the
 * kimi 5h capacity behind it is n=1. So this is a gate against configurations that clearly
 * do not fit, not a precision instrument — which is why it takes `floor` and why a refusal
 * is overridable.
 *
 * ## The third state
 * If the capture did not produce a number for a measured window — probe failed, panel
 * unreadable, provider not probeable, no capacity measured — the verdict is
 * `fits: null` / `provenance: "not-checked"` with a reason, and the caller launches. Never
 * a silent pass: an unreadable probe treated as "plenty of quota" would wave through exactly
 * the runs this exists to stop, and treated as "no quota" would refuse valid launches. It is
 * neither, and it says so.
 */
export function checkWindowHeadroom(
  scenario: Scenario,
  opts: { provider?: string; arms?: number; launch?: QuotaCapture | null } = {}
): WindowHeadroomVerdict {
  const plannedRuns = plannedProviderRuns(scenario, opts.arms);
  const provider = opts.provider ?? "";
  const capacities = MEASURED_RUNS_PER_FRESH_WINDOW[provider];
  const notChecked = (reason: string, rows: WindowHeadroomRow[] = []): WindowHeadroomVerdict => ({
    provenance: "not-checked",
    fits: null,
    plannedRuns,
    rows,
    binding: null,
    reason,
    message:
      `window headroom: NOT CHECKED — ${reason}. ${plannedRuns} planned provider run(s) went ` +
      "un-compared against the live window; this is not a pass, and the run is launching " +
      "without that check.",
  });

  if (capacities === undefined || capacities.length === 0) {
    return notChecked(`no measured window capacity for provider "${provider || "(unset)"}"`);
  }
  const launch = opts.launch ?? null;
  if (launch === null) return notChecked("no launch quota reading was supplied");
  if (launch.outcome !== "read") {
    return notChecked(`the launch reading is ${launch.outcome} — "${launch.message}"`);
  }

  const rows: WindowHeadroomRow[] = [];
  const missing: QuotaWindowKind[] = [];
  for (const capacity of capacities) {
    const reading = launch.windows.find(
      (w) => w.kind === capacity.window && w.percentLeft !== null
    );
    if (reading === undefined || reading.percentLeft === null) {
      missing.push(capacity.window);
      continue;
    }
    const remainingRuns = Math.floor((capacity.runs * reading.percentLeft) / 100);
    rows.push({
      window: capacity.window,
      label: reading.label,
      percentLeft: reading.percentLeft,
      capacityRuns: capacity.runs,
      remainingRuns,
      headroomRuns: remainingRuns - plannedRuns,
    });
  }

  // A window we have a capacity for but no reading of is un-judged, and the run could die on
  // it. Report what WAS compared, but do not let a partial comparison read as a full one.
  if (missing.length > 0) {
    return notChecked(
      `the launch reading carries no number for the ${missing.join(", ")} window(s), which ` +
        `${missing.length === 1 ? "is" : "are"} measured for ${provider} and could be the one ` +
        "that runs out",
      rows
    );
  }

  let binding = rows[0];
  for (const row of rows) if (row.headroomRuns < binding.headroomRuns) binding = row;
  const detail = rows
    .map(
      (r) =>
        `${r.label} ${r.percentLeft}% left ≈ ${r.remainingRuns} run(s) of a measured ${r.capacityRuns}`
    )
    .join("; ");

  if (binding.headroomRuns >= 0) {
    return {
      provenance: "live",
      fits: true,
      plannedRuns,
      rows,
      binding,
      reason: null,
      message:
        `window headroom: OK (live) — ${plannedRuns} planned run(s), ${binding.remainingRuns} ` +
        `estimated remaining on the binding ${binding.window} window ` +
        `(${binding.headroomRuns} run(s) spare). ${detail}. Estimate scales a measured fresh-` +
        "window capacity by percent remaining; it is a floor on a soft number, not a promise.",
    };
  }

  return {
    provenance: "live",
    fits: false,
    plannedRuns,
    rows,
    binding,
    reason: null,
    message:
      `the live ${provider} window does not have room for this run: it plans ${plannedRuns} ` +
      `provider run(s) (${scenario.steps.length} step(s) x ${opts.arms ?? 2} arm(s)) but the ` +
      `${binding.label} row reads ${binding.percentLeft}% left, which a measured fresh capacity ` +
      `of ${binding.capacityRuns} puts at about ${binding.remainingRuns} run(s) — short by ` +
      `${-binding.headroomRuns}. ${detail}.\n` +
      "  This is the launch reading the run would have recorded anyway, not a separate probe.\n" +
      `  Fix (free):      wait for the ${binding.window} window to roll, then relaunch into a ` +
      "fresh one.\n" +
      "  Fix (cheap):     shrink the run. PORTABLE_CONTEXT_MAX_RUNS=1 with --filler-per-gap 1 " +
      "is the smallest configuration that still ages a decision out.\n" +
      "  Override:        --allow-over-window, if you are deliberately spending a partial run.",
  };
}

/**
 * Throw unless the LIVE window has room. `not-checked` never throws — see
 * {@link checkWindowHeadroom} on why an unreadable probe must not become a refusal.
 */
export function assertWindowHeadroom(
  scenario: Scenario,
  opts: {
    provider?: string;
    arms?: number;
    launch?: QuotaCapture | null;
    allowOverWindow?: boolean;
  } = {}
): WindowHeadroomVerdict {
  const verdict = checkWindowHeadroom(scenario, opts);
  if (verdict.fits === false && !opts.allowOverWindow) throw new Error(verdict.message);
  return verdict;
}
