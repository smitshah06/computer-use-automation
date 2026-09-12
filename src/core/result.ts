import { z } from "zod";

// ---------------------------------------------------------------------------
// The result contract: a discriminated union, so the taxonomy is structural.
// A declared business outcome (e.g. MEMBER_NOT_FOUND) is a legitimate answer,
// not an error — conflating the two is the classic design mistake.
// ---------------------------------------------------------------------------

export const StructuredErrorSchema = z.object({
  stepId: z.string().optional(),
  intent: z.string().optional(),
  expected: z.string(),
  observed: z.string(),
  evidence: z.array(z.string()).default([]), // paths inside the run's evidence dir
}).strict();
export type StructuredError = z.infer<typeof StructuredErrorSchema>;

export const InterventionSummarySchema = z.object({
  id: z.string(),
  reason: z.string(),
  type: z.enum(["assist", "approval"]),
  disposition: z.enum(["fixed_environment", "completed_step", "approve_once", "deny", "abort", "expired"]),
  operator: z.string().optional(),
}).strict();
export type InterventionSummary = z.infer<typeof InterventionSummarySchema>;

export const RunOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    outputs: z.record(z.string()),
  }).strict(),
  z.object({
    status: z.literal("business_outcome"),
    code: z.string(),
    description: z.string(),
    extracted: z.record(z.string()).default({}),
  }).strict(),
  z.object({
    status: z.literal("hard_failure"),
    error: StructuredErrorSchema,
  }).strict(),
  z.object({
    status: z.literal("escalated"),
    interventions: z.array(InterventionSummarySchema).min(1),
    finalStatus: z.enum(["success", "business_outcome", "hard_failure", "aborted"]),
    outputs: z.record(z.string()).optional(),
    code: z.string().optional(),
    error: StructuredErrorSchema.optional(),
  }).strict(),
]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const StepTelemetrySchema = z.object({
  stepId: z.string(),
  strategyRank: z.number().int().nullable(), // 0 = primary strategy matched; rising ranks = locator drift
  strategyKind: z.string().optional(),
  attempts: z.number().int().min(1),
  recoveriesApplied: z.array(z.string()).default([]),
  durationMs: z.number().int().min(0),
}).strict();
export type StepTelemetry = z.infer<typeof StepTelemetrySchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  mode: z.enum(["discovery", "replay"]),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  params: z.record(z.string()), // sensitive values arrive pre-masked
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  result: RunOutcomeSchema,
  telemetry: z.array(StepTelemetrySchema).default([]),
  evidenceDir: z.string(),
}).strict();
export type RunResult = z.infer<typeof RunResultSchema>;
