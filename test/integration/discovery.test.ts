import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createTargetApp } from "../../src/target-app/server";
import { PlaywrightDriver } from "../../src/surface/playwright-driver";
import { PolicyEngine, loadPolicyConfig } from "../../src/policy/engine";
import { Redactor } from "../../src/evidence/redactor";
import { RunLogger } from "../../src/evidence/run-logger";
import { ReplayEngine } from "../../src/replay/executor";
import { DiscoveryEngine, type DiscoverySpec } from "../../src/agent";
import { ScriptedProvider, refOf, type ScriptFn } from "../fixtures/scripted-provider";
import type { PolicyConfig } from "../../src/core";

const PORT = 4613;
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
  evidenceBase = mkdtempSync(join(tmpdir(), "scribe-discovery-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeDiscovery(script: ScriptFn[], spec: Partial<DiscoverySpec> = {}) {
  runSeq += 1;
  const logger = new RunLogger(`disc_itest_${runSeq}`, new Redactor(), evidenceBase);
  const driver = new PlaywrightDriver(new PolicyEngine(config), logger);
  const engine = new DiscoveryEngine(
    new ScriptedProvider(script),
    config,
    driver,
    logger,
    {
      goal: "Look up the member by member number and read their savings account balance",
      entryUrl: `${BASE}/login`,
      capabilityId: "member-savings-lookup",
      capabilityName: "Member savings balance lookup",
      appId: "cu-backoffice",
      inputs: { memberId: "12345" },
      env: { APP_BASE_URL: BASE },
      ...spec,
    },
    { secrets: SECRETS, maxTurns: 12 },
  );
  return { engine, logger };
}

const act = (input: Record<string, unknown>): { toolName: string; toolInput: unknown } => ({
  toolName: "act",
  toolInput: { risk: "safe", reasoning: "scripted walk", ...input },
});

// The shared sign-in + navigate-to-search prefix of both scripted walks.
const loginAndSearch = (memberId: string): ScriptFn[] => [
  (obs) => act({ kind: "fill", ref: refOf(obs, /textbox "Teller ID"/), value: "{{secrets.tellerUsername}}", intent: "Enter the teller username" }),
  (obs) => act({ kind: "fill", ref: refOf(obs, /textbox "Passcode"/), value: "{{secrets.tellerPassword}}", intent: "Enter the teller passcode" }),
  (obs) => act({ kind: "click", ref: refOf(obs, /button "Sign In"/), intent: "Submit the sign-in form" }),
  (obs) => act({ kind: "click", ref: refOf(obs, /link "Member Search"/), intent: "Open the member search screen" }),
  (obs) => act({ kind: "fill", ref: refOf(obs, /textbox ""/), value: memberId, intent: "Enter the member number" }),
  (obs) => act({ kind: "click", ref: refOf(obs, /button "Search"/), intent: "Run the member search" }),
];

describe("DiscoveryEngine with a scripted provider against the mock CU back-office", () => {
  it("records a clean walk into a valid artifact that then replays with no LLM", async () => {
    const script: ScriptFn[] = [
      ...loginAndSearch("12345"),
      (obs) => act({ kind: "click", ref: refOf(obs, /link "Alvarez, Maria"/), intent: "Open the matching member profile" }),
      (obs) => ({
        toolName: "extract",
        toolInput: {
          ref: refOf(obs, /text "\$1,204\.55"/),
          outputName: "savingsBalance",
          type: "money",
          sensitive: true,
          extractPattern: "\\$[\\d,]+\\.\\d{2}",
          intent: "Read the savings balance",
          reasoning: "the goal asks for the savings balance",
        },
      }),
      () => ({
        toolName: "finish",
        toolInput: { status: "success", summary: "Balance extracted", reasoning: "goal accomplished" },
      }),
    ];
    const { engine, logger } = makeDiscovery(script);
    const out = await engine.run();

    expect(out.status).toBe("recorded");
    expect(out.turns).toBe(9);
    const artifact = out.artifact!;

    // distilled mechanics: entry + 8 recorded actions, parameterized
    expect(artifact.steps).toHaveLength(9);
    expect(artifact.steps[0]).toMatchObject({ action: "navigate", url: "{{env.APP_BASE_URL}}/login" });
    expect(artifact.steps[1]).toMatchObject({ value: "{{secrets.tellerUsername}}", sensitive: true });
    expect(artifact.steps[3]!.checkpoint).toEqual({ urlMatches: "/desk" });
    expect(artifact.steps[5]).toMatchObject({ action: "fill", value: "{{inputs.memberId}}" });
    expect(artifact.steps[7]!.checkpoint).toEqual({ urlMatches: "/members/{{inputs.memberId}}" });
    expect(artifact.outputs).toEqual([
      { name: "savingsBalance", type: "money", sensitive: true, sourceStep: "s9" },
    ]);
    expect(artifact.policy).toMatchObject({
      requiredOrigins: [BASE],
      riskLevel: "readonly",
      unattendedReplay: true,
    });
    expect(artifact.provenance).toMatchObject({ provider: "scripted", reviewStatus: "draft" });

    // secret hygiene: raw credentials and the sensitive extract never persist
    const artifactJson = readFileSync(join(logger.runDir, "artifact.json"), "utf8");
    expect(artifactJson).toContain("{{secrets.tellerUsername}}");
    expect(artifactJson).not.toContain("Demo!Pass1");
    expect(artifactJson).not.toContain("teller1");
    const jsonl = readFileSync(join(logger.runDir, "run.jsonl"), "utf8");
    expect(jsonl).not.toContain("Demo!Pass1");
    expect(jsonl).not.toContain("$1,204.55");

    // the recorded artifact is a working capability: replay it, no LLM anywhere
    const policy = new PolicyEngine(config);
    policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
    runSeq += 1;
    const replayLogger = new RunLogger(`disc_replay_${runSeq}`, new Redactor(), evidenceBase);
    const replay = new ReplayEngine(artifact, config, new PlaywrightDriver(policy, replayLogger), replayLogger, {
      secrets: SECRETS,
      env: { APP_BASE_URL: BASE },
    });
    const result = await replay.run({ memberId: "12345" });
    expect(result.result.status).toBe("success");
    if (result.result.status === "success") {
      expect(result.result.outputs.savingsBalance).toBe("$1,204.55");
    }
    expect(result.telemetry).toHaveLength(9);
  }, 90_000);

  it("terminates as a declared business outcome when the app answers 'No records found'", async () => {
    const script: ScriptFn[] = [
      ...loginAndSearch("99999"),
      () => ({
        toolName: "declare_outcome",
        toolInput: {
          code: "MEMBER_NOT_FOUND",
          description: "No member exists with the supplied member number.",
          detectorText: "No records found",
          reasoning: "the application shows a legitimate empty result",
        },
      }),
    ];
    const { engine } = makeDiscovery(script, { inputs: { memberId: "99999" } });
    const out = await engine.run();

    expect(out.status).toBe("business_outcome");
    expect(out.turns).toBe(7);
    expect(out.artifact).toBeUndefined();
    expect(out.outcome).toEqual({
      code: "MEMBER_NOT_FOUND",
      terminal: true,
      description: "No member exists with the supplied member number.",
      detector: { textPresent: "No records found" },
    });
  }, 90_000);

  it("detects an action loop and terminates stuck with failure evidence", async () => {
    const nav: ScriptFn = () =>
      act({ kind: "navigate", url: `${BASE}/login`, intent: "Open the sign-in page" });
    const { engine, logger } = makeDiscovery([nav, nav, nav, nav]);
    const out = await engine.run();

    expect(out.status).toBe("stuck");
    expect(out.summary).toMatch(/4 times/);
    expect(existsSync(join(logger.runDir, "failure_discovery.json"))).toBe(true);
    const jsonl = readFileSync(join(logger.runDir, "run.jsonl"), "utf8");
    expect(jsonl).toContain("discovery_stuck");
  }, 90_000);
});
