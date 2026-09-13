import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CapabilityArtifactSchema,
  TenantBindingSchema,
  applyTenantBinding,
  type CapabilityArtifact,
  type TenantBinding,
} from "../../src/core";
import { makeFixtureArtifact } from "../fixtures/artifact-fixture";

// The committed binding is itself under test: if someone edits tenants/
// cu-north.json into an invalid shape, this suite fails.
const NORTH = TenantBindingSchema.parse(JSON.parse(readFileSync("tenants/cu-north.json", "utf8")));
const fixture = (): CapabilityArtifact => CapabilityArtifactSchema.parse(makeFixtureArtifact());

const strat = (a: CapabilityArtifact, stepId: string) =>
  a.steps.find((s) => s.id === stepId)!.target!.strategies;

describe("TenantBinding overlay merge", () => {
  it("applies the committed cu-north binding: vocabulary, fingerprint, origins — mechanics untouched", () => {
    const base = fixture();
    const merged = applyTenantBinding(base, NORTH);

    // Semantic strategies are remapped; the css rank survives verbatim as the
    // per-tenant-patchable last resort it is documented to be.
    expect(strat(merged, "s2")).toEqual([
      { kind: "role", role: "textbox", name: "Operator ID" },
      { kind: "labelText", value: "Operator ID" },
      { kind: "nearText", value: "Operator ID" },
      { kind: "css", value: "#ctl00_LoginCtl_txtUser" },
    ]);
    expect(strat(merged, "s7")[0]).toEqual({ kind: "role", role: "button", name: "Find" });

    // Conditions: textPresent is vocabulary-mapped, urlMatches never is.
    expect(merged.steps[0]!.checkpoint).toEqual({
      all: [{ urlMatches: "/login" }, { textPresent: "Operator Log On" }],
    });
    const s6 = merged.steps.find((s) => s.id === "s6")!;
    expect(s6.waitBefore!.condition).toEqual({ textPresent: "Customer Number" });
    expect(s6.value).toBe("{{inputs.memberId}}"); // values are plumbing, not vocabulary

    // Template placeholders in strategies are left alone.
    expect(strat(merged, "s8")[0]).toEqual({ kind: "nearText", value: "{{inputs.memberId}}" });

    // Outcome detectors follow the tenant's wording; unmapped text stays put.
    expect(merged.outcomes[0]!.detector).toEqual({
      all: [{ textPresent: "No matching customers on file" }],
    });
    expect(merged.outcomes[1]!.detector).toEqual({ textPresent: "You do not have permission" });
    expect(merged.recoveries[0]!.detector).toEqual({
      elementVisible: { kind: "role", role: "dialog", name: "System Notice" },
    });
    expect(merged.successCheckpoint).toEqual({
      all: [{ urlMatches: "/members/\\d+" }, { textPresent: "Accounts" }],
    });

    // Wholesale replacements from the binding.
    expect(merged.target.appFingerprint).toEqual({
      titlePattern: "CU North TellerWorks",
      markers: ["Operator Log On"],
    });
    expect(merged.policy.requiredOrigins).toEqual(["http://localhost:4650"]);
    // No entrypoint in the binding -> the artifact's own survives.
    expect(merged.target.entrypoint).toBe("http://localhost:4600/login");

    // Exact-match semantics: a description merely CONTAINING a vocab key is
    // not rewritten (no substring cascades).
    const s5 = merged.steps.find((s) => s.id === "s5")!;
    expect(s5.target!.elementDescription).toBe("Member Search link in the desk navigation");
  });

  it("maps elementDescription only on exact equality and replaces entrypoint when given", () => {
    const binding = TenantBindingSchema.parse({
      schemaVersion: "1.0",
      tenantId: "desc-test",
      appId: "cu-backoffice",
      entrypoint: "{{env.APP_BASE_URL}}/login",
      vocabulary: { "Sign In button": "Log On button", "Sign In": "Log On" },
    });
    const merged = applyTenantBinding(fixture(), binding);
    const s4 = merged.steps.find((s) => s.id === "s4")!;
    expect(s4.target!.elementDescription).toBe("Log On button"); // exact match -> mapped
    expect(s4.target!.strategies[0]).toEqual({ kind: "role", role: "button", name: "Log On" });
    expect(s4.checkpoint).toEqual({ all: [{ urlMatches: "/desk" }, { textPresent: "Teller Desk" }] }); // not in vocab
    expect(merged.target.entrypoint).toBe("{{env.APP_BASE_URL}}/login");
  });

  it("does not mutate the source artifact", () => {
    const base = fixture();
    applyTenantBinding(base, NORTH);
    expect(strat(base, "s2")[0]).toEqual({ kind: "role", role: "textbox", name: "Teller ID" });
    expect(base.policy.requiredOrigins).toEqual(["http://localhost:4600"]);
    expect(base.target.appFingerprint.titlePattern).toBe("CU BackOffice");
  });

  it("stepOverrides replace the ranked list verbatim, exempt from vocabulary", () => {
    const binding = TenantBindingSchema.parse({
      ...JSON.parse(readFileSync("tenants/cu-north.json", "utf8")),
      stepOverrides: {
        s6: {
          strategies: [
            { kind: "nearText", value: "Member Number" }, // a vocab key — must survive as-is
            { kind: "css", value: "#tw_CustFind_fldNo" },
          ],
        },
      },
    });
    const merged = applyTenantBinding(fixture(), binding);
    expect(strat(merged, "s6")).toEqual([
      { kind: "nearText", value: "Member Number" },
      { kind: "css", value: "#tw_CustFind_fldNo" },
    ]);
    // description still themed, other steps still vocabulary-mapped
    expect(strat(merged, "s7")[0]).toEqual({ kind: "role", role: "button", name: "Find" });
  });

  it("fails closed on an appId mismatch and on overrides for unknown steps", () => {
    expect(() =>
      applyTenantBinding(fixture(), { ...NORTH, appId: "some-other-product" }),
    ).toThrow(/refusing to merge/);
    expect(() =>
      applyTenantBinding(fixture(), {
        ...NORTH,
        stepOverrides: { s99: { strategies: [{ kind: "css", value: "#x" }] } },
      }),
    ).toThrow(/unknown step "s99"/);
  });

  it("re-validates the merged artifact through the strict schema — a corrupt overlay cannot pass", () => {
    // Bypass binding-level validation to prove the FINAL gate holds on its own.
    const corrupt = {
      ...NORTH,
      stepOverrides: { s6: { strategies: [] } },
    } as unknown as TenantBinding;
    expect(() => applyTenantBinding(fixture(), corrupt)).toThrow(); // ZodError: min(1) strategies
  });

  it("binding schema is strict: unknown keys, bad origins, bad tenant ids are rejected", () => {
    const ok = JSON.parse(readFileSync("tenants/cu-north.json", "utf8"));
    expect(() => TenantBindingSchema.parse({ ...ok, surprise: true })).toThrow();
    expect(() => TenantBindingSchema.parse({ ...ok, requiredOrigins: ["not a url"] })).toThrow();
    expect(() => TenantBindingSchema.parse({ ...ok, tenantId: "CU North" })).toThrow();
    expect(() => TenantBindingSchema.parse({ ...ok, requiredOrigins: [] })).toThrow();
  });
});
