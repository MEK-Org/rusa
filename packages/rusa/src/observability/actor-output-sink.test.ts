import { describe, expect, it } from "vitest";
import {
  type ActorOutputChunk,
  type ActorOutputSink,
  actorOutputSinks,
  composeActorOutputSinks,
} from "./actor-output-sink.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * The two properties that matter here are opposites: actor prose must keep
 * reaching every destination it reached before, and the failure of one
 * destination must become a record instead of a silence.
 */

function recordingLogger(): { logger: Logger; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const logger = createLogger({
    format: "json",
    level: "debug",
    destination: {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  });
  const records = () =>
    lines
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records };
}

function collectingSink(name: string, into: ActorOutputChunk[]): ActorOutputSink {
  return { name, deliver: (chunk) => into.push(chunk) };
}

const chunk: ActorOutputChunk = { actorId: "worker-7", text: "thinking out loud" };

describe("composeActorOutputSinks", () => {
  it("delivers each chunk to every sink, so dashboard streaming survives the refactor", () => {
    const second: ActorOutputChunk[] = [];
    const dashboard: ActorOutputChunk[] = [];
    const { logger } = recordingLogger();

    const emit = composeActorOutputSinks(
      [
        collectingSink("dashboard-live-output", dashboard),
        collectingSink("second-destination", second),
      ],
      logger
    );
    emit(chunk);
    emit({ actorId: "worker-7", text: " and again" });

    expect(second).toEqual([chunk, { actorId: "worker-7", text: " and again" }]);
    expect(dashboard).toEqual(second);
  });

  it("passes actor output through untouched — it is prose, not a structured record", () => {
    const seen: ActorOutputChunk[] = [];
    const { logger, records } = recordingLogger();

    composeActorOutputSinks([collectingSink("dashboard-live-output", seen)], logger)(chunk);

    expect(seen[0].text).toBe("thinking out loud");
    expect(records()).toEqual([]);
  });

  it("keeps delivering to the remaining sinks when one throws", () => {
    const survivor: ActorOutputChunk[] = [];
    const { logger } = recordingLogger();

    const emit = composeActorOutputSinks(
      [
        {
          name: "dashboard-live-output",
          deliver: () => {
            throw new Error("write after end");
          },
        },
        collectingSink("second-destination", survivor),
      ],
      logger
    );

    expect(() => emit(chunk)).not.toThrow();
    expect(survivor).toEqual([chunk]);
  });

  it("records the dropped delivery that used to be an empty catch", () => {
    const { logger, records } = recordingLogger();

    composeActorOutputSinks(
      [
        {
          name: "dashboard-live-output",
          deliver: () => {
            throw new Error("write after end");
          },
        },
      ],
      logger
    )(chunk);

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: "debug",
      msg: "actor_output_sink_failed",
      sink: "dashboard-live-output",
      actorId: "worker-7",
      bytes: chunk.text.length,
      err: { message: "write after end" },
    });
  });

  it("does not carry the actor's words into the diagnostic, only their size", () => {
    const { logger, records } = recordingLogger();

    composeActorOutputSinks(
      [
        {
          name: "dashboard-live-output",
          deliver: () => {
            throw new Error("write after end");
          },
        },
      ],
      logger
    )({ actorId: "worker-7", text: "a private deliberation" });

    expect(JSON.stringify(records()[0])).not.toContain("private deliberation");
  });
});

/**
 * The point of the sink list is which destinations are on it. An actor's words
 * reaching the service's own stdout is what made `journalctl -u rusa`
 * unreadable as a record of the mesh — a run that prints a log line, or echoes
 * the journal back, forges service records — so "nothing writes to fd 1" is the
 * property under test, not an implementation detail.
 */
describe("actorOutputSinks", () => {
  it("does not carry actor prose to the service's own output", () => {
    const { logger } = recordingLogger();
    const dashboard: ActorOutputChunk[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const realStdout = process.stdout.write.bind(process.stdout);
    const realStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((text: string) => {
      stdout.push(String(text));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((text: string) => {
      stderr.push(String(text));
      return true;
    }) as typeof process.stderr.write;

    try {
      composeActorOutputSinks(
        actorOutputSinks({ emitLiveOutput: (c) => dashboard.push(c) }),
        logger
      )({ actorId: "worker-7", text: "[mesh] forged line from an actor\n" });
    } finally {
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
    }

    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(dashboard).toEqual([
      { actorId: "worker-7", text: "[mesh] forged line from an actor\n" },
    ]);
  });

  it("keeps the dashboard live-output destination", () => {
    expect(actorOutputSinks({ emitLiveOutput: () => {} }).map((sink) => sink.name)).toEqual([
      "dashboard-live-output",
    ]);
  });
});
