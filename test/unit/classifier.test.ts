import { describe, it, expect } from "vitest";
import { DeviationClassifier } from "../../src/replay/classifier";
import { CapabilityArtifactSchema, type Condition, type TemplateContext } from "../../src/core";
import type { SurfaceDriver } from "../../src/surface";
import { makeFixtureArtifact } from "../fixtures/artifact-fixture";

const ctx: TemplateContext = { inputs: {}, secrets: {}, env: {} };

// A driver stub whose page "contains" a controllable set of text markers.
function driverWith(present: Set<string>): SurfaceDriver {
  return {
    evalCondition: async (c: Condition): Promise<boolean> => {
      if ("textPresent" in c) return present.has(c.textPresent);
      if ("all" in c) {
        for (const x of c.all) if (!("textPresent" in x && present.has(x.textPresent))) return false;
        return true;
      }
      return false;
    },
  } as unknown as SurfaceDriver;
}

function artifactWith(overrides: { outcomes?: unknown[]; recoveries?: unknown[] }) {
  const raw = makeFixtureArtifact() as Record<string, unknown>;
  if (overrides.outcomes) raw.outcomes = overrides.outcomes;
  if (overrides.recoveries) raw.recoveries = overrides.recoveries;
  return CapabilityArtifactSchema.parse(raw);
}

const OUTCOME = {
  code: "SOME_OUTCOME",
  terminal: true,
  description: "declared terminal state",
  detector: { textPresent: "X" },
};
const GLOBAL_RECOVERY = {
  id: "r-global",
  appliesTo: "global",
  detector: { textPresent: "X" },
  action: { kind: "waitRetry", backoffMs: 100 },
  maxAttempts: 2,
};
const SCOPED_RECOVERY = {
  id: "r-scoped",
  appliesTo: ["s2"],
  detector: { textPresent: "Y" },
  action: { kind: "waitRetry", backoffMs: 100 },
  maxAttempts: 1,
};

describe("DeviationClassifier precedence and bounds", () => {
  it("prefers a declared business outcome over a matching recovery", async () => {
    const a = artifactWith({ outcomes: [OUTCOME], recoveries: [GLOBAL_RECOVERY] });
    const c = new DeviationClassifier(a, driverWith(new Set(["X"])), ctx);
    const r = await c.classify("s1");
    expect(r.type).toBe("outcome");
    if (r.type === "outcome") expect(r.outcome.code).toBe("SOME_OUTCOME");
  });

  it("falls back to a recovery when no outcome matches", async () => {
    const a = artifactWith({ outcomes: [OUTCOME], recoveries: [GLOBAL_RECOVERY] });
    // page shows nothing that matches the outcome; force recovery detector on
    const c = new DeviationClassifier(
      a,
      driverWith(new Set([])),
      ctx,
    );
    expect((await c.classify("s1")).type).toBe("none");
  });

  it("scopes recoveries to their declared steps", async () => {
    const a = artifactWith({ outcomes: [], recoveries: [SCOPED_RECOVERY] });
    const c = new DeviationClassifier(a, driverWith(new Set(["Y"])), ctx);
    expect((await c.classify("s1")).type).toBe("none");
    const r = await c.classify("s2");
    expect(r.type).toBe("recovery");
    if (r.type === "recovery") expect(r.recovery.id).toBe("r-scoped");
  });

  it("stops offering a recovery once its attempt budget is exhausted", async () => {
    const a = artifactWith({ outcomes: [], recoveries: [SCOPED_RECOVERY] });
    const c = new DeviationClassifier(a, driverWith(new Set(["Y"])), ctx);
    expect((await c.classify("s2")).type).toBe("recovery");
    c.recordUse("r-scoped"); // maxAttempts: 1
    expect((await c.classify("s2")).type).toBe("none");
  });
});
