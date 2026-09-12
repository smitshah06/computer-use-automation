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
  type EscalationGateway,
  type PolicyConfig,
} from "../../src/core";
import { makeFixtureArtifact, type FixtureOptions } from "../fixtures/artifact-fixture";

const PORT = 4611;
const BASE = `http://localhost:${PORT}`;
const SECRETS = { tellerUsername: "teller1", tellerPassword: "Demo!Pass1" };

let server: Server;
let config: PolicyConfig;
let evidenceBase: string;
let runSeq = 0;

beforeAll(() => {
  server = createTargetApp().listen(PORT);
  const loaded = loadPolicyConfig("policy.yaml");
  config = { ...loaded, allowlist: { ...loaded.allowlist, origins: [BASE] } };
  evidenceBase = mkdtempSync(join(tmpdir(), "scribe-replay-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeEngine(
  fixtureOpts: FixtureOptions = {},
  engineOpts: { gateway?: EscalationGateway; mutate?: (raw: any) => void } = {},
) {
  const raw = makeFixtureArtifact({ baseUrl: BASE, ...fixtureOpts });
  engineOpts.mutate?.(raw);
  const artifact = CapabilityArtifactSchema.parse(raw);
  const policy = new PolicyEngine(config);
  policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
  runSeq += 1;
  const logger = new RunLogger(`replay_itest_${runSeq}`, new Redactor(), evidenceBase);
  const driver = new PlaywrightDriver(policy, logger);
  const engine = new ReplayEngine(artifact, config, driver, logger, {
    secrets: SECRETS,
    gateway: engineOpts.gateway,
  });
  return { engine, logger };
}

async function arm(fault: string) {
  const res = await fetch(`${BASE}/__faults?arm=${fault}`);
  expect(res.ok).toBe(true);
}

describe("ReplayEngine against the mock CU back-office (no LLM anywhere)", () => {
  it("replays the happy path: success, outputs, and locator-drift telemetry", async () => {
    const { engine, logger } = makeEngine();
    const result = await engine.run({ memberId: "12345" });

    expect(result.result.status).toBe("success");
    if (result.result.status === "success") {
      expect(result.result.outputs.savingsBalance).toBe("$1,204.55");
    }
    expect(result.telemetry).toHaveLength(9);
    const s2 = result.telemetry.find((t) => t.stepId === "s2")!;
    expect(s2).toMatchObject({ strategyRank: 0, strategyKind: "role" });
    const s6 = result.telemetry.find((t) => t.stepId === "s6")!;
    expect(s6).toMatchObject({ strategyRank: 2, strategyKind: "nearText" });

    // evidence is written and fully redacted; the caller still gets the value
    const resultJson = JSON.parse(readFileSync(join(logger.runDir, "result.json"), "utf8"));
    expect(resultJson.result.outputs.savingsBalance).toBe("***");
    const jsonl = readFileSync(join(logger.runDir, "run.jsonl"), "utf8");
    expect(jsonl).not.toContain("Demo!Pass1");
    expect(jsonl).not.toContain("$1,204.55");
  }, 60_000);

  it("returns a declared business outcome for an unknown member — an answer, not an error", async () => {
    const { engine } = makeEngine();
    const result = await engine.run({ memberId: "99999" });
    expect(result.result.status).toBe("business_outcome");
    if (result.result.status === "business_outcome") {
      expect(result.result.code).toBe("MEMBER_NOT_FOUND");
    }
  }, 60_000);

  it("dismisses a declared interstitial via recovery and still succeeds", async () => {
    await arm("interstitial");
    const { engine } = makeEngine();
    const result = await engine.run({ memberId: "12345" });
    expect(result.result.status).toBe("success");
    const applied = result.telemetry.flatMap((t) => t.recoveriesApplied);
    expect(applied).toContain("maintenance-interstitial");
  }, 60_000);

  it("absorbs a slow legacy load via bounded waitRetry recovery (checkpoint-first, no re-click)", async () => {
    await arm("slow");
    const { engine } = makeEngine();
    const result = await engine.run({ memberId: "12345" });
    expect(result.result.status).toBe("success");
    const s4 = result.telemetry.find((t) => t.stepId === "s4")!;
    expect(s4.recoveriesApplied).toContain("transient-slow-load");
    expect(s4.attempts).toBe(1); // recovered by waiting, not by re-submitting
  }, 60_000);

  it("re-authenticates through a declared runSteps recovery after session expiry", async () => {
    await arm("session-expiry");
    const { engine } = makeEngine({ sessionRecovery: true });
    const result = await engine.run({ memberId: "12345" });
    expect(result.result.status).toBe("success");
    const applied = result.telemetry.flatMap((t) => t.recoveriesApplied);
    expect(applied).toContain("session-expiry-reauth");
  }, 60_000);

  it("hard-fails with a structured, evidence-backed error when no recovery is declared", async () => {
    await arm("session-expiry");
    const { engine } = makeEngine(); // fixture default: no session recovery
    const result = await engine.run({ memberId: "12345" });
    expect(result.result.status).toBe("hard_failure");
    if (result.result.status === "hard_failure") {
      const err = result.result.error;
      expect(err.stepId).toBe("s4");
      expect(err.expected).toContain("urlMatches");
      expect(err.observed).toContain("expired=1");
      expect(err.evidence.length).toBeGreaterThanOrEqual(2); // screenshot + observation dump
    }
  }, 60_000);

  it("pauses a risky draft-artifact action for approval and proceeds on approve_once", async () => {
    const granted: string[] = [];
    const gateway: EscalationGateway = {
      requestIntervention: async (req) => {
        granted.push(req.reason);
        return { disposition: "approve_once", operator: "itest-operator" };
      },
    };
    const { engine } = makeEngine(
      { reviewStatus: "draft" },
      { gateway, mutate: (raw) => (raw.steps[3].risk = "risky") },
    );
    const result = await engine.run({ memberId: "12345" });
    expect(result.result.status).toBe("escalated");
    if (result.result.status === "escalated") {
      expect(result.result.finalStatus).toBe("success");
      expect(result.result.outputs?.savingsBalance).toBe("$1,204.55");
      expect(result.result.interventions[0]).toMatchObject({
        type: "approval",
        disposition: "approve_once",
        operator: "itest-operator",
      });
    }
    expect(granted[0]).toMatch(/draft/);
  }, 60_000);

  it("marks the run aborted when the operator denies a risky action", async () => {
    const gateway: EscalationGateway = {
      requestIntervention: async () => ({ disposition: "abort", operator: "itest-operator" }),
    };
    const { engine } = makeEngine(
      { reviewStatus: "draft" },
      { gateway, mutate: (raw) => (raw.steps[3].risk = "risky") },
    );
    const result = await engine.run({ memberId: "12345" });
    expect(result.result.status).toBe("escalated");
    if (result.result.status === "escalated") {
      expect(result.result.finalStatus).toBe("aborted");
      expect(result.result.error).toBeDefined();
    }
  }, 60_000);

  it("rejects bad inputs against the contract before ever launching a browser", async () => {
    const { engine: e1 } = makeEngine();
    const r1 = await e1.run({});
    expect(r1.result.status).toBe("hard_failure");
    if (r1.result.status === "hard_failure") {
      expect(r1.result.error.observed).toContain('missing required input "memberId"');
    }

    const { engine: e2 } = makeEngine();
    const r2 = await e2.run({ memberId: "12345", bogus: "x" });
    expect(r2.result.status).toBe("hard_failure");
    if (r2.result.status === "hard_failure") {
      expect(r2.result.error.observed).toContain('unknown input "bogus"');
    }

    const { engine: e3 } = makeEngine();
    const r3 = await e3.run({ memberId: "12ab5" });
    expect(r3.result.status).toBe("hard_failure");
    if (r3.result.status === "hard_failure") {
      expect(r3.result.error.observed).toContain("does not match");
    }
  }, 60_000);
});
