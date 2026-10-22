import type { BoundRunContextReader } from "./run-context.js";

/** Immutable creation-time delivery priority, persisted with a message. */
export interface MessageStamp {
  readonly responsive: boolean;
  readonly responsiveReason?: "human message" | "responsive obligation";
}

/** Shared trusted policy for human and actor message creation. */
export class MessageStampService {
  stampHuman(): MessageStamp {
    return { responsive: true, responsiveReason: "human message" };
  }

  stampActor(reader: BoundRunContextReader): MessageStamp {
    const context = reader.current();
    if (!context) throw new Error("actor run context has ended");
    return context.effectiveResponsive
      ? { responsive: true, responsiveReason: "responsive obligation" }
      : { responsive: false };
  }
}
