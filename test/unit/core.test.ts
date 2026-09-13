import { describe, it, expect } from "vitest";
import {
  CapabilityArtifactSchema,
  ConditionSchema,
  RunOutcomeSchema,
  parameterizeValue,
  resolveTemplate,
  resolveTemplateInRegex,
  loadSecretsFromEnv,
  findUnresolved,
} from "../../src/core";
import { makeFixtureArtifact } from "../fixtures/artifact-fixture";

describe("capability artifact schema", () => {
  it("round-trips a valid artifact", () => {
    const artifact = makeFixtureArtifact();
    const parsed = CapabilityArtifactSchema.parse(artifact);
    expect(parsed.capability.id).toBe("member-savings-lookup");
    const again = CapabilityArtifactSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  it("rejects unknown keys (strict schemas)", () => {
    const bad: any = makeFixtureArtifact();
    bad.surprise = true;
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow();
  });

  it("rejects outputs referencing unknown steps", () => {
    const bad: any = makeFixtureArtifact();
    bad.outputs[0].sourceStep = "s999";
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/unknown step/);
  });

  it("rejects navigate steps without url and fill steps without value", () => {
    const bad: any = makeFixtureArtifact();
    delete bad.steps[0].url; // s1 is navigate
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow();
  });

  it("rejects recoveries pointing at unknown steps", () => {
    const bad: any = makeFixtureArtifact();
    bad.recoveries.push({
      id: "broken",
      appliesTo: ["s404"],
      detector: { textPresent: "x" },
      action: { kind: "waitRetry", backoffMs: 100 },
      maxAttempts: 1,
    });
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/unknown step/);
  });
});

describe("condition AST", () => {
  it("parses nested all/any/not trees", () => {
    const c = ConditionSchema.parse({
      all: [
        { urlMatches: "/members/\\d+" },
        { any: [{ textPresent: "Accounts" }, { not: { textPresent: "Error" } }] },
        { elementVisible: { kind: "role", role: "heading", name: "Member" } },
      ],
    });
    expect("all" in c).toBe(true);
  });

  it("rejects unknown condition shapes", () => {
    expect(() => ConditionSchema.parse({ javascript: "evil()" })).toThrow();
  });
});

describe("result contract", () => {
  it("accepts each member of the union", () => {
    expect(RunOutcomeSchema.parse({ status: "success", outputs: { savingsBalance: "$1,204.55" } }).status).toBe("success");
    expect(
      RunOutcomeSchema.parse({
        status: "business_outcome",
        code: "MEMBER_NOT_FOUND",
        description: "No member exists with the supplied member number.",
        extracted: {},
      }).status,
    ).toBe("business_outcome");
    expect(
      RunOutcomeSchema.parse({
        status: "hard_failure",
        error: { expected: "checkpoint", observed: "timeout", evidence: [] },
      }).status,
    ).toBe("hard_failure");
    expect(
      RunOutcomeSchema.parse({
        status: "escalated",
        interventions: [{ id: "int_1", reason: "session expired", type: "assist", disposition: "fixed_environment" }],
        finalStatus: "success",
        outputs: { savingsBalance: "$1.00" },
      }).status,
    ).toBe("escalated");
  });

  it("rejects a business outcome disguised as success", () => {
    expect(() => RunOutcomeSchema.parse({ status: "business_outcome" })).toThrow();
  });
});

describe("templating and parameterization", () => {
  const ctx = {
    inputs: { memberId: "12345" },
    secrets: { tellerUsername: "teller1", tellerPassword: "Demo!Pass1" },
    env: { APP_BASE_URL: "http://localhost:4600" },
  };

  it("resolves refs and fails closed on unknown ones", () => {
    expect(resolveTemplate("{{env.APP_BASE_URL}}/login", ctx)).toBe("http://localhost:4600/login");
    expect(resolveTemplate("{{inputs.memberId}}", ctx)).toBe("12345");
    expect(() => resolveTemplate("{{inputs.nope}}", ctx)).toThrow(/unresolved/);
  });

  it("fails closed on prototype-chain refs — only own string properties resolve", () => {
    expect(() => resolveTemplate("{{inputs.constructor}}", ctx)).toThrow(/unresolved/);
    expect(() => resolveTemplate("{{inputs.__proto__}}", ctx)).toThrow(/unresolved/);
    expect(() => resolveTemplateInRegex("{{env.toString}}", ctx)).toThrow(/unresolved/);
  });

  it("parameterizes recorded literals (exact and embedded)", () => {
    expect(parameterizeValue("12345", ctx.inputs)).toBe("{{inputs.memberId}}");
    expect(parameterizeValue("member 12345 lookup", ctx.inputs)).toBe("member {{inputs.memberId}} lookup");
    expect(parameterizeValue("999", ctx.inputs)).toBe("999");
  });

  it("maps prefixed env vars to camelCase secret names", () => {
    const secrets = loadSecretsFromEnv(
      { SCRIBE_SECRET_TELLER_USERNAME: "teller1", OTHER: "x" },
      ["SCRIBE_SECRET_"],
    );
    expect(secrets).toEqual({ tellerUsername: "teller1" });
  });

  it("flags malformed template refs", () => {
    expect(findUnresolved("{{inputs.ok}} and {{bogus ref}}", )).toEqual(["{{bogus ref}}"]);
  });

  it("regex-escapes substituted values in regex contexts", () => {
    const rctx = { inputs: { q: "a.b(c)" }, secrets: {}, env: {} };
    // author-written regex around the ref stays live; the data is neutralized
    expect(resolveTemplateInRegex("^/find/{{inputs.q}}$", rctx)).toBe("^/find/a\\.b\\(c\\)$");
    expect(new RegExp(resolveTemplateInRegex("/m/{{inputs.q}}", rctx)).test("/m/a.b(c)")).toBe(true);
    expect(new RegExp(resolveTemplateInRegex("/m/{{inputs.q}}", rctx)).test("/m/aXb(c)")).toBe(false);
  });
});
