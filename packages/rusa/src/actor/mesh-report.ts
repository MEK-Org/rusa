import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { type MeshEvent, MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { generateHandle } from "./handle-generator.js";
import type { ThreadRecord } from "./thread-registry.js";

/**
 * Generate a self-contained HTML report of an actor-mesh run from its durable
 * artifacts: the thread registry (`threads.json` — who exists, the ownership tree
 * and address-book graph) and the append-only `mesh_events` log (what happened —
 * messages routed, wakes, spawns, retires, run outputs).
 *
 * This is the "rich log" v1: a single chronological timeline you can filter down
 * to one actor (click any actor to zoom into just its messages and run output).
 * Because every event carries an ordering and a timestamp, the same data backs a
 * future scrubbable DES timeline with no schema change — only a front-end one.
 *
 * Read-only: the DB is opened readonly and `threads.json` is only parsed, so it
 * is safe to run against a live instance.
 */
export function generateMeshReport(opts: { home: string; out?: string }): {
  outPath: string;
  counts: { actors: number; events: number; messages: number; runs: number };
} {
  const dbPath = join(opts.home, "data", "mesh.db");
  if (!existsSync(dbPath)) {
    throw new Error(`No rusa DB found at ${dbPath} (is --home the instance home?)`);
  }
  const outPath = opts.out ?? join(opts.home, "mesh-report.html");

  const records = readRegistry(join(opts.home, "threads.json"));

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let events: MeshEvent[];
  try {
    const hasTable =
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'mesh_events'`)
        .get() !== undefined;
    events = hasTable ? new MeshEventRepository(db).list() : [];
  } finally {
    db.close();
  }

  const html = renderReport({ home: opts.home, records, events });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");

  return {
    outPath,
    counts: {
      actors: records.length,
      events: events.length,
      messages: events.filter((e) => e.kind === "message_sent").length,
      runs: events.filter((e) => e.kind === "run_end").length,
    },
  };
}

function readRegistry(file: string): ThreadRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { threads?: ThreadRecord[] };
    return parsed.threads ?? [];
  } catch {
    return [];
  }
}

/** Max rendered chars per artifact panel; longer text is truncated with a note. */
const MAX_PANEL_CHARS = 200_000;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pre(text: string | null | undefined): string {
  if (text == null || text === "") return `<p class="muted">(empty)</p>`;
  let body = text;
  let note = "";
  if (body.length > MAX_PANEL_CHARS) {
    note = `<p class="muted">… truncated (${body.length.toLocaleString()} chars total)</p>`;
    body = body.slice(0, MAX_PANEL_CHARS);
  }
  return `<pre>${esc(body)}</pre>${note}`;
}

function panel(summary: string, bodyHtml: string): string {
  return `<details><summary>${esc(summary)}</summary><div class="panel">${bodyHtml}</div></details>`;
}

function chip(text: string, cls = ""): string {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function firstLine(text: string | null | undefined, max = 120): string {
  if (!text) return "";
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A short, stable label for an actor id (root shows as "root-actor"; uuids get a friendly handle). */
function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return generateHandle(id);
}

function statusChipClass(status: string): string {
  switch (status) {
    case "active":
      return "ok";
    case "retired":
      return "muted-chip";
    default:
      return "warn";
  }
}

interface EventVisual {
  ico: string;
  cls: string;
  title: string;
}

function eventVisual(e: MeshEvent): EventVisual {
  switch (e.kind) {
    case "message_sent":
      return { ico: "✉️", cls: "msg", title: "message" };
    case "run_queued":
      return { ico: "⏳", cls: "run-start", title: "run queued" };
    case "run_start":
      return { ico: "▶", cls: "run-start", title: "run start" };
    case "run_end":
      return {
        ico: e.success ? "✅" : "❌",
        cls: e.success ? "run-ok" : "run-err",
        title: "run end",
      };
    case "actor_spawned":
      return { ico: "✨", cls: "spawn", title: "spawned" };
    case "actor_retired":
      return { ico: "🪦", cls: "retire", title: "retired" };
    case "handle_granted":
      return { ico: "🔗", cls: "handle", title: "handle granted" };
    case "root_control_action":
      return { ico: "⌘", cls: "handle", title: "root control" };
    default:
      return { ico: "•", cls: "other", title: e.kind };
  }
}

/** The two actor ids an event touches — used as filter keys for "zoom into actor". */
function eventActors(e: MeshEvent): string[] {
  let counterparty: string | null = null;
  if (e.payload) {
    try {
      const p = JSON.parse(e.payload);
      counterparty =
        p.to ??
        p.from ??
        p.parentId ??
        p.handleId ??
        p.grantedBy ??
        p.targetId ??
        p.by ??
        p.subscribedBy ??
        null;
    } catch {}
  }
  return [e.actorId, counterparty].filter((x): x is string => Boolean(x));
}

function renderEventCard(e: MeshEvent, labelFor: (id: string) => string): string {
  const v = eventVisual(e);
  const actor = e.actorId ? labelFor(e.actorId) : "";
  let peerId: string | null = null;
  if (e.payload) {
    try {
      const p = JSON.parse(e.payload);
      peerId =
        p.to ??
        p.from ??
        p.parentId ??
        p.handleId ??
        p.grantedBy ??
        p.targetId ??
        p.by ??
        p.subscribedBy ??
        null;
    } catch {}
  }
  const peer = peerId ? labelFor(peerId) : "";

  // Direction-aware headline per kind.
  let headline: string;
  switch (e.kind) {
    case "message_sent":
    case "message_received": {
      let senderId: string | null = null;
      let recipientId: string | null = null;
      if (e.payload) {
        try {
          const p = JSON.parse(e.payload);
          if (e.kind === "message_sent") {
            senderId = e.actorId;
            recipientId = p.to;
          } else {
            recipientId = e.actorId;
            senderId = p.from;
          }
        } catch {}
      }
      const s = senderId ? labelFor(senderId) : "";
      const r = recipientId ? labelFor(recipientId) : "";
      headline = `<strong>${esc(s)}</strong> → <strong>${esc(r)}</strong>`;
      break;
    }
    case "actor_spawned":
      headline = `<strong>${esc(peer)}</strong> spawned <strong>${esc(actor)}</strong>`;
      break;
    case "handle_granted":
      headline = `<strong>${esc(actor)}</strong> can now message <strong>${esc(peer)}</strong>`;
      break;
    case "root_control_action":
      headline = peer
        ? `<strong>${esc(actor)}</strong> acted on <strong>${esc(peer)}</strong>`
        : `<strong>${esc(actor)}</strong> delegated root control`;
      break;
    default:
      headline = `<strong>${esc(actor)}</strong>`;
  }

  const head = [
    `<span class="ico">${v.ico}</span>`,
    `<span class="kind">${esc(v.title)}</span>`,
    headline,
    e.detail ? chip(firstLine(e.detail, 80), "muted-chip") : "",
    e.success === false ? chip("failed", "err") : "",
    `<span class="ts">${esc(e.ts)}</span>`,
  ]
    .filter(Boolean)
    .join(" ");

  // Body: durable message text or run output.
  const bodyHtml: string[] = [];
  if (e.kind === "message_sent" && e.body) {
    bodyHtml.push(panel("message body", pre(e.body)));
  }
  if (e.kind === "run_end" && e.body) {
    bodyHtml.push(panel("run output", pre(e.body)));
  }

  const actors = eventActors(e).join(" ");
  return (
    `<div class="card ${v.cls}" data-actors="${esc(actors)}">` +
    `<div class="card-head">${head}</div>${bodyHtml.join("")}</div>`
  );
}

function renderTopology(records: ThreadRecord[], counts: Map<string, number>): string {
  const byParent = new Map<string | null, ThreadRecord[]>();
  for (const r of records) {
    const key = r.parentId ?? null;
    const siblings = byParent.get(key) ?? [];
    siblings.push(r);
    byParent.set(key, siblings);
  }
  const known = new Set(records.map((r) => r.id));

  const renderNode = (r: ThreadRecord): string => {
    const meta = [
      chip(r.status, statusChipClass(r.status)),
      ...(r.modelConfig ?? []).map((c) =>
        chip(
          `${c.provider}${c.model ? `:${c.model}` : ""}${c.effort ? ` @ ${c.effort}` : ""}`,
          "muted-chip"
        )
      ),
      r.budget?.maxRuns != null
        ? chip(`runs ${r.budget.runsUsed ?? 0}/${r.budget.maxRuns}`, "muted-chip")
        : "",
      counts.has(r.id) ? chip(`${counts.get(r.id)} events`, "muted-chip") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const handles =
      r.handles && r.handles.length > 0
        ? `<div class="handles">↔ ${r.handles
            .map(
              (h) =>
                `<button class="actor-link" title="${esc(h.id)}" data-actor="${esc(h.id)}">${esc(shortId(h.id))}</button>${h.role ? ` <span class="muted">(${esc(h.role)})</span>` : ""}`
            )
            .join(", ")}</div>`
        : "";
    const children = (byParent.get(r.id) ?? []).map((c) => `<li>${renderNode(c)}</li>`).join("");
    return (
      `<div class="node">` +
      `<button class="actor-link strong" title="${esc(r.id)}" data-actor="${esc(r.id)}">${esc(shortId(r.id))}</button> ` +
      meta +
      `<div class="charter">${esc(firstLine(r.charter, 160))}</div>` +
      handles +
      `</div>` +
      (children ? `<ul>${children}</ul>` : "")
    );
  };

  // Roots: records with no parent, plus any whose parent is unknown (orphans).
  const roots = records.filter((r) => r.parentId == null || !known.has(r.parentId));
  if (roots.length === 0) return `<p class="muted">No actors in the registry.</p>`;
  return `<ul class="tree">${roots.map((r) => `<li>${renderNode(r)}</li>`).join("")}</ul>`;
}

function renderReport(data: {
  home: string;
  records: ThreadRecord[];
  events: MeshEvent[];
}): string {
  const labelById = new Map(data.records.map((r) => [r.id, shortId(r.id)]));
  const labelFor = (id: string): string => labelById.get(id) ?? shortId(id);

  const eventCounts = new Map<string, number>();
  for (const e of data.events) {
    for (const a of eventActors(e)) eventCounts.set(a, (eventCounts.get(a) ?? 0) + 1);
  }

  const timeline =
    data.events.length > 0
      ? `<div class="timeline">${data.events.map((e) => renderEventCard(e, labelFor)).join("")}</div>`
      : `<p class="muted">No mesh events recorded yet.</p>`;

  const summary = [
    chip(`${data.records.length} actors`),
    chip(`${data.events.length} events`),
    chip(`${data.events.filter((e) => e.kind === "message_sent").length} messages`),
    chip(`${data.events.filter((e) => e.kind === "run_end").length} runs`),
  ].join(" ");

  // Build a static set of actor ids that exist, so the filter banner can offer
  // a labeled button per actor referenced anywhere.
  const allActorIds = new Set<string>([
    ...data.records.map((r) => r.id),
    ...data.events.flatMap(eventActors),
  ]);
  const actorButtons = [...allActorIds]
    .map((id) => `<button class="actor-link" data-actor="${esc(id)}">${esc(labelFor(id))}</button>`)
    .join(" ");

  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Silicon Familiar — mesh report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 0 0 4rem; line-height: 1.45; background: #f6f7f9; color: #1c2024; }
  header { background: #15203a; color: #fff; padding: 1.1rem 1.4rem; position: sticky; top: 0; z-index: 5; }
  header h1 { margin: 0 0 .35rem; font-size: 1.2rem; }
  header .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .73rem; opacity: .8; }
  .toolbar { margin-top: .6rem; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  .toolbar button { font: inherit; font-size: .8rem; padding: .25rem .7rem; border-radius: 6px;
    border: 1px solid #ffffff55; background: #ffffff1a; color: #fff; cursor: pointer; }
  main { max-width: 1100px; margin: 0 auto; padding: 1.25rem; }
  section { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px;
    margin: 0 0 1.5rem; padding: 1rem 1.1rem 1.1rem; box-shadow: 0 1px 2px #0000000a; }
  section h2 { margin: 0 0 .7rem; font-size: 1.05rem; }
  ul.tree, ul.tree ul { list-style: none; margin: 0; padding-left: 1.1rem; }
  ul.tree > li { margin: .3rem 0; }
  ul.tree ul { border-left: 2px solid #e9ecf1; margin-left: .3rem; }
  .node { padding: .25rem 0; }
  .charter { font-size: .85rem; color: #495057; margin: .15rem 0 .1rem; }
  .handles { font-size: .78rem; color: #677281; }
  .actor-link { font: inherit; font-size: .78rem; cursor: pointer; border: 1px solid #cfd6df;
    background: #eef1f4; color: #2b3a55; border-radius: 999px; padding: .03rem .5rem; }
  .actor-link.strong { font-weight: 700; font-size: .82rem; background: #dfe7fb; border-color: #b8c7f0; }
  .actor-link.active { background: #4263eb; color: #fff; border-color: #4263eb; }
  #filter-banner { display: none; align-items: center; gap: .5rem; margin: 0 0 1rem;
    background: #fff8e1; border: 1px solid #f3e3a0; border-radius: 8px; padding: .5rem .8rem; font-size: .85rem; }
  #filter-banner.on { display: flex; }
  .timeline { border-left: 2px solid #e3e6ea; margin: .25rem 0; padding-left: .9rem; }
  .card { border: 1px solid #e3e6ea; border-radius: 8px; padding: .5rem .7rem; margin: 0 0 .55rem; background: #fcfcfd; }
  .card.msg       { border-left: 3px solid #4c6ef5; }
  .card.run-start { border-left: 3px solid #adb5bd; }
  .card.run-ok    { border-left: 3px solid #2f9e44; }
  .card.run-err   { border-left: 3px solid #e03131; }
  .card.spawn     { border-left: 3px solid #ae3ec9; }
  .card.retire    { border-left: 3px solid #868e96; }
  .card.handle    { border-left: 3px solid #1098ad; }
  .card-head { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
  .ico { font-size: .95rem; }
  .kind { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: #868e96; }
  .ts { margin-left: auto; font-size: .72rem; color: #868e96; font-family: ui-monospace, monospace; }
  .chip { display: inline-block; font-size: .72rem; padding: .08rem .45rem; border-radius: 999px;
    background: #edf0f3; color: #313a45; white-space: nowrap; }
  .chip.ok { background: #d3f9d8; color: #137333; }
  .chip.err { background: #ffe3e3; color: #c0341d; }
  .chip.warn { background: #fff3bf; color: #8a6d00; }
  .chip.muted-chip { background: #eef1f4; color: #677281; }
  .reason { margin: .4rem 0 .2rem; font-size: .88rem; white-space: pre-wrap; word-break: break-word; }
  p.muted, .muted { color: #868e96; }
  details { margin: .35rem 0 0; }
  summary { cursor: pointer; font-size: .82rem; color: #4263eb; user-select: none; }
  .panel { margin: .3rem 0 .2rem; }
  pre { background: #0d1117; color: #e6edf3; padding: .7rem .8rem; border-radius: 6px; overflow: auto;
    max-height: 460px; font-size: .76rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<header>
  <h1>🛰️ Silicon Familiar — mesh report</h1>
  <div class="path">${esc(data.home)}</div>
  <div class="toolbar">${summary}
    <button onclick="document.querySelectorAll('details').forEach(d=>d.open=true)">Expand all</button>
    <button onclick="document.querySelectorAll('details').forEach(d=>d.open=false)">Collapse all</button>
  </div>
  <div class="path" style="margin-top:.4rem">generated ${esc(generatedAt)}</div>
</header>
<main>
  <section>
    <h2>Topology</h2>
    ${renderTopology(data.records, eventCounts)}
    <div style="margin-top:.7rem; font-size:.8rem">Zoom into an actor: ${actorButtons || `<span class="muted">none</span>`}</div>
  </section>

  <div id="filter-banner">
    <span>Showing only events touching <strong id="filter-label"></strong></span>
    <button class="actor-link" id="filter-clear">show all</button>
  </div>

  <section>
    <h2>Timeline</h2>
    ${timeline}
  </section>
</main>
<script>
  (function () {
    var banner = document.getElementById('filter-banner');
    var label = document.getElementById('filter-label');
    var cards = Array.prototype.slice.call(document.querySelectorAll('.timeline .card'));
    function apply(actor) {
      cards.forEach(function (c) {
        var ids = (c.getAttribute('data-actors') || '').split(' ');
        c.style.display = !actor || ids.indexOf(actor) !== -1 ? '' : 'none';
      });
      document.querySelectorAll('.actor-link').forEach(function (b) {
        b.classList.toggle('active', !!actor && b.getAttribute('data-actor') === actor);
      });
      if (actor) { label.textContent = actor; banner.classList.add('on'); }
      else { banner.classList.remove('on'); }
    }
    document.querySelectorAll('.actor-link[data-actor]').forEach(function (b) {
      b.addEventListener('click', function () { apply(b.getAttribute('data-actor')); });
    });
    document.getElementById('filter-clear').addEventListener('click', function () { apply(null); });
  })();
</script>
</body>
</html>
`;
}
