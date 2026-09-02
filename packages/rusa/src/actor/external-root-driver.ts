import { randomUUID } from "node:crypto";
import type { MeshActor } from "./actor-mesh.js";
import type { RunNudge } from "./trigger-runner.js";

export interface ExternalRootWake {
  id: string;
  receivedAt: string;
  responsive: boolean;
}

/**
 * A content-free, coalescing root endpoint for trusted external runners.
 * Durable work remains in the inbox; this queue is only a dirty nudge.
 */
export class ExternalRootDriver implements MeshActor {
  readonly id: string;
  private wake: ExternalRootWake | null = null;
  private closed = false;

  constructor(
    id: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onRuntimeStateChanged?: (state: "queued" | "idle") => void
  ) {
    this.id = id;
  }

  requestRun(nudge: RunNudge = {}): void {
    if (this.closed) return;
    if (this.wake) {
      if (nudge.priority === "responsive") this.wake.responsive = true;
      return;
    }
    this.wake = {
      id: randomUUID(),
      receivedAt: this.now(),
      responsive: nudge.priority === "responsive",
    };
    this.onRuntimeStateChanged?.("queued");
  }

  listWakes(): ExternalRootWake[] {
    return this.wake ? [structuredClone(this.wake)] : [];
  }

  acknowledge(wakeIds: string[]): ExternalRootWake[] {
    if (!this.wake || !new Set(wakeIds).has(this.wake.id)) return [];
    const acknowledged = structuredClone(this.wake);
    this.wake = null;
    this.onRuntimeStateChanged?.("idle");
    return [acknowledged];
  }

  get isRunning(): boolean {
    return false;
  }

  get isQueued(): boolean {
    return this.wake !== null;
  }

  declareYield(): void {}

  markUnkillable(): void {}

  close(): void {
    this.closed = true;
  }

  preemptForResponsive():
    | { preempted: false }
    | { preempted: true; phase: "running" | "winding_down" | "queued" } {
    return { preempted: false };
  }
}
