import { describe, it, expect } from "vitest";
import { Recorder, type RecordedAct } from "../../src/agent/recorder";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../../src/core";
import type { TargetSynthesis } from "../../src/surface";
import type { LocatorStrategy } from "../../src/core";

const BASE = "http://localhost:4600";

function synth(strategies: LocatorStrategy[], desc: string, role = "textbox", name = ""): TargetSynthesis {
  return { target: { strategies, elementDescription: desc, framePath: [] }, role, name };
}

function makeRecorder(overrides: Partial<ConstructorParameters<typeof Recorder>[0]> = {}) {
  return new Recorder({
    capabilityId: "member-savings-lookup",
    name: "Member savings lookup",
    description: "Look up a member and read the savings balance",
    appId: "cu-backoffice",
    goal: "Look up member 12345 and read their savings balance",
    entryUrl: `${BASE}/login`,
    inputs: { memberId: "12345" },
    env: { APP_BASE_URL: BASE },
    provider: "scripted",
    model: "test-script",
    runId: "disc_unit_1",
    ...overrides,
  });
}

const walk: RecordedAct[] = [
  {
    kind: "navigate",
    intent: "Open the application entrypoint",
    risk: "safe",
    url: `${BASE}/login`,
    urlBefore: "about:blank",
    urlAfter: `${BASE}/login`,
    titleAfter: "CU BackOffice - Teller Sign-In",
  },
  {
    kind: "fill",
    intent: "Enter the teller username",
    risk: "safe",
    value: "{{secrets.tellerUsername}}",
    sensitive: true,
    synthesis: synth(
      [
        { kind: "role", role: "textbox", name: "Teller ID" },
        { kind: "labelText", value: "Teller ID" },
        { kind: "css", value: "#ctl00_LoginCtl_txtUser" },
      ],
      "Teller ID input",
    ),
    urlBefore: `${BASE}/login`,
    urlAfter: `${BASE}/login`,
    titleAfter: "CU BackOffice - Teller Sign-In",
  },
  {
    kind: "click",
    intent: "Submit the sign-in form",
    risk: "safe",
    synthesis: synth([{ kind: "role", role: "button", name: "Sign In" }], "Sign In button", "button", "Sign In"),
    urlBefore: `${BASE}/login`,
    urlAfter: `${BASE}/desk`,
    titleAfter: "CU BackOffice - Teller Desk",
  },
  {
    kind: "fill",
    intent: "Enter the member number",
    risk: "safe",
    value: "12345",
    synthesis: synth(
      [
        { kind: "nearText", value: "Member Number" },
        { kind: "css", value: "#ctl00_MbrSrch_txtNum" },
      ],
      "Member number input",
    ),
    urlBefore: `${BASE}/members`,
    urlAfter: `${BASE}/members`,
    titleAfter: "CU BackOffice - Member Search",
  },
  {
    kind: "click",
    intent: "Open the matching member profile",
    risk: "safe",
    synthesis: synth(
      [
        { kind: "role", role: "link", name: "Alvarez, Maria" },
        { kind: "nearText", value: "12345" },
        { kind: "css", value: "#ctl00_MbrGrd_r0_c1 a" },
      ],
      "Member name link in the results row",
      "link",
      "Alvarez, Maria",
    ),
    urlBefore: `${BASE}/members?q=12345`,
    urlAfter: `${BASE}/members/12345`,
    titleAfter: "CU BackOffice - Member Profile",
  },
  {
    kind: "extract",
    intent: "Read the savings balance",
    risk: "safe",
    sensitive: true,
    synthesis: synth(
      [
        { kind: "nearText", value: "Savings" },
        { kind: "css", value: "#ctl00_AcctGrd_r0_c2 > font" },
      ],
      "Savings balance cell",
      "text",
      "",
    ),
    outputName: "savingsBalance",
    outputType: "money",
    extractPattern: "\\$[\\d,]+\\.\\d{2}",
    urlBefore: `${BASE}/members/12345`,
    urlAfter: `${BASE}/members/12345`,
    titleAfter: "CU BackOffice - Member Profile",
  },
];

