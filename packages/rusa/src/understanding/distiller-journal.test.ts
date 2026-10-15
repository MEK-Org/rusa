import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJournalEntry,
  buildIndexRun,
  dateKeyFromRunId,
  type IndexRun,
  renderReportMarkdown,
  resolveRunFile,
  upsertIndexRun,
} from "./distiller-journal.js";
import { iuReportPaths } from "./persistence-utils.js";

describe("dateKeyFromRunId", () => {
  it("keys on the UTC calendar date of the window end", () => {
    expect(dateKeyFromRunId("2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z")).toBe(
      "2026-07-15"
    );
  });
  it("falls back to a sanitized second half when it does not parse as a date", () => {
    expect(dateKeyFromRunId("from__not-a-date")).toBe("not-a-date");
  });
});

describe("resolveRunFile — same-date collisions", () => {
  let mcHome: string;
  beforeEach(() => {
    mcHome = mkdtempSync(join(tmpdir(), "iu-journal-"));
  });
  afterEach(() => {
    rmSync(mcHome, { recursive: true, force: true });
  });

  it("suffixes a same-date re-run with a different run_id", () => {
    const paths = iuReportPaths(mcHome);
    const runA = "2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z";
    const runB = "2026-07-14T09:00:00.000Z__2026-07-15T09:00:00.000Z"; // same window-end date

    appendJournalEntry(
      paths,
      runA,
      {
        type: "run_meta",
        window: { from: "a", to: "b", includesMesh: true },
        gate: { active: true, eventCount: 1 },
        cursor_before: "a",
        distiller_actor: "t",
      },
      { now: "t0" }
    );

    const a = resolveRunFile(paths, runA, { create: false });
    expect(a.journalPath.endsWith("journal/2026-07-15.jsonl")).toBe(true);

    // A different run on the same date must not reuse runA's file — it takes the -2 slot.
    const b = resolveRunFile(paths, runB, { create: true });
    expect(b.date).toBe("2026-07-15-2");

    // Re-resolving runA still finds its original file, not the suffixed one.
    const aAgain = resolveRunFile(paths, runA, { create: true });
    expect(aAgain.date).toBe("2026-07-15");
  });

  it("assigns monotonic seq across appends", () => {
    const paths = iuReportPaths(mcHome);
    const run = "2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z";
    const r0 = appendJournalEntry(
      paths,
      run,
      {
        type: "run_meta",
        window: { from: "a", to: "b", includesMesh: true },
        gate: { active: true, eventCount: 1 },
        cursor_before: "a",
        distiller_actor: "t",
      },
      { now: "t0" }
    );
    const r1 = appendJournalEntry(
      paths,
      run,
      {
        type: "decision",
        theme: "x",
        disposition: "distilled",
        sources: [],
        node_ops: [],
        conclusion: "c",
      },
      { now: "t1" }
    );
    expect(r0.seq).toBe(0);
    expect(r1.seq).toBe(1);

    const lines = readFileSync(paths.journalPath("2026-07-15"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ v: 1, type: "run_meta", run_id: run, seq: 0, ts: "t0" });
  });

  it("accepts splice in decision node_ops", () => {
    const paths = iuReportPaths(mcHome);
    const run = "2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z";
    appendJournalEntry(
      paths,
      run,
      {
        type: "decision",
        theme: "splice test",
        disposition: "distilled",
        sources: [{ kind: "github_issue", ref: "o/rISSUE_NUM" }],
        node_ops: [
          {
            op: "splice",
            node_id: "N1",
            node_title: "Title",
            summary: "Spliced in place",
          },
        ],
        conclusion: "c",
      },
      { now: "t0" }
    );
    const lines = readFileSync(paths.journalPath("2026-07-15"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.node_ops[0]).toMatchObject({
      op: "splice",
      node_id: "N1",
      summary: "Spliced in place",
    });
  });
});

describe("renderReportMarkdown", () => {
  it("always renders both blind-spot sentinels when a run is empty", () => {
    const md = renderReportMarkdown([
      {
        type: "run_meta",
        window: {
          from: "2026-07-14T03:00:00.000Z",
          to: "2026-07-15T03:00:00.000Z",
          includesMesh: true,
        },
      },
    ]);
    expect(md).toContain("# IU Distill — 2026-07-15");
    expect(md).toContain("_Nothing distilled this run._");
    expect(md).toContain("_Nothing skipped this run._");
  });

  it("renders a distilled decision with confidence, node ops, and sources", () => {
    const md = renderReportMarkdown([
      {
        type: "decision",
        disposition: "distilled",
        theme: "Kimi creds reversal",
        conclusion: "Recorded the reversal.",
        confidence: "high",
        confidence_reason: "Explicit ruling.",
        node_ops: [
          {
            op: "update_contents",
            node_id: "N1",
            node_title: "Actor Mesh",
            mode: "append",
            summary: "Appended a section",
            supersedes: "prior framing",
          },
        ],
        sources: [{ kind: "github_pr", ref: "o/rISSUE_NUM", title: "Switch probe" }],
      },
    ]);
    expect(md).toContain("### Kimi creds reversal");
    expect(md).toContain("Confidence: **high** — Explicit ruling.");
    expect(md).toContain("**Actor Mesh** (update_contents, append) — Appended a section");
    expect(md).toContain("supersedes: prior framing");
    expect(md).toContain("`o/rISSUE_NUM` (github_pr) — Switch probe");
  });

  it("renders a splice node op in report markdown", () => {
    const md = renderReportMarkdown([
      {
        type: "decision",
        disposition: "distilled",
        theme: "Obligation re-ready ruling",
        conclusion: "Corrected waiting->ready behavior to keep-rank in place.",
        confidence: "high",
        node_ops: [
          {
            op: "splice",
            node_id: "N2",
            node_title: "Actor Mesh Conventions",
            summary: "Spliced head-return passage to reflect 8/15 keep-rank ruling",
            supersedes: "earlier 8/13 Q23 head-return",
          },
        ],
        sources: [
          {
            kind: "github_issue_comment",
            ref: "o/rISSUE_NUMISSUE_NUM",
            title: "Operator ruling",
          },
        ],
      },
    ]);
    expect(md).toContain("### Obligation re-ready ruling");
    expect(md).toContain(
      "**Actor Mesh Conventions** (splice) — Spliced head-return passage to reflect 8/15 keep-rank ruling"
    );
    expect(md).toContain("supersedes: earlier 8/13 Q23 head-return");
  });

  it("renders 'mode live' when unsyncedCount is 0", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", sync: { unsyncedCount: 0 } },
    ]);
    expect(md).toContain("mode live");
  });

  it("renders nothing about mode when unsyncedCount is absent", () => {
    const md = renderReportMarkdown([{ type: "run_meta" }, { type: "run_summary", sync: {} }]);
    expect(md).not.toContain("mode");
  });

  it("renders 'mode live' when unsyncedCount is > 0 without inventing a new mode", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", sync: { unsyncedCount: 3 } },
    ]);
    expect(md).toContain("mode live");
    expect(md).not.toContain("held");
  });

  it("reads the last run_summary and derives the counts from the decision lines", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "decision", disposition: "distilled", theme: "A", conclusion: "a" },
      { type: "decision", disposition: "distilled", theme: "B", conclusion: "b" },
      { type: "decision", disposition: "skipped", theme: "C", skip_reason: "c" },
      {
        type: "run_summary",
        advanced: true,
        cursor_after: "SUPERSEDED",
        counts: { decisions: 99, distilled: 99, skipped: 99 },
      },
      {
        type: "run_summary",
        advanced: true,
        cursor_after: "CORRECTED",
        counts: { decisions: 42 },
      },
    ]);
    // The journal is append-only, so the correction is the later line.
    expect(md).toContain("CORRECTED");
    expect(md).not.toContain("SUPERSEDED");
    // Neither summary's claim survives contact with the decisions it wrote.
    expect(md).toContain(
      "- Decisions: 3 (distilled 2 · adjudicated_away 0 · skipped 1 · deferred 0)"
    );
    expect(md).not.toContain("99");
    expect(md).not.toContain("42");
  });

  it("states a nodes_touched disagreement instead of silently picking a side", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "decision",
        disposition: "distilled",
        theme: "A",
        conclusion: "a",
        node_ops: [
          { op: "update_contents", node_id: "N1" },
          { op: "update_contents", node_id: "N2" },
        ],
      },
      {
        type: "run_summary",
        advanced: true,
        cursor_after: "c1",
        counts: { nodes_touched: 1, iu_hints: 4 },
      },
    ]);
    expect(md).toContain(
      "- Nodes touched: unknown (summary says 1, decisions name 2 distinct) · node ops: 2 · IU-hints: 4"
    );
  });

  it("counts one node touched twice as one node and two ops, not a disagreement ", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "decision",
        disposition: "distilled",
        theme: "A",
        conclusion: "a",
        node_ops: [{ op: "update_contents", node_id: "N1" }],
      },
      {
        type: "decision",
        disposition: "distilled",
        theme: "B",
        conclusion: "b",
        node_ops: [{ op: "update_contents", node_id: "N1" }],
      },
      {
        type: "run_summary",
        advanced: true,
        cursor_after: "c1",
        counts: { nodes_touched: 1, iu_hints: 0 },
      },
    ]);
    expect(md).toContain("- Nodes touched: 1 · node ops: 2 · IU-hints: 0");
    expect(md).not.toContain("unknown (summary says");
  });

  it("renders an unmeasured sync figure as unknown rather than zero", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", advanced: true, cursor_after: "c1", sync: {} },
    ]);
    const syncLine = md.split("\n").find((l) => l.startsWith("- Sync:"));
    expect(syncLine).toBe("- Sync: unsynced unknown · consecutive failures unknown");
    expect(syncLine).not.toContain("0");
  });

  it("reports an unsupplied iu_hints count as unknown rather than zero", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", advanced: true, cursor_after: "c1", counts: { decisions: 0 } },
    ]);
    expect(md).toContain("IU-hints: unknown");
  });
});

