import type { BoundRunContextReader } from "./run-context.js";

/** Immutable creation-time delivery priority, persisted with a message. */
export interface MessageStamp {
  readonly responsive: boolean;
  readonly responsiveReason?: "human message" | "responsive obligation";
}

/** Shared trusted policy for human message creation. */
export function stampHuman(): MessageStamp {
  return { responsive: true, responsiveReason: "human message" };
}

/** Shared trusted policy for exact-run actor message creation. */
export function stampActor(reader: BoundRunContextReader): MessageStamp {
  const context = reader.current();
  if (!context) throw new Error("actor run context has ended");
  return context.effectiveResponsive
    ? { responsive: true, responsiveReason: "responsive obligation" }
    : { responsive: false };
}
