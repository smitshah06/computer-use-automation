import type { InterventionSummary } from "./result";

export type InterventionDisposition = InterventionSummary["disposition"];
export type InterventionType = InterventionSummary["type"];

// What the run hands to a human: enough context to decide without reading code.
export interface InterventionRequest {
  id: string;
  runId: string;
  type: InterventionType;
  capabilityId: string;
  reason: string;
  stepId?: string;
  intent?: string;
  currentUrl: string;
  screenshotPath?: string; // relative to the run's evidence dir
  requestedAt: string;
  expiresAt: string;
}

export interface InterventionResolution {
  disposition: InterventionDisposition;
  operator?: string;
  note?: string;
}

// The seam between the replay engine and the escalation subsystem. The engine
// blocks on this call while a human owns the live session; the resolution says
// how to proceed. Phase 6 implements this against the operator console.
export interface EscalationGateway {
  requestIntervention(req: InterventionRequest): Promise<InterventionResolution>;
}
