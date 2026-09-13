import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createTargetApp } from "../../src/target-app/server";
import { PlaywrightDriver } from "../../src/surface/playwright-driver";
import { PolicyEngine, loadPolicyConfig } from "../../src/policy/engine";
import { Redactor } from "../../src/evidence/redactor";
import { RunLogger } from "../../src/evidence/run-logger";
import { ReplayEngine } from "../../src/replay/executor";
import {
  CapabilityArtifactSchema,
  TenantBindingSchema,
  applyTenantBinding,
  type CapabilityArtifact,
  type PolicyConfig,
} from "../../src/core";

// Tenant B: the SAME vendor product deployed at "CU North" — green skin,
// tw_* ids, member->customer vocabulary — served on its own port. The suite
// replays the artifact RECORDED ON TENANT A (capabilities/, committed) through
// the committed overlay (tenants/cu-north.json). No re-recording, no LLM.
const PORT = 4650;
const BASE = `http://localhost:${PORT}`;
const SECRETS = { tellerUsername: "teller1", tellerPassword: "Demo!Pass1" };

let server: Server;
let config: PolicyConfig;
let evidenceBase: string;
let runSeq = 0;

beforeAll(() => {
  server = createTargetApp("cu-north").listen(PORT);
  const loaded = loadPolicyConfig("policy.yaml");
  config = { ...loaded, allowlist: { ...loaded.allowlist, origins: [BASE] } };
  evidenceBase = mkdtempSync(join(tmpdir(), "scribe-tenant-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const recordedArtifact = (): CapabilityArtifact =>
  CapabilityArtifactSchema.parse(
    JSON.parse(readFileSync("capabilities/member-savings-lookup.json", "utf8")),
  );
const northBinding = () =>
  TenantBindingSchema.parse(JSON.parse(readFileSync("tenants/cu-north.json", "utf8")));

function makeEngine(artifact: CapabilityArtifact) {
  const policy = new PolicyEngine(config);
  policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
  runSeq += 1;
  const logger = new RunLogger(`tenant_itest_${runSeq}`, new Redactor(), evidenceBase);
  const driver = new PlaywrightDriver(policy, logger);
  return new ReplayEngine(artifact, config, driver, logger, {
    secrets: SECRETS,
    env: { APP_BASE_URL: BASE },
  });
}

describe("Multi-tenant reuse: recorded-on-A artifact replayed on tenant B via overlay", () => {
  it("succeeds end to end on CU North with the committed binding — semantic strategies only", async () => {
    const bound = applyTenantBinding(recordedArtifact(), northBinding());
    const result = await makeEngine(bound).run({ memberId: "12345" });

    expect(result.result.status).toBe("success");
    if (result.result.status === "success") {
      expect(result.result.outputs.savingsBalance).toBe("$1,204.55"); // same seed, same answer
    }

    // The thesis: role/label/text strategies carried the whole run. Tenant A's
    // css ranks (ctl00_*) exist in the merged artifact but never had to match
    // tenant B's tw_* markup.
    const used = result.telemetry.filter((t) => t.strategyRank !== null);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((t) => t.strategyKind !== "css")).toBe(true);
  }, 90_000);

  it("classifies declared business outcomes cross-tenant (tenant-B wording)", async () => {
    const bound = applyTenantBinding(recordedArtifact(), northBinding());
    const result = await makeEngine(bound).run({ memberId: "99999" });
    expect(result.result.status).toBe("business_outcome");
    if (result.result.status === "business_outcome") {
      expect(result.result.code).toBe("MEMBER_NOT_FOUND");
    }
  }, 90_000);

  it("without the overlay the tenant-A artifact fails closed on tenant B (origin pin)", async () => {
    // requiredOrigins still pins localhost:4600, so acting on 4650 is denied at
    // the policy chokepoint — the artifact cannot silently run against a
    // deployment it was never bound to.
    const result = await makeEngine(recordedArtifact()).run({ memberId: "12345" });
    expect(result.result.status).toBe("hard_failure");
    if (result.result.status === "hard_failure") {
      // Denied at the entry navigation, before any step runs.
      expect(result.result.error.stepId).toBeUndefined();
      expect(result.result.error.expected).toContain("navigate to entrypoint");
    }
  }, 90_000);
});
