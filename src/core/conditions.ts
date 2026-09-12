import { z } from "zod";
import { LocatorStrategySchema, type LocatorStrategy } from "./locators";

// A tiny declarative condition AST: serializable, reviewable, surface-agnostic,
// and evaluated without eval(). Used for waits, checkpoints, outcome detectors,
// recovery detectors, and app fingerprints.
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { urlMatches: string }
  | { textPresent: string }
  | { elementVisible: LocatorStrategy }
  | { elementAbsent: LocatorStrategy }
  | { valueMatches: { target: LocatorStrategy; pattern: string } };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.object({ urlMatches: z.string() }).strict(),
    z.object({ textPresent: z.string() }).strict(),
    z.object({ elementVisible: LocatorStrategySchema }).strict(),
    z.object({ elementAbsent: LocatorStrategySchema }).strict(),
    z.object({
      valueMatches: z.object({ target: LocatorStrategySchema, pattern: z.string() }).strict(),
    }).strict(),
  ])
);

export function describeCondition(c: Condition): string {
  if ("all" in c) return `all(${c.all.map(describeCondition).join(", ")})`;
  if ("any" in c) return `any(${c.any.map(describeCondition).join(", ")})`;
  if ("not" in c) return `not(${describeCondition(c.not)})`;
  if ("urlMatches" in c) return `urlMatches(${c.urlMatches})`;
  if ("textPresent" in c) return `textPresent("${c.textPresent}")`;
  if ("elementVisible" in c) return `elementVisible(...)`;
  if ("elementAbsent" in c) return `elementAbsent(...)`;
  return `valueMatches(~${c.valueMatches.pattern})`;
}
