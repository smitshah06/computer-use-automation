import { describe, it, expect } from "vitest";
import { PolicyEngine, loadPolicyConfig } from "../../src/policy/engine";
import { Redactor } from "../../src/evidence/redactor";
import type { ActionRequest } from "../../src/core";
import { makeFixtureArtifact } from "../fixtures/artifact-fixture";
import { CapabilityArtifactSchema } from "../../src/core";

const config = loadPolicyConfig("policy.yaml");
const IN = "http://localhost:4600/members";
const OUT = "https://evil.example.com/page";

function req(partial: Partial<ActionRequest>): ActionRequest {
  return { kind: "click", risk: "safe", phase: "replay", ...partial };
}

describe("policy engine (deny by default)", () => {
  it("allows allowlisted safe actions", () => {
    const p = new PolicyEngine(config);
    expect(p.checkAction(req({}), IN)).toEqual({ decision: "allow" });
  });

  it("denies actions on non-allowlisted origins", () => {
    const p = new PolicyEngine(config);
    expect(p.checkAction(req({}), OUT).decision).toBe("deny");
    expect(p.checkAction(req({ kind: "navigate", url: OUT }), IN).decision).toBe("deny");
  });

  it("denies action kinds outside the global allowlist", () => {
    const p = new PolicyEngine({ ...config, actionKinds: ["navigate"] });
    expect(p.checkAction(req({ kind: "click" }), IN).decision).toBe("deny");
  });

  it("denies kinds the artifact policy does not declare", () => {
    const p = new PolicyEngine(config);
    const a = CapabilityArtifactSchema.parse(makeFixtureArtifact());
    p.bindArtifact(a.policy, a.provenance.reviewStatus); // allows navigate/click/fill/extract
    expect(p.checkAction(req({ kind: "press" }), IN).decision).toBe("deny");
  });

  it("requires confirmation for risky actions during discovery", () => {
    const p = new PolicyEngine(config);
    expect(p.checkAction(req({ risk: "risky", phase: "discovery" }), IN).decision).toBe("require_approval");
  });

  it("requires approval for risky replay of a draft artifact, allows for approved+unattended", () => {
    const p = new PolicyEngine(config);
    const draft = CapabilityArtifactSchema.parse(makeFixtureArtifact({ reviewStatus: "draft" }));
    p.bindArtifact(draft.policy, draft.provenance.reviewStatus);
    expect(p.checkAction(req({ risk: "risky" }), IN).decision).toBe("require_approval");

    const approved = CapabilityArtifactSchema.parse(makeFixtureArtifact({ reviewStatus: "approved", unattendedReplay: true }));
    p.bindArtifact(approved.policy, approved.provenance.reviewStatus);
    expect(p.checkAction(req({ risk: "risky" }), IN).decision).toBe("allow");
  });

  it("requires approval when the capability forbids unattended risky replay", () => {
    const p = new PolicyEngine(config);
    const a = CapabilityArtifactSchema.parse(makeFixtureArtifact({ reviewStatus: "approved", unattendedReplay: false }));
    p.bindArtifact(a.policy, a.provenance.reviewStatus);
    expect(p.checkAction(req({ risk: "risky" }), IN).decision).toBe("require_approval");
  });
});

describe("redactor", () => {
  it("masks registered secrets everywhere, recursively", () => {
    const r = new Redactor("***");
    r.register("Demo!Pass1");
    r.register("$1,204.55");
    const masked = r.maskDeep({
      msg: "filled Demo!Pass1 into Passcode",
      nested: { balances: ["$1,204.55", "$9.99"] },
    });
    expect(masked.msg).toBe("filled *** into Passcode");
    expect(masked.nested.balances).toEqual(["***", "$9.99"]);
  });

  it("ignores short values that would over-mask", () => {
    const r = new Redactor();
    r.register("ok");
    expect(r.mask("ok this stays")).toBe("ok this stays");
  });
});
