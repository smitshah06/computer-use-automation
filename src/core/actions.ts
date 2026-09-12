import { z } from "zod";
import { StepTargetSchema, type StepTarget } from "./locators";

export const ActionKindSchema = z.enum(["navigate", "click", "fill", "select", "press", "extract"]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const RiskSchema = z.enum(["safe", "risky"]);
export type Risk = z.infer<typeof RiskSchema>;

export type Phase = "discovery" | "replay" | "recovery" | "human";

// What a SurfaceDriver is asked to execute. Every act() call carries enough
// context for the PolicyEngine chokepoint to decide allow/deny/approval.
export interface ActionRequest {
  kind: ActionKind;
  target?: StepTarget;
  url?: string; // navigate
  value?: string; // fill / select
  key?: string; // press
  sensitive?: boolean; // mask value in logs and screenshots
  extractPattern?: string; // extract: regex post-processing
  risk: Risk;
  phase: Phase;
  approved?: boolean; // set by the caller after an approval intervention granted this action
  stepId?: string;
  intent?: string;
}

export interface ActResult {
  ok: boolean;
  extracted?: string; // for extract actions
  strategyRank?: number; // which ranked strategy resolved (0 = best) — drift telemetry
  strategyKind?: string;
  denied?: string; // policy hard-deny reason
  needsApproval?: string; // policy requires an approval intervention first
  ambiguous?: boolean; // resolution matched more than one element (fail closed)
  notFound?: boolean;
  error?: string;
}

export { StepTargetSchema };
export type { StepTarget };
