import { z } from "zod";
import { ActionKindSchema } from "./actions";

// Global policy config (policy.yaml). Deny-by-default: anything not allowlisted
// here is refused at the SurfaceDriver chokepoint regardless of what the model
// or an artifact asks for.
export const PolicyConfigSchema = z.object({
  allowlist: z.object({
    origins: z.array(z.string().url()).min(1),
  }).strict(),
  actionKinds: z.array(ActionKindSchema).min(1),
  risky: z.object({
    discoveryRequiresConfirmation: z.boolean().default(true),
    unattendedRequiresApprovedArtifact: z.boolean().default(true),
  }).strict(),
  budgets: z.object({
    discoveryMaxTurns: z.number().int().positive().default(40),
    stepTimeoutMs: z.number().int().positive().default(15_000),
    runTimeoutMs: z.number().int().positive().default(300_000),
    maxStepAttempts: z.number().int().positive().default(3),
  }).strict(),
  escalation: z.object({
    operatorPort: z.number().int().default(4700),
    interventionTtlMinutes: z.number().int().positive().default(30),
  }).strict(),
  redaction: z.object({
    maskReplacement: z.string().default("***"),
    extraSecretEnvPrefixes: z.array(z.string()).default(["SCRIBE_SECRET_"]),
  }).strict(),
}).strict();
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