describe("index building", () => {
  it("derives window and run_id from the run_id when run_meta is absent", () => {
    const run = buildIndexRun(
      [
        {
          type: "run_summary",
          advanced: true,
          run_id: "2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z",
        },
      ],
      {
        date: "2026-07-15",
        relJournalPath: "journal/2026-07-15.jsonl",
        relReportPath: "rendered/2026-07-15.md",
        generatedAt: "t",
      }
    );
    expect(run.run_id).toBe("2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z");
    expect(run.windowFrom).toBe("2026-07-14T03:00:00.000Z");
    expect(run.windowTo).toBe("2026-07-15T03:00:00.000Z");
    expect(run.status).toBe("complete");
  });

  it("takes the run status from the correcting summary, not the superseded one", () => {
    const run = buildIndexRun(
      [
        { type: "run_summary", advanced: false, run_id: "R" },
        { type: "run_summary", advanced: true, run_id: "R" },
      ],
      {
        date: "2026-07-15",
        relJournalPath: "journal/2026-07-15.jsonl",
        relReportPath: "rendered/2026-07-15.md",
        generatedAt: "t",
      }
    );
    expect(run.status).toBe("complete");
  });

  it("omits a count it cannot settle rather than writing a zero into the index", () => {
    const run = buildIndexRun(
      [
        { type: "run_meta" },
        {
          type: "decision",
          disposition: "distilled",
          theme: "A",
          conclusion: "a",
          node_ops: [{ op: "update_contents", node_id: "N1" }],
        },
        { type: "run_summary", advanced: true, run_id: "R", counts: { nodes_touched: 5 } },
      ],
      {
        date: "2026-07-15",
        relJournalPath: "journal/2026-07-15.jsonl",
        relReportPath: "rendered/2026-07-15.md",
        generatedAt: "t",
      }
    );
    expect(run.counts.decisions).toBe(1);
    // Contested and unsupplied counts are absent, not defaulted — a consumer that
    // finds no key knows it does not know.
    expect(run.counts).not.toHaveProperty("nodes_touched");
    expect(run.counts).not.toHaveProperty("iu_hints");
  });

  it("upserts by run_id rather than duplicating", () => {
    const mk = (n: number): IndexRun => ({
      date: "2026-07-15",
      run_id: "R",
      windowFrom: "a",
      windowTo: "b",
      journalPath: "journal/2026-07-15.jsonl",
      reportPath: "rendered/2026-07-15.md",
      status: "complete",
      counts: { decisions: n },
      generatedAt: "t",
    });
    const once = upsertIndexRun({ v: 1, runs: [] }, mk(1));
    const twice = upsertIndexRun(once, mk(2));
    expect(twice.runs).toHaveLength(1);
    expect(twice.runs[0].counts.decisions).toBe(2);
  });
});

