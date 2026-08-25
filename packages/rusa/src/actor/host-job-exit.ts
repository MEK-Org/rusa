import type { HostJobStore } from "./host-job-store.js";
import type { MeshEventSink } from "./mesh-events.js";

export interface HandleHostJobExitOptions {
  store: HostJobStore;
  recordEvent: MeshEventSink;
  deliverWake: (actorId: string, reason: string) => boolean;
  now?: () => string;
}

export interface HostJobExitPayload {
  jobId?: string;
  unitName?: string;
  actorId: string;
  result: string;
  exitStatus: string;
}

export function handleHostJobExit(o: HandleHostJobExitOptions, payload: HostJobExitPayload): void {
  const job = payload.jobId
    ? (o.store.get(payload.jobId) ?? o.store.findByUnitName(payload.unitName ?? ""))
    : o.store.findByUnitName(payload.unitName ?? "");
  const wakeActorId = job?.actorId ?? payload.actorId;
  const resolvedJobId = job?.id ?? payload.jobId;
  const resolvedUnitName = job?.unitName ?? payload.unitName ?? resolvedJobId ?? "unknown";
  if (job)
    o.store.recordExit(
      job.id,
      (o.now ?? (() => new Date().toISOString()))(),
      payload.result,
      payload.exitStatus
    );

  o.recordEvent({
    kind: "host_job_exited",
    actorId: wakeActorId,
    detail: `${resolvedUnitName} jobId=${resolvedJobId ?? "unknown"} result=${payload.result} exitStatus=${payload.exitStatus}`,
  });
  o.deliverWake(
    wakeActorId,
    `host job ${resolvedUnitName} jobId=${resolvedJobId ?? "unknown"} exited: ${payload.result}`
  );
}
