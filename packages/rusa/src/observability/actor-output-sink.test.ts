import { describe, expect, it } from "vitest";
import {
  type ActorOutputChunk,
  type ActorOutputSink,
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
    const stdout: ActorOutputChunk[] = [];
    const dashboard: ActorOutputChunk[] = [];
    const { logger } = recordingLogger();

    const emit = composeActorOutputSinks(
      [
        collectingSink("service-stdout", stdout),
        collectingSink("dashboard-live-output", dashboard),
      ],
      logger
    );
    emit(chunk);
    emit({ actorId: "worker-7", text: " and again" });

    expect(stdout).toEqual([chunk, { actorId: "worker-7", text: " and again" }]);
    expect(dashboard).toEqual(stdout);
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
        collectingSink("service-stdout", survivor),
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