describe("chat source coverage ", () => {
  it("reports UNKNOWN when the run said nothing about chat, rather than rendering nothing", () => {
    // The dangerous read of an omitted section is "nothing to report". Silence
    // about chat equally means "read no chat" or "never looked" — so it is
    // stated, not skipped.
    const md = renderReportMarkdown([{ type: "run_meta" }, { type: "run_summary" }]);
    expect(md).toContain("Chat coverage: **not reported**");
    expect(md).toContain("Treat as unknown");
  });

  it("says chat was outside the read set when membership is empty", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", chat_coverage: { configured_spaces: 0, spaces: [] } },
    ]);
    expect(md).toContain("**chat was not in this run's read set** (0 spaces in membership)");
    expect(md).toContain("Anything decided only in chat is invisible to this run");
    expect(md).not.toContain("ISSUE_NUM");
    // The empty case must never read as a clean bill of health.
    expect(md).not.toContain("Chat coverage: complete");
  });

  it("states the scope it read instead of claiming chat was covered", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "run_summary",
        chat_coverage: {
          configured_spaces: 2,
          spaces: [
            { space: "spaces/AAA", pagesWalked: 3, messagesRead: 41, exhausted: true },
            { space: "spaces/BBB", pagesWalked: 1, messagesRead: 2, exhausted: true },
          ],
        },
      },
    ]);
    expect(md).toContain("2 space(s) this identity is a member of — 43 messages over 4 pages");
    expect(md).toContain("every space in membership was walked to exhaustion");
    expect(md).toContain("an unwalked space is unknown, not absent ");
    expect(md).toContain("`spaces/AAA`: 41 messages over 3 pages (exhausted)");
  });

  it("does not call the walk exhaustive when membership is larger than the walk set", () => {
    // Every space it opened finished, but it opened 1 of 3. Under an enumerated
    // membership this is the common shape, and reading it as "exhaustive" would
    // report a clean bill for two spaces nobody looked at .
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "run_summary",
        chat_coverage: {
          configured_spaces: 3,
          spaces: [{ space: "spaces/AAA", pagesWalked: 1, messagesRead: 4, exhausted: true }],
        },
      },
    ]);
    expect(md).toContain("**2 space(s) in membership were never opened**");
    expect(md).not.toContain("every space in membership was walked to exhaustion");
  });

  it("marks a walk that stopped early as INCOMPLETE and names the reason", () => {
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "run_summary",
        chat_coverage: {
          configured_spaces: 2,
          spaces: [
            {
              space: "spaces/AAA",
              pagesWalked: 20,
              messagesRead: 500,
              exhausted: false,
              note: "page ceiling hit",
            },
            { space: "spaces/BBB", pagesWalked: 1, messagesRead: 2, exhausted: true },
          ],
        },
      },
    ]);
    expect(md).toContain("**1 of 2 walked spaces did not finish**");
    expect(md).toContain("(INCOMPLETE) — page ceiling hit");
  });

  it("flags a configured space that was never walked at all", () => {
    // configured 2, walked 0 — the run claimed a scope it did not read.
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", chat_coverage: { configured_spaces: 2, spaces: [] } },
    ]);
    expect(md).toContain("**no space was walked**");
  });

  it("carries chat counts into index.json only when the journal settles them", () => {
    const indexArgs = {
      date: "2026-07-15",
      relJournalPath: "journal/2026-07-15.jsonl",
      relReportPath: "rendered/2026-07-15.md",
      generatedAt: "t",
    };
    const withChat = buildIndexRun(
      [
        { type: "run_meta" },
        {
          type: "run_summary",
          chat_coverage: {
            configured_spaces: 2,
            spaces: [{ space: "spaces/AAA", pagesWalked: 1, messagesRead: 7, exhausted: true }],
          },
        },
      ],
      indexArgs
    );
    expect(withChat.counts.chat_spaces_configured).toBe(2);
    expect(withChat.counts.chat_messages_read).toBe(7);

    // Unreported chat is OMITTED, never coerced to 0 — a consumer that finds no
    // key knows it does not know, whereas a 0 reads as a measurement.
    const silent = buildIndexRun([{ type: "run_meta" }, { type: "run_summary" }], indexArgs);
    expect(silent.counts).not.toHaveProperty("chat_spaces_configured");
    expect(silent.counts).not.toHaveProperty("chat_messages_read");
  });
});

