/** A conflicting live voice lease makes the actor's reply belong to another human. */
export class HumanVoiceAdmissionError extends Error {
  constructor() {
    super("voice session is held by a different principal");
    this.name = "HumanVoiceAdmissionError";
  }
}

/** Shared memo and typed ingress refusal, before any human chat write or wake. */
export function assertHumanVoiceAdmission(heldByOtherPrincipal: boolean): void {
  if (heldByOtherPrincipal) throw new HumanVoiceAdmissionError();
}
