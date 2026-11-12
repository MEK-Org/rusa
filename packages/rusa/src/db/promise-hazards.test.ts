import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { findPromiseHazards, formatPromiseHazard, type PromiseHazard } from "./promise-hazards.js";

/**
 * The gate on fixture programs, which fix what it catches and what it lets
 * through, and then the gate applied to this package, which is what fails a
 * pull request that adds an unawaited write or an async void-port
 * implementation (#1289).
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoots: string[] = [];
/** Each fixture is a fresh program over the standard library, which takes seconds under load. */
const FIXTURE_TIMEOUT = 60_000;

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

/** The ports a converted caller meets: a writer, and synchronous listener ports. */
const PORTS = `
export interface MeshWriter {
  write(op: string, input: unknown): Promise<{ id: string }>;
}
export interface EffectSink {
  deliver(effect: string): void;
}
export type Listener = (event: string) => void;
export function onEvent(listener: Listener): void {
  listener("ready");
}
export async function appendEntry(text: string): Promise<number> {
  return text.length;
}
`;

/**
 * Type-check `files` (beside the ports) as a package and run the gate over its
 * `src`, and over this package's when the files import it.
 */
function hazardsIn(files: Record<string, string>, { withPackage = false } = {}): string[] {
  const root = mkdtempSync(join(tmpdir(), "rusa-promise-hazards-"));
  fixtureRoots.push(root);
  const src = join(root, "src");
  mkdirSync(src);
  const names: string[] = [];
  for (const [name, text] of Object.entries({ "ports.ts": PORTS, ...files })) {
    writeFileSync(join(src, name), text);
    names.push(join(src, name));
  }
  const program = ts.createProgram(names, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  const roots = withPackage ? [src, join(packageRoot, "src")] : [src];
  return findPromiseHazards(program, root, roots)
    .filter((hazard) => hazard.file.startsWith("src/"))
    .map((hazard) => `${hazard.kind} ${hazard.file}:${hazard.line} ${hazard.text}`)
    .sort();
}

describe("findPromiseHazards", { timeout: FIXTURE_TIMEOUT }, () => {
  it("catches an unawaited write, through a port or a function", () => {
    expect(
      hazardsIn({
        "caller.ts": `import { appendEntry, type MeshWriter } from "./ports.js";
export function record(writer: MeshWriter): void {
  writer.write("createObligation", { title: "t" });
  appendEntry("t");
}
`,
      })
    ).toEqual(["unawaited src/caller.ts:3 writer.write", "unawaited src/caller.ts:4 appendEntry"]);
  });

  it("catches an async implementation assigned to a void-returning port, every way in", () => {
    expect(
      hazardsIn({
        "listeners.ts": `import { appendEntry, type EffectSink, type Listener, onEvent } from "./ports.js";
export class AsyncSink implements EffectSink {
  async deliver(effect: string): Promise<void> {
    await appendEntry(effect);
  }
}
export const literalSink: EffectSink = {
  async deliver(effect) {
    await appendEntry(effect);
  },
};
onEvent(async (event) => {
  await appendEntry(event);
});
const asyncListener = async (event: string) => {
  await appendEntry(event);
};
onEvent(asyncListener);
const holder = { deliver: asyncListener };
export const structuralSink: EffectSink = holder;
export const listener: Listener = asyncListener;
`,
      })
    ).toEqual([
      "async-into-void src/listeners.ts:12 function literal",
      "async-into-void src/listeners.ts:18 reference asyncListener",
      "async-into-void src/listeners.ts:2 class member .deliver",
      "async-into-void src/listeners.ts:20 property .deliver",
      "async-into-void src/listeners.ts:21 reference asyncListener",
      "async-into-void src/listeners.ts:8 object method .deliver",
    ]);
  });

  it("catches both on the writer's own ports", () => {
    const writer = JSON.stringify(join(packageRoot, "src", "db", "mesh-writer.ts"));
    expect(
      hazardsIn(
        {
          "converted.ts": `import type { DeliverEffect, MeshWriter } from ${writer};
type Ops = { create: (context: never, input: { title: string }) => { id: string } };
export function convert(writer: MeshWriter<Ops>): void {
  writer.write("create", { title: "t" });
}
export const deliver: DeliverEffect<string> = async (effect) => {
  await writer0.write("create", { title: effect });
};
declare const writer0: MeshWriter<Ops>;
`,
        },
        { withPackage: true }
      )
    ).toEqual([
      "async-into-void src/converted.ts:6 function literal",
      "unawaited src/converted.ts:4 writer.write",
    ]);
  });

  it("lets through a write that is awaited, returned, kept, chained or explicitly dropped", () => {
    expect(
      hazardsIn({
        "handled.ts": `import { appendEntry, type EffectSink, type MeshWriter, onEvent } from "./ports.js";
export async function record(writer: MeshWriter): Promise<unknown> {
  await writer.write("a", {});
  void writer.write("b", {});
  writer.write("c", {}).catch(() => undefined);
  const pending = writer.write("d", {});
  await pending;
  return writer.write("e", {});
}
export class SyncSink implements EffectSink {
  deliver(effect: string): void {
    void appendEntry(effect);
  }
}
onEvent((event) => {
  void appendEntry(event);
});
export const asyncWhereAsyncIsExpected: () => Promise<number> = async () => appendEntry("x");
[1, 2].forEach(async (n) => {
  await appendEntry(String(n));
});
`,
      })
    ).toEqual([]);
  });
});

/**
 * Hazards in this package that predate the gate, each reviewed: keyed by kind,
 * file and text, so moving one does not fail the gate and adding one does.
 */
const KNOWN_HAZARDS: readonly string[] = [
  // An async IIFE that handles its own errors.
  "unawaited src/voice/audio.ts (async () =>",
  // A void-or-promise optional hook, so not awaiting it is a choice.
  "unawaited src/remote-instances/actor-handle.ts this.opts.actorOptions?.onProviderAttempt",
  // An async close handed to a port typed as returning void.
  "async-into-void src/providers/openrouter/provider.ts property .close",
];
const known = (hazard: PromiseHazard) => {
  const key = `${hazard.kind} ${hazard.file} ${hazard.text}`;
  return KNOWN_HAZARDS.some((entry) => key === entry || key.startsWith(`${entry} `));
};

describe("this package", () => {
  it("adds no unawaited package promise and no async implementation of a void port", () => {
    const configPath = join(packageRoot, "tsconfig.json");
    const config = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configPath, ts.sys.readFile).config,
      ts.sys,
      packageRoot
    );
    const program = ts.createProgram(config.fileNames, config.options);
    const hazards = findPromiseHazards(program, packageRoot, [join(packageRoot, "src")]);
    expect(hazards.filter((hazard) => !known(hazard)).map(formatPromiseHazard)).toEqual([]);
    // Each exception still exists; drop it once its hazard is fixed.
    for (const entry of KNOWN_HAZARDS) {
      expect(
        hazards.some(
          (hazard) =>
            known(hazard) && `${hazard.kind} ${hazard.file} ${hazard.text}`.startsWith(entry)
        ),
        entry
      ).toBe(true);
    }
  }, 120_000);
});