describe("GitHub source coverage ", () => {
  it("reports UNKNOWN when the run said nothing about which qualifiers it ran", () => {
    // Same reasoning as chat: an omitted section reads as "nothing to report",
    // when it equally means the run never said what it searched.
    const md = renderReportMarkdown([{ type: "run_meta" }, { type: "run_summary" }]);
    expect(md).toContain("GitHub coverage: **not reported**");
    expect(md).toContain("Treat as unknown");
  });

  it("calls an --updated-only sweep narrower than the window instead of covered", () => {
    // The measured bug: `updated:` filters on the item's CURRENT updatedAt, so an
    // item touched again after the window closes leaves the range entirely. The
    // sweep succeeds and returns rows, so nothing downstream can detect the loss.
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", github_coverage: { qualifiers: ["updated"] } },
    ]);
    expect(md).toContain("**narrower than the window**");
    expect(md).toContain("not a window query");
    expect(md).not.toContain("window-complete");
  });

  it("names the closed-qualifier gap separately from the created one", () => {
    // Two distinct holes, so a run missing only `--closed` must not be reported
    // as if it had also lost the window property.
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", github_coverage: { qualifiers: ["created", "updated"] } },
    ]);
    expect(md).toContain("**narrower than the window**");
    expect(md).toContain("a decision made by closing an item can be missed");
    expect(md).not.toContain("not a window query");
  });

  it("reports the full union as window-complete, and names the repos it covered", () => {
    // The positive case, and the one that makes the negatives above discriminating:
    // the same renderer must produce a materially different line here.
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "run_summary",
        github_coverage: {
          qualifiers: ["created", "updated", "closed"],
          repos: ["dummy-org/dummy-repo"],
          note: "deduplicated by number",
        },
      },
    ]);
    expect(md).toContain("`--created` + `--updated` + `--closed`");
    expect(md).toContain("over dummy-org/dummy-repo");
    expect(md).toContain("window-complete for the index read");
    expect(md).toContain("deduplicated by number");
    expect(md).not.toContain("narrower than the window");
  });

  it("accepts the qualifiers with or without their leading dashes", () => {
    // A run writing its own summary has no way to know which form is wanted, and
    // a mismatch would report a complete read as narrow — the false alarm that
    // trains readers to ignore the line.
    const md = renderReportMarkdown([
      { type: "run_meta" },
      {
        type: "run_summary",
        github_coverage: { qualifiers: ["--Created", " --updated ", "--closed"] },
      },
    ]);
    expect(md).toContain("window-complete for the index read");
    expect(md).not.toContain("narrower than the window");
  });

  it("says so when a coverage block names no qualifier at all", () => {
    // An empty list is not the same as no block: the run said something, and what
    // it said is that it cannot account for the read.
    const md = renderReportMarkdown([
      { type: "run_meta" },
      { type: "run_summary", github_coverage: { qualifiers: [] } },
    ]);
    expect(md).toContain("**no qualifiers reported**");
    expect(md).not.toContain("window-complete");
  });

  it("carries the qualifier count into index.json only when the run reported one", () => {
    const indexArgs = {
      date: "2026-08-17",
      relJournalPath: "journal/2026-08-17.jsonl",
      relReportPath: "rendered/2026-08-17.md",
      generatedAt: "t",
    };
    const reported = buildIndexRun(
      [
        { type: "run_meta" },
        {
          type: "run_summary",
          github_coverage: { qualifiers: ["created", "updated", "closed"] },
        },
      ],
      indexArgs
    );
    expect(reported.counts.github_qualifiers_run).toBe(3);

    // Unreported is OMITTED, never 0 — a 0 would read as "measured, found none".
    const silent = buildIndexRun([{ type: "run_meta" }, { type: "run_summary" }], indexArgs);
    expect(silent.counts).not.toHaveProperty("github_qualifiers_run");
  });
});
