import {
  resolveTemplate,
  resolveTemplateInRegex,
  type Condition,
  type LocatorStrategy,
  type StepTarget,
  type TemplateContext,
} from "../core";

// Artifacts store template references ({{inputs.x}}, {{secrets.x}}, {{env.x}});
// the driver only ever sees concrete strings. Materialization is the replay
// engine's job and fails closed on unresolved references.

export function materializeStrategy(s: LocatorStrategy, ctx: TemplateContext): LocatorStrategy {
  switch (s.kind) {
    case "role":
      return s.name !== undefined ? { ...s, name: resolveTemplate(s.name, ctx) } : s;
    case "bbox":
      return s;
    default:
      return { ...s, value: resolveTemplate(s.value, ctx) };
  }
}

export function materializeTarget(t: StepTarget, ctx: TemplateContext): StepTarget {
  return { ...t, strategies: t.strategies.map((s) => materializeStrategy(s, ctx)) };
}

export function materializeCondition(c: Condition, ctx: TemplateContext): Condition {
  if ("all" in c) return { all: c.all.map((x) => materializeCondition(x, ctx)) };
  if ("any" in c) return { any: c.any.map((x) => materializeCondition(x, ctx)) };
  if ("not" in c) return { not: materializeCondition(c.not, ctx) };
  // urlMatches / valueMatches patterns are compiled as regexes: substituted
  // runtime values are regex-escaped so data can't alter pattern semantics.
  if ("urlMatches" in c) return { urlMatches: resolveTemplateInRegex(c.urlMatches, ctx) };
  if ("textPresent" in c) return { textPresent: resolveTemplate(c.textPresent, ctx) };
  if ("elementVisible" in c) return { elementVisible: materializeStrategy(c.elementVisible, ctx) };
  if ("elementAbsent" in c) return { elementAbsent: materializeStrategy(c.elementAbsent, ctx) };
  return {
    valueMatches: {
      target: materializeStrategy(c.valueMatches.target, ctx),
      pattern: resolveTemplateInRegex(c.valueMatches.pattern, ctx),
    },
  };
}
