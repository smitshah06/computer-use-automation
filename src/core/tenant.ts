import { z } from "zod";
import {
  AppFingerprintSchema,
  CapabilityArtifactSchema,
  type CapabilityArtifact,
} from "./artifact";
import { LocatorStrategySchema, type LocatorStrategy, type StepTarget } from "./locators";
import type { Condition } from "./conditions";

// ---------------------------------------------------------------------------
// TenantBinding: a thin, reviewable overlay that adapts ONE recorded capability
// artifact to another deployment of the SAME vendor product (different branding,
// labels, hostname) without re-recording. The base artifact stays the source of
// truth for mechanics; the binding only remaps surface vocabulary, entrypoint,
// fingerprint, origins, and — as a last resort — per-step locator strategies.
//
// Deliberate non-goals, enforced by construction:
//   - vocabulary is EXACT-match on whole strings (no substring cascades:
//     "Member Search" -> "Customer Search" must not also mangle "Member Number")
//   - css/bbox strategies, urlMatches patterns, step values/urls, and extract
//     patterns are never vocabulary-mapped — labels differ per tenant, plumbing
//     does not; per-tenant css differences go through stepOverrides instead
//   - the merged result is re-validated through the same strict artifact schema
//     every recorded artifact passes, so an overlay cannot smuggle in an
//     artifact shape the replay engine has never seen.
// ---------------------------------------------------------------------------

export const TenantBindingSchema = z.object({
  schemaVersion: z.literal("1.0"),
  tenantId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  appId: z.string(), // must equal artifact.target.appId — bindings are per-product
  description: z.string().optional(),
  entrypoint: z.string().optional(), // may contain {{env.*}}, like the artifact's
  requiredOrigins: z.array(z.string().url()).min(1).optional(),
  appFingerprint: AppFingerprintSchema.optional(), // replaces wholesale when present
  vocabulary: z.record(z.string(), z.string()).optional(), // exact-match label map
  stepOverrides: z
    .record(
      z.string(),
      z.object({ strategies: z.array(LocatorStrategySchema).min(1) }).strict(),
    )
    .optional(), // full strategy-list replacement for steps that need it
}).strict();
export type TenantBinding = z.infer<typeof TenantBindingSchema>;

export function parseTenantBinding(json: unknown): TenantBinding {
  return TenantBindingSchema.parse(json);
}

/**
 * Merge a tenant binding over a capability artifact and return a NEW artifact,
 * re-validated through the strict schema. Fails closed on an appId mismatch or
 * an override for a step id the artifact does not have.
 */
export function applyTenantBinding(
  artifact: CapabilityArtifact,
  binding: TenantBinding,
): CapabilityArtifact {
  if (binding.appId !== artifact.target.appId) {
    throw new Error(
      `tenant binding "${binding.tenantId}" targets app "${binding.appId}" but the artifact ` +
        `records "${artifact.target.appId}" — refusing to merge across products`,
    );
  }
  const stepIds = new Set(artifact.steps.map((s) => s.id));
  for (const sid of Object.keys(binding.stepOverrides ?? {})) {
    if (!stepIds.has(sid)) {
      throw new Error(`tenant binding "${binding.tenantId}" overrides unknown step "${sid}"`);
    }
  }

  const vocab = binding.vocabulary ?? {};
  const tr = (s: string): string => vocab[s] ?? s; // exact-match only, by design

  const mapStrategy = (s: LocatorStrategy): LocatorStrategy => {
    if (s.kind === "role") return s.name === undefined ? s : { ...s, name: tr(s.name) };
    if (s.kind === "labelText" || s.kind === "nearText") return { ...s, value: tr(s.value) };
    return s; // css and bbox carry no human vocabulary
  };

  const mapTarget = (t: StepTarget, override?: LocatorStrategy[]): StepTarget => ({
    ...t,
    // An override replaces the ranked list wholesale — its strategies are
    // already tenant-specific, so the vocabulary map does not touch them.
    strategies: override ?? t.strategies.map(mapStrategy),
    elementDescription: tr(t.elementDescription),
  });

  const mapCondition = (c: Condition): Condition => {
    if ("all" in c) return { all: c.all.map(mapCondition) };
    if ("any" in c) return { any: c.any.map(mapCondition) };
    if ("not" in c) return { not: mapCondition(c.not) };
    if ("textPresent" in c) return { textPresent: tr(c.textPresent) };
    if ("elementVisible" in c) return { elementVisible: mapStrategy(c.elementVisible) };
    if ("elementAbsent" in c) return { elementAbsent: mapStrategy(c.elementAbsent) };
    if ("valueMatches" in c) {
      return { valueMatches: { ...c.valueMatches, target: mapStrategy(c.valueMatches.target) } };
    }
    return c; // urlMatches: routes are plumbing, never vocabulary
  };

  const merged = structuredClone(artifact);
  merged.steps = merged.steps.map((step) => ({
    ...step,
    target: step.target
      ? mapTarget(step.target, binding.stepOverrides?.[step.id]?.strategies)
      : step.target,
    waitBefore: step.waitBefore
      ? { ...step.waitBefore, condition: mapCondition(step.waitBefore.condition) }
      : step.waitBefore,
    checkpoint: step.checkpoint ? mapCondition(step.checkpoint) : step.checkpoint,
  }));
  merged.outcomes = merged.outcomes.map((o) => ({ ...o, detector: mapCondition(o.detector) }));
  merged.recoveries = merged.recoveries.map((r) => ({
    ...r,
    detector: mapCondition(r.detector),
    action: r.action.kind === "dismiss" ? { ...r.action, target: mapTarget(r.action.target) } : r.action,
  }));
  merged.successCheckpoint = mapCondition(merged.successCheckpoint);
  if (binding.entrypoint !== undefined) merged.target.entrypoint = binding.entrypoint;
  if (binding.appFingerprint !== undefined) merged.target.appFingerprint = binding.appFingerprint;
  if (binding.requiredOrigins !== undefined) merged.policy.requiredOrigins = [...binding.requiredOrigins];

  return CapabilityArtifactSchema.parse(merged);
}
