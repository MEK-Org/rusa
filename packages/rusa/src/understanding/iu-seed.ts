import { MemoryLocalStore, SyncClient } from "@thkp-eng/goals-core";
import type { AnyOp } from "@thkp-eng/goals-types";
import { createNode } from "./graph-store.js";

/**
 * The **universal** Integrated Understanding bootstrap — the nodes that ship in-repo so a
 * glass-goals-**unconfigured** (remote-less) install has a real, non-empty IU with no remote
 * (ISSUE_NUM local-first). Deliberately universal-only: the root plus general-purpose
 * `Engineering Principles` and `Operating Conventions` (with the `IU-consulted:` attestation).
 *
 * Rusa-specific conventions (MCP-not-CLI, the subsystem nodes) are NOT seeded on purpose:
 * the instances that actually build rusa internals are *configured* and get the full
 * remote IU; a trial / local-first install grows its own specifics locally via the distiller.
 * So the seed is the right abstraction — the universal starting point — not a compromise.
 *
 * Authored as readable node-defs (below) rather than an opaque committed ops JSONL; the ops are
 * generated from them at load time via {@link buildSeedOps}, so they are always shape-valid.
 */

interface SeedNode {
  title: string;
  contents: string;
}

const ROOT: SeedNode = {
  title: "Integrated Knowledge Universe",
  contents: `The root of this instance's Integrated Understanding — its accumulating, canonical model of how the system works. Seeded with the universal engineering + operating conventions below; instance-specific understanding grows here over time.`,
};

const ENGINEERING_PRINCIPLES: SeedNode = {
  title: "Engineering Principles",
  contents: `General engineering principles for **any coding work** — provider-, repo-, and project-agnostic.

- **Prefer composition over inheritance** — assemble behavior from small, swappable pieces rather than deep type hierarchies.
- **Look for the 80/20** — capture most of the value for a fraction of the cost, and ship before gold-plating.
- **YAGNI** — build what the task needs now, not speculative generality; delete dead paths rather than carrying them.
- **Seams over concretions** — couple to interfaces/seams, not concrete implementations, so parts stay swappable and testable.
- **Verify, don't assume** — ground claims in real output (run it, read it); re-derive state rather than trusting stale memory or a plausible guess.
- **Determinism for bookkeeping** — machine-managed handles, cursors, and ids are computed deterministically, never hand-written by a model.
- **Make robustness mechanical, not advisory** — prefer a structural guard that *can't* be forgotten (fail-loud, no-silent-drop, bounded retries) over a convention someone must remember.
- **Bounded units, then hand off** — do a bounded piece of work and checkpoint/yield rather than blocking indefinitely.`,
};

const OPERATING_CONVENTIONS: SeedNode = {
  title: "Operating Conventions",
  contents: `A **bounded index every actor reads IN FULL before starting any work** — each line is a one-line *tripwire*: it states a constraint, then links the full source, so a relevant line trips you even when you didn't know to look. Deliberately lean.

**What earns a line here:** a rule whose enforcement depends on an actor's *memory or judgment before work*. Mechanically-enforced rules (capability-gated access, tested invariants — anything the system makes true by construction) do NOT belong here; they live with the docs of their mechanism.

Pairs with the **\`IU-consulted:\` attestation convention**: consult the IU (read this node in full, and search it for anything the task implicates) BEFORE domain work, then attest on the resulting issue/PR with a line on its own —

\`IU-consulted: <conventions checked> — <what applies + how reconciled, or "nothing applicable">\`

Reviewers check that the line **exists**, never grading its conclusion — a missing line is the anomaly.

## Operating tripwires
- **Ground before acting** — never guess external state; read it through a typed tool path, act only on real tool output, and re-derive each turn.

## Pointers
- General engineering principles for any coding work → **[Engineering Principles]**.
- Instance-specific engineering + system-design conventions grow here locally over time.`,
};

/**
 * Build the ops for a fresh universal IU graph (root + [Engineering Principles] +
 * [Operating Conventions]) for a remote-less install .
 *
 * Generated via a throwaway **null-persistence** {@link SyncClient} + the {@link createNode}
 * graph helpers, then extracted with `store.getUnsyncedOps()` — the same op-generation pattern
 * the tests use. The ops carry random ids/HLCs; if the instance later configures glass-goals,
 * the write client's init batch-push restamps + drains them cursor-visibly . **v1 scope:
 * fresh-install → EMPTY remote.** A seeded install that later connects to a *populated* remote
 * (one already holding these universal nodes) would **double-baseline** — the seed ops carry their
 * own random `op.id`s, so they push as NEW nodes rather than merging. Dedup/merge on
 * connect-to-nonempty is UNHANDLED in v1 (tracked in ISSUE_NUM).
 */
export async function buildSeedOps(rootNodeId?: string): Promise<AnyOp[]> {
  const store = new MemoryLocalStore();
  const client = new SyncClient(null, store);
  await client.init();
  const rootId = await createNode(client, { ...ROOT, id: rootNodeId });
  await createNode(client, { ...ENGINEERING_PRINCIPLES, parentId: rootId });
  await createNode(client, { ...OPERATING_CONVENTIONS, parentId: rootId });
  return store.getUnsyncedOps();
}