describe("Recorder distillation", () => {
  it("parameterizes inputs/env, preserves secret templates, and derives checkpoints + contract + policy", () => {
    const r = makeRecorder();
    for (const a of walk) r.record(a);
    expect(r.count).toBe(6);

    const artifact: CapabilityArtifact = CapabilityArtifactSchema.parse(r.distill());

    // contract: entrypoint and step URLs are env-parameterized
    expect(artifact.target.entrypoint).toBe("{{env.APP_BASE_URL}}/login");
    expect(artifact.steps[0]).toMatchObject({
      id: "s1",
      action: "navigate",
      url: "{{env.APP_BASE_URL}}/login",
      checkpoint: { urlMatches: "/login" },
    });

    // secrets stay as template refs (never resolved into the artifact)
    expect(artifact.steps[1]).toMatchObject({ value: "{{secrets.tellerUsername}}", sensitive: true });
    expect(artifact.steps[1]!.checkpoint).toBeUndefined(); // no navigation → no checkpoint

    // navigation-observing steps get URL checkpoints
    expect(artifact.steps[2]!.checkpoint).toEqual({ urlMatches: "/desk" });

    // input literals are canonicalized back to {{inputs.*}} — in values,
    // in locator strategies, and inside checkpoint regexes
    expect(artifact.steps[3]!.value).toBe("{{inputs.memberId}}");
    const s5 = artifact.steps[4]!;
    expect(s5.target!.strategies).toContainEqual({ kind: "nearText", value: "{{inputs.memberId}}" });
    expect(s5.target!.strategies[0]).toEqual({ kind: "role", role: "link", name: "Alvarez, Maria" });
    expect(s5.checkpoint).toEqual({ urlMatches: "/members/{{inputs.memberId}}" });
    expect(artifact.successCheckpoint).toEqual({ urlMatches: "/members/{{inputs.memberId}}" });

    // outputs come from extract steps
    expect(artifact.outputs).toEqual([
      { name: "savingsBalance", type: "money", sensitive: true, sourceStep: "s6" },
    ]);
    expect(artifact.steps[5]).toMatchObject({
      action: "extract",
      outputName: "savingsBalance",
      extractPattern: "\\$[\\d,]+\\.\\d{2}",
    });

    // inputs contract: example kept for non-sensitive, digit pattern inferred
    expect(artifact.inputs).toEqual([
      { name: "memberId", type: "string", required: true, sensitive: false, example: "12345", pattern: "^\\d+$" },
    ]);

    // policy computed from what actually ran: read-only walk → unattended ok
    expect(artifact.policy).toEqual({
      requiredOrigins: [BASE],
      allowedActionKinds: ["navigate", "fill", "click", "extract"],
      riskLevel: "readonly",
      unattendedReplay: true,
    });

    // fingerprint from the common title prefix; provenance starts as draft
    expect(artifact.target.appFingerprint!.titlePattern).toContain("CU BackOffice");
    expect(artifact.provenance.reviewStatus).toBe("draft");
    expect(artifact.provenance.provider).toBe("scripted");
  });

  it("omits examples for sensitive inputs and marks mutating walks as attended-only", () => {
    const r = makeRecorder({
      capabilityId: "ssn-update",
      inputs: { ssn: "123-45-6789" },
      sensitiveInputs: ["ssn"],
    });
    r.record({ ...walk[0]! });
    r.record({
      kind: "fill",
      intent: "Enter the SSN",
      risk: "risky",
      value: "123-45-6789",
      synthesis: synth([{ kind: "labelText", value: "SSN" }], "SSN input"),
      urlBefore: `${BASE}/login`,
      urlAfter: `${BASE}/login`,
    });

    const artifact = CapabilityArtifactSchema.parse(r.distill());
    expect(artifact.inputs[0]).toMatchObject({ name: "ssn", sensitive: true });
    expect(artifact.inputs[0]!.example).toBeUndefined();
    expect(artifact.inputs[0]!.pattern).toBeUndefined(); // dashes → no digit pattern
    expect(artifact.steps[1]!.value).toBe("{{inputs.ssn}}");
    expect(artifact.policy.riskLevel).toBe("mutating");
    expect(artifact.policy.unattendedReplay).toBe(false);
  });
});
