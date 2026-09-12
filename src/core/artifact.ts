import { z } from "zod";
import { ConditionSchema } from "./conditions";
import { StepTargetSchema } from "./locators";
import { ActionKindSchema, RiskSchema } from "./actions";

// ---------------------------------------------------------------------------
// The capability artifact: the typed, versioned contract a successful discovery
// run is distilled into, and the only thing the replay engine needs.
//   - contract   (capability/inputs/outputs/outcomes): what callers read
//   - mechanics  (target/steps/recoveries/successCheckpoint): what replay reads
//   - policy     (policy): what the PolicyEngine reads
// ---------------------------------------------------------------------------

export const InputParamSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "money", "date", "enum"]),
  required: z.boolean().default(true),
  pattern: z.string().optional(), // validation regex, checked before launch
  enumValues: z.array(z.string()).optional(),
  sensitive: z.boolean().default(false),
  example: z.string().optional(),
  description: z.string().optional(),
}).strict();
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "money", "date"]),
  sensitive: z.boolean().default(false),
  sourceStep: z.string(), // step id whose extract produced it
  description: z.string().optional(),
}).strict();
export type OutputParam = z.infer<typeof OutputParamSchema>;

export const WaitSchema = z.object({
  condition: ConditionSchema,
  timeoutMs: z.number().int().positive().max(120_000),
}).strict();
export type Wait = z.infer<typeof WaitSchema>;

export const StepSchema = z.object({
  id: z.string().regex(/^s\d+$/),
  intent: z.string(), // human-readable purpose, distilled from LLM reasoning
  action: ActionKindSchema,
  target: StepTargetSchema.optional(),
  url: z.string().optional(), // navigate only; may contain {{env.*}}
  value: z.string().optional(), // fill/select; literals parameterized to {{inputs.*}}/{{secrets.*}}
  key: z.string().optional(), // press
  sensitive: z.boolean().default(false),
  outputName: z.string().optional(), // extract: which output this feeds
  extractPattern: z.string().optional(), // extract: regex applied to element text (capture group 1 or whole match)
  waitBefore: WaitSchema.optional(),
  checkpoint: ConditionSchema.optional(), // per-step postcondition
  risk: RiskSchema.default("safe"),
}).strict()
  .refine((s) => s.action !== "navigate" || !!s.url, { message: "navigate steps require url" })
  .refine((s) => !["click", "fill", "select", "extract"].includes(s.action) || !!s.target, {
    message: "click/fill/select/extract steps require a target",
  })
  .refine((s) => s.action !== "fill" || s.value !== undefined, { message: "fill steps require value" });
export type Step = z.infer<typeof StepSchema>;

// Expected business outcomes are first-class declared states — a legitimate
// answer to the request, not an error (e.g. MEMBER_NOT_FOUND).
export const OutcomeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  terminal: z.literal(true),
  description: z.string(),
  detector: ConditionSchema,
}).strict();
export type Outcome = z.infer<typeof OutcomeSchema>;

export const RecoveryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dismiss"), target: StepTargetSchema }).strict(),
  z.object({ kind: z.literal("waitRetry"), backoffMs: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("runSteps"), stepIds: z.array(z.string()).min(1) }).strict(),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const RecoverySchema = z.object({
  id: z.string(),
  appliesTo: z.union([z.literal("global"), z.array(z.string()).min(1)]),
  detector: ConditionSchema,
  action: RecoveryActionSchema,
  maxAttempts: z.number().int().min(1).max(5).default(2),
}).strict();
export type Recovery = z.infer<typeof RecoverySchema>;

export const ArtifactPolicySchema = z.object({
  requiredOrigins: z.array(z.string().url()).min(1),
  allowedActionKinds: z.array(ActionKindSchema).min(1),
  riskLevel: z.enum(["readonly", "mutating"]),
  unattendedReplay: z.boolean(),
}).strict();
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

export const ProvenanceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  runId: z.string(),
  recordedAt: z.string().datetime(),
  evidenceRef: z.string().optional(),
  reviewStatus: z.enum(["draft", "approved"]),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
}).strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AppFingerprintSchema = z.object({
  titlePattern: z.string().optional(), // regex on document title at entry
  markers: z.array(z.string()).default([]), // text that must be present at entry
}).strict();

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  capability: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string(),
    description: z.string(),
  }).strict(),
  target: z.object({
    appId: z.string(),
    surface: z.enum(["web"]), // desktop/vision arrive as new drivers, same schema
    entrypoint: z.string(),
    appFingerprint: AppFingerprintSchema.default({ markers: [] }),
  }).strict(),
  inputs: z.array(InputParamSchema).default([]),
  outputs: z.array(OutputParamSchema).default([]),
  steps: z.array(StepSchema).min(1),
  outcomes: z.array(OutcomeSchema).default([]),
  recoveries: z.array(RecoverySchema).default([]),
  successCheckpoint: ConditionSchema,
  policy: ArtifactPolicySchema,
  provenance: ProvenanceSchema,
}).strict()
  .superRefine((a, ctx) => {
    const stepIds = new Set(a.steps.map((s) => s.id));
    if (stepIds.size !== a.steps.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate step ids" });
    }
    for (const o of a.outputs) {
      if (!stepIds.has(o.sourceStep)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `output ${o.name} references unknown step ${o.sourceStep}` });
      }
    }
    for (const r of a.recoveries) {
      if (r.appliesTo !== "global") {
        for (const sid of r.appliesTo) {
          if (!stepIds.has(sid)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `recovery ${r.id} references unknown step ${sid}` });
          }
        }
      }
      if (r.action.kind === "runSteps") {
        for (const sid of r.action.stepIds) {
          if (!stepIds.has(sid)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `recovery ${r.id} runSteps references unknown step ${sid}` });
          }
        }
      }
    }
    const outcomeCodes = new Set(a.outcomes.map((o) => o.code));
    if (outcomeCodes.size !== a.outcomes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate outcome codes" });
    }
  });
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export function parseArtifact(json: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(json);
}
