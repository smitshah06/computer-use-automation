import { z } from "zod";

// Ranked, surface-agnostic ways to find one element. Semantic strategies
// (role/label/text) come first; css is a per-tenant patchable last resort;
// bbox is the universal fallback for vision/desktop drivers.
export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string(),
    name: z.string().optional(),
    exact: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal("labelText"), value: z.string() }).strict(),
  z.object({ kind: z.literal("nearText"), value: z.string() }).strict(),
  z.object({ kind: z.literal("css"), value: z.string() }).strict(),
  z.object({
    kind: z.literal("bbox"),
    value: z.tuple([z.number(), z.number(), z.number(), z.number()]), // x, y, w, h
  }).strict(),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const StepTargetSchema = z.object({
  strategies: z.array(LocatorStrategySchema).min(1),
  elementDescription: z.string(),
  framePath: z.array(z.string()).default([]),
}).strict();
export type StepTarget = z.infer<typeof StepTargetSchema>;

export function describeStrategy(s: LocatorStrategy): string {
  switch (s.kind) {
    case "role": return `role=${s.role}${s.name ? ` name="${s.name}"` : ""}`;
    case "labelText": return `label="${s.value}"`;
    case "nearText": return `near-text="${s.value}"`;
    case "css": return `css=${s.value}`;
    case "bbox": return `bbox=[${s.value.join(",")}]`;
  }
}
